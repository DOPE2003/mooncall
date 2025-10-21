// worker.js
require('dotenv').config();
require('./lib/db');

const Call = require('./model/call.model');
const { Telegraf } = require('telegraf');
const { getTokenInfo, usd } = require('./lib/price');
const { lowTierAlertText, highTierAlertText, tradeKeyboards } = require('./card');

const bot = new Telegraf(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);

// milestones: 2..8 (styled as “Chart/Boost”), and integers ≥10 with moon style
const BASE_MILESTONES = [2,3,4,5,6,7,8,10];

function humanDuration(ms) {
  if (ms <= 0) return '—';
  const h = Math.floor(ms / 36e5);
  const m = Math.floor((ms % 36e5) / 60000);
  if (h === 0) return `${m}m`;
  return `${h}h:${String(m).padStart(2, '0')}m`;
}

async function postLowTier(call, info, xNow) {
  const text = lowTierAlertText({
    tkr: call.ticker,
    ca: call.ca,
    xNow,
    entryMc: call.entryMc,
    nowMc: call.lastMc,
    byUser: call.caller?.username,
  });
  await bot.telegram.sendMessage(CH_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...tradeKeyboards(call.chain, info?.chartUrl),
  });
}

async function postHighTier(call, info, xNow) {
  const sinceMs = Date.now() - new Date(call.createdAt).getTime();
  const text = highTierAlertText({
    tkr: call.ticker,
    entryMc: call.entryMc,
    nowMc: call.lastMc,
    xNow,
    duration: humanDuration(sinceMs),
  });
  await bot.telegram.sendMessage(CH_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...tradeKeyboards(call.chain, info?.chartUrl),
  });
}

async function tick() {
  const calls = await Call.find({ entryMc: { $gt: 0 } }).limit(500);

  for (const c of calls) {
    let info;
    try { info = await getTokenInfo(c.ca); } catch {}

    const mc = info?.mc || null;
    if (!mc) continue;

    c.lastMc = mc;
    if (mc > (c.peakMc || 0)) c.peakMc = mc;

    const xNow = c.entryMc > 0 ? mc / c.entryMc : 0;

    // Decide which threshold(s) to fire
    const hitSet = new Set(c.multipliersHit || []);

    // integers >=10
    if (xNow >= 10) {
      const k = Math.floor(xNow);
      if (!hitSet.has(k)) {
        await postHighTier(c, info, xNow);
        hitSet.add(k);
      }
    } else {
      // 2..8 with low-tier format
      for (const m of BASE_MILESTONES) {
        if (m >= 10) continue;
        if (xNow >= m && !hitSet.has(m)) {
          await postLowTier(c, info, xNow);
          hitSet.add(m);
        }
      }
    }

    c.multipliersHit = Array.from(hitSet).sort((a,b) => a-b);
    await c.save();
  }
}

async function main() {
  console.log('📡 Worker running…');
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  // no polling here; just use telegram client to send messages
  setInterval(tick, Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES || 5)) * 60 * 1000);
  await tick(); // run once at boot
}
main().catch(e => console.error(e));
