// worker.js
'use strict';

require('dotenv').config();
require('./lib/db');

const { Telegram } = require('telegraf');
const Call = require('./model/call.model');
const { getTokenInfo, usd } = require('./lib/price');
const { tradeKeyboards } = require('./card');

const tg = new Telegram(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID || 0);

// ── Config ───────────────────────────────────────────────────────────────────
const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 1);   // poll loop
const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);          // how long to track calls

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

// Anti-MEV / quality guards (tune in .env)
const MIN_LP_USD       = Number(process.env.MIN_LP_USD || 2000);     // min liquidity
const MIN_VOL5M_USD    = Number(process.env.MIN_VOL5M_USD || 500);   // prefer 5-minute volume
const MIN_VOL24H_USD   = Number(process.env.MIN_VOL24H_USD || 0);    // fallback if no 5m
const MIN_AGE_MIN      = Number(process.env.MIN_AGE_MIN || 0);       // token age (minutes) before alerts
const CONFIRM_SECONDS  = Number(process.env.CONFIRM_SECONDS || 60);  // must still hold after N seconds

// Coalesce multiple hits (post only the highest × in one message)
const COALESCE_MILESTONES = String(process.env.COALESCE_MILESTONES || '0') === '1';

// tolerance so we don’t miss by a hair
const EPS = 0.01;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NOW = () => new Date();

// For two-tick confirmations (no DB writes). key = `${callId}:${milestone}`
const pendingConfirms = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── NEW safety helpers (cap display & persistence) ───────────────────────────
function cappedNowMc(call, liveMc, nextPeak) {
  const live = Number(liveMc) || 0;
  const peakCandidate = Number.isFinite(nextPeak) ? nextPeak : (Number(call.peakMc) || 0);
  return Math.min(live, Math.max(0, peakCandidate));
}
function shownX(call, nowMc) {
  if (!call.entryMc || call.entryMc <= 0) return 1;
  return Math.max(1, (Number(nowMc) || call.entryMc) / call.entryMc);
}

// ── Guards / Anti-MEV ────────────────────────────────────────────────────────
function passQualityGuards(info, callDoc) {
  if (MIN_LP_USD > 0 && Number.isFinite(info.lp) && info.lp < MIN_LP_USD) return false;

  const ageMin = Number.isFinite(info.ageMin)
    ? info.ageMin
    : Math.max(0, (NOW() - callDoc.createdAt) / 60000);
  if (MIN_AGE_MIN > 0 && ageMin < MIN_AGE_MIN) return false;

  if (MIN_VOL5M_USD > 0 && Number.isFinite(info.vol5m) && info.vol5m < MIN_VOL5M_USD) return false;
  if (MIN_VOL5M_USD <= 0 && MIN_VOL24H_USD > 0 && Number.isFinite(info.vol24h) && info.vol24h < MIN_VOL24H_USD) return false;

  return true;
}

// return true = HOLD (wait); false = OK to POST
function shouldHoldConfirm(callId, milestone, stillValid, seconds = CONFIRM_SECONDS) {
  const key = `${callId}:${milestone}`;
  const now = Date.now();
  const rec = pendingConfirms.get(key);

  if (!rec) {
    pendingConfirms.set(key, { first: now });
    return true; // hold
  }

  const maxWindow = Math.max(5 * 60_000, seconds * 1000 * 5);
  if (now - rec.first > maxWindow) {
    pendingConfirms.set(key, { first: now });
    return true;
  }

  if ((now - rec.first) >= seconds * 1000 && stillValid) {
    pendingConfirms.delete(key);
    return false; // OK to post
  }
  return true;
}

// ── Alert text (uses capped X/MC) ────────────────────────────────────────────
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

// ── Core check ───────────────────────────────────────────────────────────────
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

  const liveMc = Number(info.mc) || 0;
  const hours   = hoursBetween(c.createdAt, NOW());

  // Determine the peak candidate respecting admin “lock” (if you use it)
  const prevPeak = Number(c.peakMc) || 0;
  const nextPeak = c.peakLocked ? prevPeak : Math.max(prevPeak, liveMc);

  // What we show in messages (and store in lastMc) is capped by peak
  const nowMc  = cappedNowMc(c, liveMc, nextPeak);
  const xNow   = shownX(c, nowMc);

  // Update last/peak (never re-inflate over admin caps)
  c.lastMc = nowMc;
  c.peakMc = nextPeak;

  // Already fired multipliers
  const already = Array.isArray(c.multipliersHit) ? [...c.multipliersHit] : [];

  // Which thresholds to consider based on capped X?
  const lowHits  = collectLowTierHits(xNow, already);
  const highHits = collectHighTierHits(xNow, already);
  let toFire     = [...lowHits, ...highHits].sort((a, b) => a - b);

  if (!toFire.length) {
    await c.save();
    return;
  }

  // Quality / anti-MEV guards (HARD guard: if it fails, skip alerts)
  const qualityOK = passQualityGuards(info, c);
  if (!qualityOK) {
    await c.save();
    return;
  }

  const kb = tradeKeyboards(c.chain || info.chain || 'SOL', info.chartUrl);

  // === Coalesced mode: one message at highest ×, atomically claim all hits ===
  if (COALESCE_MILESTONES && toFire.length > 1) {
    const highest = toFire[toFire.length - 1];
    const stillValid = xNow >= highest * (1 - EPS);
    if (shouldHoldConfirm(c._id.toString(), highest, stillValid)) {
      await c.save();
      return;
    }

    // Atomic claim: only proceed if 'highest' not already in DB
    const claim = await Call.updateOne(
      { _id: c._id, multipliersHit: { $ne: highest } },
      { $addToSet: { multipliersHit: { $each: toFire } } }
    );
    if (claim.modifiedCount === 0) { // someone else posted
      await c.save();
      return;
    }

    // Mirror DB change locally so our final save doesn't clobber it
    for (const m of toFire) if (!already.includes(m)) already.push(m);

    const msg = highest >= 10
      ? moonAlert({ tkr: c.ticker, entryMc: c.entryMc, nowMc, xNow, byUser: c.caller?.username || c.caller?.tgId, hours })
      : rocketAlert({ tkr: c.ticker, ca: c.ca, xNow, entryMc: c.entryMc, nowMc, byUser: c.caller?.username || c.caller?.tgId, hours });

    try { if (CH_ID) await tg.sendMessage(CH_ID, msg, { parse_mode: 'HTML', ...kb }); } catch (e) {
      console.error('❌ milestone post failed:', e?.response?.description || e.message);
    }

  } else {
    // === Normal mode: atomic claim per milestone ===
    for (const m of toFire) {
      try {
        const stillValid = xNow >= m * (1 - EPS);
        if (shouldHoldConfirm(c._id.toString(), m, stillValid)) continue;

        // Atomic claim — if already present, skip posting
        const claim = await Call.updateOne(
          { _id: c._id, multipliersHit: { $ne: m } },
          { $addToSet: { multipliersHit: m } }
        );
        if (claim.modifiedCount === 0) continue; // someone else posted

        already.push(m); // mirror claim locally

        const msg = m >= 10
          ? moonAlert({ tkr: c.ticker, entryMc: c.entryMc, nowMc, xNow, byUser: c.caller?.username || c.caller?.tgId, hours })
          : rocketAlert({ tkr: c.ticker, ca: c.ca, xNow, entryMc: c.entryMc, nowMc, byUser: c.caller?.username || c.caller?.tgId, hours });

        if (CH_ID) await tg.sendMessage(CH_ID, msg, { parse_mode: 'HTML', ...kb });
        await sleep(200);
      } catch (e) {
        console.error('❌ milestone post failed:', e?.response?.description || e.message);
      }
    }
  }

  // Persist non-milestone fields + our local mirror of multipliersHit
  c.multipliersHit = [...new Set(already)].sort((a, b) => a - b);
  await c.save();
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function runOnce() {
  const since = new Date(Date.now() - BASE_DAYS * 24 * 3600 * 1000);
  const calls = await Call.find({
    createdAt: { $gte: since },
    entryMc:   { $gt: 0 },
    ca:        { $type: 'string', $ne: '' },
    chain:     { $in: ['SOL', 'BSC'] },
  }).sort({ createdAt: -1 }).limit(1000);

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
