// worker.js
require('dotenv').config();
require('./lib/db');

const { Telegram } = require('telegraf');
const Call = require('./model/call.model');
const { getTokenInfo, usd } = require('./lib/price');
const { tradeKeyboards } = require('./card');

const tg = new Telegram(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);

// ---- Config ---------------------------------------------------------------
const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 1);
const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);

// Low-tier milestones (<10×)
const MILESTONES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 1 && n < 10)
  .sort((a, b) => a - b);

// High-tier sweep (>=10×)
const HIGH_START = Number(process.env.HIGH_START || 10);      // e.g. 10
const HIGH_STEP  = Number(process.env.HIGH_STEP  || 10);      // 10 → 10x,20x,30x… | 1 → 10x,11x…
const HIGH_MAX   = Number(process.env.HIGH_MAX   || 5000);    // cap

const EPS = 0.01; // small tolerance

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = () => new Date();

// ---- helpers --------------------------------------------------------------
function hoursBetween(a, b) {
  return Math.max(0, (b - a) / 36e5);
}
function formatHours(h) {
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h >= 1)  return `${Math.round(h)} hours`;
  return `${Math.round(h * 60)} mins`;
}

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

function dsChartUrl(chain, caOrMint) {
  const c = String(chain || '').toUpperCase();
  if (c === 'SOL') return `https://dexscreener.com/solana/${encodeURIComponent(caOrMint)}`;
  if (c === 'BSC') return `https://dexscreener.com/bsc/${encodeURIComponent(caOrMint)}`;
  return 'https://dexscreener.com';
}

function shortenCa(ca) {
  if (!ca || typeof ca !== 'string') return 'Token';
  if (ca.length <= 8) return ca;
  return `${ca.slice(0, 4)}…${ca.slice(-4)}`;
}

function tickerLink(tkr, chartUrl) {
  const tag = tkr ? `$${tkr}` : 'Token';
  return chartUrl ? `<a href="${chartUrl}">${tag}</a>` : tag;
}

// ---- Alert text -----------------------------------------------------------
// 2x–8x (unchanged)
function rocketAlert({ tkr, ca, xNow, entryMc, nowMc, byUser }) {
  const rockets = '🚀'.repeat(Math.min(12, Math.max(4, Math.round(xNow * 2))));
  const tag = tkr ? `$${tkr}` : shortenCa(ca);
  return (
    `${rockets} ${tag} hit ${xNow.toFixed(2)}× since call!\n\n` +
    `📞 MC when called: ${usd(entryMc)}${byUser ? ` by @${byUser}` : ''}\n` +
    `🏆 MC now: ${usd(nowMc)}`
  );
}

// 10x+ (keeps your structure, adds bright headline + time)
function moonAlertBright({ tkr, entryMc, nowMc, xNow, byUser, hours, chartUrl }) {
  const headline = `<b>🌕 ${tickerLink(tkr, chartUrl)} hit ${xNow.toFixed(2)}× in ${formatHours(hours)} since call!</b>`;
  const body = `💹From ${usd(entryMc).replace('$', '')} ↗️ ${usd(nowMc).replace('$', '')}` +
               (byUser ? `  •  Called by @${byUser}` : '');
  return `${headline}\n\n${body}`;
}

// ---- Core check -----------------------------------------------------------
async function checkOne(c) {
  // Guard against corrupt docs
  if (!c || !c.entryMc || c.entryMc <= 0) return;
  if (!c.ca || typeof c.ca !== 'string' || !c.ca.trim()) return;

  let info;
  try {
    info = await getTokenInfo(c.ca);
  } catch (e) {
    console.warn(`⚠️ price fetch failed for ${c.ca}: ${e.message}`);
    return;
  }
  if (!info || !info.mc) return;

  const nowMc = info.mc;
  const xNow = nowMc / c.entryMc;

  // update last/peak
  c.lastMc = nowMc;
  c.peakMc = Math.max(c.peakMc || 0, nowMc);

  const already = Array.isArray(c.multipliersHit) ? [...c.multipliersHit] : [];

  const lowHits  = collectLowTierHits(xNow, already);
  const highHits = collectHighTierHits(xNow, already);
  const toFire   = [...lowHits, ...highHits].sort((a, b) => a - b);

  if (!toFire.length) {
    await c.save();
    return;
  }

  const chartUrl = info.chartUrl || dsChartUrl(c.chain || info.chain, c.ca);
  const kb = tradeKeyboards(c.chain || info.chain || 'SOL', chartUrl);
  const hours = hoursBetween(c.createdAt, NOW());
  const byUser = c.caller?.username || c.caller?.tgId;

  for (const m of toFire) {
    try {
      if (m >= 10) {
        const msg = moonAlertBright({
          tkr: c.ticker,
          entryMc: c.entryMc,
          nowMc,
          xNow,
          byUser,
          hours,
          chartUrl,
        });
        await tg.sendMessage(CH_ID, msg, { parse_mode: 'HTML', ...kb });
      } else {
        const msg = rocketAlert({
          tkr: c.ticker,
          ca: c.ca,
          xNow,
          entryMc: c.entryMc,
          nowMc,
          byUser,
        });
        await tg.sendMessage(CH_ID, msg, { parse_mode: 'HTML', ...kb });
      }
      already.push(m);
      await sleep(200);
    } catch (e) {
      console.error('❌ milestone post failed:', e?.response?.description || e.message);
    }
  }

  c.multipliersHit = [...new Set(already)].sort((a, b) => a - b);
  await c.save();
}

async function runOnce() {
  const since = new Date(Date.now() - BASE_DAYS * 24 * 3600 * 1000);
  const calls = await Call.find({
    createdAt: { $gte: since },
    entryMc:   { $gt: 0 },
    ca:        { $type: 'string', $ne: '' },
  }).limit(1000);

  if (!calls.length) return;
  console.log(`🔎 Checking ${calls.length} calls…`);

  for (const c of calls) {
    try { await checkOne(c); } catch (e) { console.error('checkOne error:', e.message); }
    await sleep(200);
  }
}

(async function main() {
  console.log(`📡 Worker running, every ${CHECK_MIN}m`);
  for (;;) {
    const t0 = Date.now();
    try { await runOnce(); } catch (e) { console.error('runOnce crash:', e.message); }
    const spent = Date.now() - t0;
    const wait  = Math.max(1000, CHECK_MIN * 60_000 - spent);
    await sleep(wait);
  }
})();
