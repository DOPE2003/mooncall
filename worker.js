// worker.js
require('dotenv').config();
require('./lib/db');

const Call = require('./model/call.model');
const { getTokenInfo, usd } = require('./lib/price');
const { Telegraf } = require('telegraf');
const { lowTierAlertText, highTierAlertText, tradeKeyboards } = require('./card');

const bot = new Telegraf(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);

// config
const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 2);
const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);
const DRAW_ALERT = Number(process.env.DUMP_ALERT_DRAWDOWN || 0);

// milestones: we’ll split 2–8 (low tier) & 10+ (high tier)
const MILES = String(process.env.MILESTONES || '2,4,6,8,10')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => !isNaN(n) && n > 1)
  .sort((a, b) => a - b);

function minutes(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h:${String(mm).padStart(2, '0')}m`;
}

async function tick() {
  const since = new Date(Date.now() - BASE_DAYS * 24 * 3600 * 1000);

  const calls = await Call.find({ createdAt: { $gte: since } }).lean();

  for (const c of calls) {
    try {
      const info = await getTokenInfo(c.ca);
      if (!info || !info.mc) continue;

      const nowMc = info.mc;
      const entryMc = c.entryMc || nowMc;
      const peakMc = Math.max(c.peakMc || 0, nowMc);
      const lastMc = nowMc;

      // track peak
      const $set = { lastMc, peakMc };

      // drawdown alert (optional)
      if (DRAW_ALERT > 0 && peakMc > 0) {
        const dd = 100 * (peakMc - nowMc) / peakMc;
        if (!c.dumpAlertSent && dd >= DRAW_ALERT) {
          await bot.telegram.sendMessage(
            CH_ID,
            `⚠️ ${c.ticker ? '$' + c.ticker : 'Token'} drew down ${dd.toFixed(1)}% from peak.`,
            { disable_web_page_preview: true }
          );
          $set.dumpAlertSent = true;
        }
      }

      // milestones
      const xNow = entryMc ? nowMc / entryMc : 1;
      const already = new Set(c.multipliersHit || []);
      const toSend = MILES.filter((m) => xNow >= m && !already.has(m));

      for (const m of toSend) {
        const byUser = c.caller?.username;
        const duration = minutes(Date.now() - new Date(c.createdAt).getTime());
        const kb = tradeKeyboards(c.chain, info.chartUrl);

        let text;
        if (m >= 10) {
          text = highTierAlertText({
            tkr: c.ticker,
            entryMc,
            nowMc,
            xNow,
            duration,
          });
        } else {
          text = lowTierAlertText({
            tkr: c.ticker,
            ca: c.ca,
            xNow,
            entryMc,
            nowMc,
            byUser,
          });
        }

        await bot.telegram.sendMessage(CH_ID, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...kb,
        });

        already.add(m);
      }

      await Call.updateOne(
        { _id: c._id },
        { $set, $addToSet: { multipliersHit: { $each: Array.from(already) } } }
      );
    } catch (e) {
      console.error('tick error', e.message);
    }
  }
}

console.log('📡 Worker running…');
setInterval(tick, CHECK_MIN * 60 * 1000);
tick().catch((e) => console.error(e));
