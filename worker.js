// worker.js
require('dotenv').config();
require('./lib/db');

const { Telegram } = require('telegraf');
const Call = require('./model/call.model');
const { getTokenInfo, usd } = require('./lib/price');
const { tradeKeyboards } = require('./card');

const tg = new Telegram(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);

// config
const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 1);
const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);
const MILESTONES = String(process.env.MILESTONES || '2,4,6,10')
  .split(',')
  .map(Number)
  .filter((n) => n > 0)
  .sort((a, b) => a - b);

const NOW = () => new Date();

function hoursBetween(a, b) {
  return Math.max(0, (b - a) / 36e5);
}
function formatDuration(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}h:${String(mm).padStart(2, '0')}m`;
}

function highestMilestone(x) {
  let best = null;
  for (const m of MILESTONES) if (x >= m) best = m;
  return best;
}

// --- alert text builders -----------------------------------------------------
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

// ---------------------------------------------------------------------------
async function checkOnce() {
  const since = new Date(Date.now() - BASE_DAYS * 24 * 3600 * 1000);

  // track only reasonably recent calls with a valid entry MC
  const calls = await Call.find({
    createdAt: { $gte: since },
    entryMc: { $gt: 0 },
  }).limit(500);

  for (const c of calls) {
    try {
      const info = await getTokenInfo(c.ca);
      if (!info || !info.mc) continue;

      const nowMc = info.mc;
      const peakMc = Math.max(c.peakMc || 0, nowMc);
      const lastMc = nowMc;

      const xNow = nowMc / c.entryMc;
      const xPeak = peakMc / c.entryMc;

      // decide if we crossed a milestone
      const hitNow = highestMilestone(xNow);
      const already = new Set(c.multipliersHit || []);

      // 2x–8x rockets
      if (hitNow && hitNow >= 2 && hitNow < 10 && !already.has(hitNow)) {
        const text = rocketAlert({
          tkr: c.ticker,
          ca: c.ca,
          xNow,
          entryMc: c.entryMc,
          nowMc,
          byUser: c.caller?.username || c.caller?.tgId,
        });

        const kb = tradeKeyboards(c.chain, info.chartUrl);
        await tg.sendMessage(CH_ID, text, { parse_mode: 'HTML', ...kb });

        already.add(hitNow);
      }

      // 10x+ moon
      if (xNow >= 10 && !already.has(10)) {
        const hours = hoursBetween(c.createdAt, NOW());
        const text = moonAlert({
          tkr: c.ticker,
          entryMc: c.entryMc,
          nowMc,
          xNow,
          hours,
        });

        const kb = tradeKeyboards(c.chain, info.chartUrl);
        await tg.sendMessage(CH_ID, text, { parse_mode: 'HTML', ...kb });

        already.add(10);
      }

      // persist metrics & hits
      c.lastMc = lastMc;
      c.peakMc = peakMc;
      c.multipliersHit = Array.from(already).sort((a, b) => a - b);
      await c.save();
    } catch (e) {
      // swallow individual token errors; continue
      // console.error('worker token error', c.ca, e.message);
    }
  }
}

async function main() {
  console.log('📡 Worker running…');
  await checkOnce();
  setInterval(checkOnce, CHECK_MIN * 60 * 1000);
}

main().catch((e) => {
  console.error('Worker crashed', e);
  process.exit(1);
});
