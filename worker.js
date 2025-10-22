// worker.js
require('dotenv').config();
require('./lib/db');

const { Telegram } = require('telegraf');
const Call = require('./model/call.model');
const { getTokenInfo, usd } = require('./lib/price');
const { tradeKeyboards } = require('./card');

const tg = new Telegram(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);

/* ───────────────────────── Config ───────────────────────── */
const CHECK_MIN  = Number(process.env.CHECK_INTERVAL_MINUTES || 1);
const BASE_DAYS  = Number(process.env.BASE_TRACK_DAYS || 7);

// Low-tier milestones (<10×) to avoid spam
const MILESTONES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 1 && n < 10)
  .sort((a, b) => a - b);

// High-tier sweep (>=10×)
const HIGH_START = Number(process.env.HIGH_START || 10);   // first high tier
const HIGH_STEP  = Number(process.env.HIGH_STEP  || 10);   // 10=decades; 1=every x
const HIGH_MAX   = Number(process.env.HIGH_MAX   || 5000); // cap

// Tolerance so we don't miss by a hair (1%)
const EPS = 0.01;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = () => new Date();

/* ───────────────────────── utils ───────────────────────── */
function hoursBetween(a, b) {
  return Math.max(0, (b - a) / 36e5);
}
function formatDuration(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}h:${String(mm).padStart(2, '0')}m`;
}
const chainUpper = (c) => (c ? String(c).toUpperCase() : c);

function collectLowTierHits(xNow, already) {
  const hits = [];
  for (const m of MILESTONES) {
    if (already.includes(m)) continue;
    if (xNow >= m * (1 - EPS)) hits.push(m);
  }
  return hits;
}
function collectHighTierHits(xNow, already) {
  const hits = [];
  const upto = Math.min(HIGH_MAX, Math.floor(xNow + EPS));
  for (let m = HIGH_START; m <= upto; m += HIGH_STEP) {
    if (!already.includes(m)) hits.push(m);
  }
  return hits;
}

/* ───────────────────────── Alert text ───────────────────────── */
function rocketAlert({ tkr, ca, xNow, entryMc, nowMc, byUser }) {
  const rockets = '🚀'.repeat(Math.min(12, Math.max(4, Math.round(xNow * 2))));
  const tag = tkr ? `$${tkr}` : ca.slice(0, 4) + '…' + ca.slice(-4);
  return (
    `${rockets} ${tag} hit ${xNow.toFixed(2)}× since call!\n\n` +
    `📞 Called at MC: ${usd(entryMc)}${byUser ? ` by @${byUser}` : ''}\n` +
    `🏆 Now MC: ${usd(nowMc)}`
  );
}
function moonAlert({ tkr, entryMc, nowMc, xNow, hours }) {
  const tag = tkr ? `$${tkr}` : 'Token';
  return (
    `🌕 ${tag} ${xNow.toFixed(2)}x | ` +
    `💹From ${usd(entryMc).replace('$', '')} ↗️ ${usd(nowMc).replace('$', '')} ` +
    `within ${formatDuration(hours)}`
  );
}

/* ───────────────────────── Core check ───────────────────────── */
async function checkOne(c) {
  let info;
  try {
    info = await getTokenInfo(c.ca);
  } catch (e) {
    console.warn(`⚠️ price fetch failed for ${c.ca}: ${e.message}`);
    return;
  }
  if (!info || !info.mc || !c.entryMc || c.entryMc <= 0) return;

  const nowMc = info.mc;
  const xNow = nowMc / c.entryMc;

  // accumulate hits
  const already = Array.isArray(c.multipliersHit) ? [...c.multipliersHit] : [];
  const lowHits  = collectLowTierHits(xNow, already);
  const highHits = collectHighTierHits(xNow, already);
  const toFire   = [...lowHits, ...highHits].sort((a, b) => a - b);

  // send alerts in order
  for (const m of toFire) {
    try {
      const kb = tradeKeyboards(chainUpper(c.chain), info.chartUrl);

      if (m >= 10) {
        const msg = moonAlert({
          tkr: c.ticker,
          entryMc: c.entryMc,
          nowMc,
          xNow,
          hours: hoursBetween(c.createdAt, NOW()),
        });
        await tg.sendMessage(CH_ID, msg, { parse_mode: 'HTML', ...kb });
      } else {
        const msg = rocketAlert({
          tkr: c.ticker,
          ca: c.ca,
          xNow,
          entryMc: c.entryMc,
          nowMc,
          byUser: c.caller?.username || c.caller?.tgId,
        });
        await tg.sendMessage(CH_ID, msg, { parse_mode: 'HTML', ...kb });
      }

      already.push(m);
      await sleep(200); // gentle rate limit
    } catch (e) {
      console.error('❌ milestone post failed:', e?.response?.description || e.message);
    }
  }

  // persist metrics & hits
  const update = {
    $set: {
      lastMc: nowMc,
      peakMc: Math.max(c.peakMc || 0, nowMc),
      multipliersHit: [...new Set(already)].sort((a, b) => a - b),
    },
  };

  // Use updateOne without validators to avoid enum errors from legacy records (e.g., 'sol')
  try {
    await Call.updateOne({ _id: c._id }, update, { runValidators: false }).lean();
  } catch (e) {
    console.error('❌ save failed:', e.message);
  }
}

async function runOnce() {
  const since = new Date(Date.now() - BASE_DAYS * 24 * 3600 * 1000);
  const calls = await Call.find(
    { createdAt: { $gte: since }, entryMc: { $gt: 0 } },
    // project only what we need to reduce memory
    { ca: 1, entryMc: 1, peakMc: 1, createdAt: 1, multipliersHit: 1, chain: 1, ticker: 1, caller: 1 }
  ).limit(1000);

  if (!calls.length) return;
  console.log(`🔎 Checking ${calls.length} calls…`);

  for (const c of calls) {
    try { await checkOne(c); } catch (e) { console.error('checkOne error:', e.message); }
    await sleep(200);
  }
}

/* ───────────────────────── Loop ───────────────────────── */
(async function main() {
  console.log(`📡 Worker running, every ${CHECK_MIN}m`);
  for (;;) {
    const started = Date.now();
    try { await runOnce(); } catch (e) { console.error('runOnce crash:', e.message); }
    const spent = Date.now() - started;
    const wait  = Math.max(1000, CHECK_MIN * 60_000 - spent);
    await sleep(wait);
  }
})();
