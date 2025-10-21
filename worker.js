// worker.js
require('dotenv').config();
require('./lib/db');

const { Telegram } = require('telegraf');
const tg = new Telegram(process.env.BOT_TOKEN);

const Call = require('./model/call.model');
const { getTokenInfo, usd, shortAddr } = require('./lib/price');

const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);

// how far back we keep tracking calls
const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);

// how often we poll
const INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MINUTES || 1)) * 60_000;

// 2x..8x alerts (boss request)
const LOW_MILES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',').map(n => Number(n.trim())).filter(n => n > 1 && n < 10).sort((a,b)=>a-b);

// 10x+ alerts (post again at bigger round numbers)
const HI_MILES = String(process.env.HI_MILESTONES || '10,12,15,20,25,30')
  .split(',').map(n => Number(n.trim())).filter(n => n >= 10).sort((a,b)=>a-b);

function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h}h:${String(min).padStart(2, '0')}m`;
}

function lowTierText({ tkr, ca, xNow, entryMc, nowMc, byUser }) {
  const rockets = '🚀'.repeat(Math.min(12, Math.max(4, Math.round(xNow * 2))));
  const tag = tkr ? `$${tkr}` : shortAddr(ca);
  return (
    `${rockets} ${tag} hit ${xNow.toFixed(2)}× since call!\n\n` +
    `📞 Called at MC: ${usd(entryMc)} by @${byUser}\n` +
    `🏆 Now MC: ${usd(nowMc)}`
  );
}

function highTierText({ tkr, entryMc, nowMc, xNow, sinceMs }) {
  // Example: 🌕 $CRK 11x | 💹From 66.1K ↗️ 300.6K within 2h:50m
  const tag = tkr ? `$${tkr}` : 'Token';
  return (
    `🌕 ${tag} ${xNow.toFixed(2)}x | ` +
    `💹From ${usd(entryMc).replace('$','')} ↗️ ${usd(nowMc).replace('$','')} ` +
    `within ${formatDuration(sinceMs)}`
  );
}

async function tick() {
  const createdSince = new Date(Date.now() - BASE_DAYS * 24 * 3600 * 1000);

  // track recent calls only
  const calls = await Call.find({ createdAt: { $gte: createdSince } }).limit(500);

  for (const c of calls) {
    try {
      // Pull fresh MC (your getTokenInfo already talks to Dexscreener)
      const info = await getTokenInfo(c.ca);
      if (!info || !info.mc) continue;

      const entry = Number(c.entryMc || 0);
      if (!entry) continue; // can't compute X; ensure entryMc is set when saving a call

      const nowMc = info.mc;
      const xNow = nowMc / entry;

      // update last & peak
      const newPeak = Math.max(Number(c.peakMc || 0), nowMc);
      if (newPeak !== c.peakMc || nowMc !== c.lastMc) {
        await Call.updateOne(
          { _id: c._id },
          { $set: { lastMc: nowMc, peakMc: newPeak } }
        );
      }

      const already = new Set(c.multipliersHit || []);
      let changed = false;

      // 2x..8x alerts
      for (const X of LOW_MILES) {
        if (xNow >= X && !already.has(X)) {
          const txt = lowTierText({
            tkr: c.ticker,
            ca: c.ca,
            xNow,
            entryMc: entry,
            nowMc,
            byUser: c.caller?.username || c.caller?.tgId || 'user'
          });
          await tg.sendMessage(CH_ID, txt, { parse_mode: 'HTML' });
          already.add(X);
          changed = true;
        }
      }

      // 10x+ alerts
      for (const X of HI_MILES) {
        if (xNow >= X && !already.has(X)) {
          const txt = highTierText({
            tkr: c.ticker,
            entryMc: entry,
            nowMc,
            xNow,
            sinceMs: Date.now() - c.createdAt.getTime(),
          });
          await tg.sendMessage(CH_ID, txt, { parse_mode: 'HTML' });
          already.add(X);
          changed = true;
        }
      }

      if (changed) {
        await Call.updateOne(
          { _id: c._id },
          { $set: { multipliersHit: Array.from(already) } }
        );
      }
    } catch (e) {
      console.error('Worker error on', c.ca, e.message);
    }
  }
}

console.log('📡 Worker running…');
setInterval(tick, INTERVAL_MS);
tick();
