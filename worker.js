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
const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 1);  // poll loop
const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);         // how long to track calls

// Low-tier milestones (<10×)
const MILESTONES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => n > 1 && n < 10)
  .sort((a, b) => a - b);

// High-tier sweep (>=10×)
const HIGH_START = Number(process.env.HIGH_START || 10);
const HIGH_STEP  = Number(process.env.HIGH_STEP  || 10);   // 10=10x,20x,... | 1=10x,11x,...
const HIGH_MAX   = Number(process.env.HIGH_MAX   || 5000);

// Anti-MEV & quality guards (tune in .env)
const MIN_LP_USD       = Number(process.env.MIN_LP_USD || 1000);   // require minimum LP
const MIN_VOL5M_USD    = Number(process.env.MIN_VOL5M_USD || 0);   // if getTokenInfo supplies vol5m
const MIN_VOL24H_USD   = Number(process.env.MIN_VOL24H_USD || 0);  // fallback if no vol5m
const MIN_AGE_MIN      = Number(process.env.MIN_AGE_MIN || 0);     // token age (minutes) before alerts
const CONFIRM_SECONDS  = Number(process.env.CONFIRM_SECONDS || 60);// second pass must still be true

// tolerance for threshold checks so we don’t miss by a hair
const EPS = 0.01;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NOW = () => new Date();

// For two-tick confirmations without DB writes
// key = `${callId}:${milestone}`
const pendingConfirms = new Map();

function hoursBetween(a, b) {
  return Math.max(0, (b - a) / 36e5);
}
function humanDuration(h) {
  if (!Number.isFinite(h)) return '—';
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60));
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const hr = Math.round(h);
  return `${hr} hour${hr === 1 ? '' : 's'}`;
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

function shortenCa(ca) {
  if (!ca || typeof ca !== 'string') return 'Token';
  if (ca.length <= 8) return ca;
  return `${ca.slice(0, 4)}…${ca.slice(-4)}`;
}

// ---- Guards / Anti-MEV -----------------------------------------------------
function passQualityGuards(info, callDoc) {
  // LP
  if (MIN_LP_USD > 0 && Number.isFinite(info.lp) && info.lp < MIN_LP_USD) return false;

  // Age (minutes) — prefer info.ageMin if supplied, else compute from call time
  const ageMin = Number.isFinite(info.ageMin)
    ? info.ageMin
    : Math.max(0, (NOW() - callDoc.createdAt) / 60000);
  if (MIN_AGE_MIN > 0 && ageMin < MIN_AGE_MIN) return false;

  // Volume — prefer 5m if present, else 24h if set
  if (MIN_VOL5M_USD > 0 && Number.isFinite(info.vol5m) && info.vol5m < MIN_VOL5M_USD) return false;
  if (MIN_VOL5M_USD <= 0 && MIN_VOL24H_USD > 0 && Number.isFinite(info.vol24h) && info.vol24h < MIN_VOL24H_USD) return false;

  return true;
}

function shouldConfirm(callId, milestone, stillValid) {
  const key = `${callId}:${milestone}`;
  const now = Date.now();
  const rec = pendingConfirms.get(key);

  if (!rec) {
    // first hit — start confirmation window, do not alert yet
    pendingConfirms.set(key, { first: now });
    return true; // means "hold; waiting confirm"
  }

  // if window expired, restart
  if (now - rec.first > Math.max(5 * 60_000, CONFIRM_SECONDS * 1000 * 5)) {
    pendingConfirms.set(key, { first: now });
    return true;
  }

  // if we are within confirmation window and the condition still holds after CONFIRM_SECONDS => OK to post
  if (now - rec.first >= CONFIRM_SECONDS * 1000 && stillValid) {
    pendingConfirms.delete(key);
    return false; // do not hold -> allow alert
  }

  // keep waiting
  return true;
}

// ---- Alert text -----------------------------------------------------------
// <10× — bright, with duration + “by @user” and bold stats lines
function rocketAlert({ tkr, ca, xNow, entryMc, nowMc, byUser, hours }) {
  const rockets = '🚀'.repeat(Math.min(12, Math.max(4, Math.round(xNow * 2))));
  const tag = tkr ? `$${tkr}` : shortenCa(ca);
  const dur = humanDuration(hours);

  return (
    `${rockets} <b>${tag}</b> <b>soared by X${xNow.toFixed(2)}</b> in <b>${dur}</b> since call! 🚀🌕\n\n` +
    `📞 MC when called: <b>${usd(entryMc)}</b>${byUser ? ` by @${byUser}` : ''}\n\n` +
    `🏆 MC now: <b>${usd(nowMc)}</b>`
  );
}

// ≥10× — one-line structure, add duration, bold parts
// Example: 🌕🌖 $BYND 47.5x | 💹From 60K ↗️ 2.85M • 16h since call — called by @user
function moonAlert({ tkr, entryMc, nowMc, xNow, byUser, hours }) {
  const tag = tkr ? `$${tkr}` : 'Token';
  const dur = humanDuration(hours);
  return (
    `🌕🌖 <b>${tag}</b> <b>${xNow.toFixed(2)}x</b> | ` +
    `💹From <b>${usd(entryMc).replace('$','')}</b> ↗️ <b>${usd(nowMc).replace('$','')}</b>\n\n` +
    `<b>${dur}</b> since call` +
    (byUser ? `\n\ncalled by @${byUser}` : '')
  );
}

// ---- Core check -----------------------------------------------------------
async function checkOne(c) {
  // Guard against corrupt docs
  if (!c || !c.entryMc || c.entryMc <= 0) return;
  if (!c.ca || typeof c.ca !== 'string' || !c.ca.trim()) {
    console.warn('⚠️ skipping doc with missing/invalid CA', c._id?.toString?.());
    return;
  }

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
  const hours = hoursBetween(c.createdAt, NOW());

  // update last/peak (always track)
  c.lastMc = nowMc;
  c.peakMc = Math.max(c.peakMc || 0, nowMc);

  // list of already fired multipliers
  const already = Array.isArray(c.multipliersHit) ? [...c.multipliersHit] : [];

  // which thresholds to consider?
  const lowHits = collectLowTierHits(xNow, already);
  const highHits = collectHighTierHits(xNow, already);
  let toFire = [...lowHits, ...highHits].sort((a, b) => a - b);

  if (!toFire.length) {
    await c.save();
    return;
  }

  // Quality / anti-MEV guards
  const qualityOK = passQualityGuards(info, c);

  // For each milestone, apply confirmation window & guards
  for (const m of toFire) {
    try {
      const stillValid = xNow >= m * (1 - EPS);

      // If quality guard fails, we always require confirmation (two ticks)
      const needConfirm = !qualityOK || shouldConfirm(c._id.toString(), m, stillValid);
      if (needConfirm) continue; // skip posting this tick

      const kb = tradeKeyboards(c.chain || info.chain || 'SOL', info.chartUrl);

      if (m >= 10) {
        const msg = moonAlert({
          tkr: c.ticker,
          entryMc: c.entryMc,
          nowMc,
          xNow,
          byUser: c.caller?.username || c.caller?.tgId,
          hours,
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
          hours,
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
    entryMc: { $gt: 0 },
    ca: { $type: 'string', $ne: '' },
    chain: { $in: ['SOL', 'BSC'] },
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
    const wait = Math.max(1000, CHECK_MIN * 60_000 - spent);
    await sleep(wait);
  }
})();
