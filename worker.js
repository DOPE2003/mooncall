// worker.js
require('dotenv').config();
require('./lib/db');

const { Telegram } = require('telegraf');
const Call = require('./model/call.model');
const { getTokenInfo, usd } = require('./lib/price');

const tg = new Telegram(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID || 0);

const CHECK_MIN = Math.max(1, parseInt(process.env.CHECK_INTERVAL_MINUTES || '5', 10));
const TRACK_DAYS = Math.max(1, parseInt(process.env.BASE_TRACK_DAYS || '7', 10));

console.log('📡 Worker running…');

function shortAddr(addr, dex = '') {
  if (!addr) return '—';
  const head = addr.slice(0, 4);
  const suffix = dex && dex.toLowerCase().includes('pump') ? 'pump' : 'ca';
  return `${head}…${suffix}`;
}

function compactUsd(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const fmt = (val, unit) =>
    `$${val.toFixed(val >= 100 ? 0 : 1)}${unit}`;

  if (abs >= 1_000_000_000) return fmt(n / 1_000_000_000, 'B');
  if (abs >= 1_000_000) return fmt(n / 1_000_000, 'M');
  if (abs >= 1_000) return fmt(n / 1_000, 'K');
  return usd(n); // fall back to full $12,345 format
}

function elapsedHM(fromDate) {
  if (!fromDate) return '—';
  const ms = Date.now() - new Date(fromDate).getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h:${String(m).padStart(2, '0')}m`;
}

// Decide which milestone to trigger next.
// - 2..8: integer thresholds
// - >=10: every new integer (10, 11, 12, …)
function nextMilestone(nowX, sentSet) {
  // 2..8 band
  for (let k = 2; k <= 8; k++) {
    if (nowX >= k && !sentSet.has(k)) return k;
  }
  // 10+ band
  const k = Math.floor(nowX);
  if (k >= 10 && !sentSet.has(k)) return k;
  return null;
}

async function tick() {
  try {
    const since = new Date(Date.now() - TRACK_DAYS * 24 * 3600 * 1000);
    const docs = await Call.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(500);

    for (const doc of docs) {
      if (!doc.ca) {
        console.log('skip: missing CA on doc', doc._id.toString());
        continue;
      }
      if (!doc.entryMc || doc.entryMc <= 0) {
        // We need an entry marketcap to compute X
        continue;
      }

      // fetch latest price / mc
      let info;
      try {
        info = await getTokenInfo(doc.ca);
      } catch (e) {
        console.log('tick error', doc.ticker, 'price unavailable');
        continue;
      }
      if (!info || !info.mc) {
        console.log('tick error', doc.ticker, 'price unavailable');
        continue;
      }

      const nowMc = info.mc;
      const peakMc = Math.max(doc.peakMc || 0, nowMc);
      const nowX = nowMc / doc.entryMc;
      const peakX = peakMc / doc.entryMc;

      // Determine if we crossed a new milestone
      const sentSet = new Set(doc.multipliersHit || []);
      const milestone = nextMilestone(nowX, sentSet);

      // Always update last/peak on every pass
      let needSave = false;
      if (doc.lastMc !== nowMc) {
        doc.lastMc = nowMc;
        needSave = true;
      }
      if (doc.peakMc !== peakMc) {
        doc.peakMc = peakMc;
        needSave = true;
      }

      if (milestone != null) {
        // Compose alert
        let text = '';
        const tkr = doc.ticker ? `$${doc.ticker}` : 'Token';
        const short = shortAddr(doc.ca, info.dex);
        const user = doc.caller?.username || doc.caller?.tgId || 'caller';
        const when = elapsedHM(doc.createdAt);

        if (milestone >= 2 && milestone <= 8) {
          // Rocket style (2x..8x)
          const rockets = '🚀'.repeat(milestone * 2); // 2x -> 4 rockets, 4x -> 8 rockets…
          text =
            `${rockets} ${tkr} (${short}) hit ${nowX.toFixed(2)}× since call!\n\n` +
            `Called at MC: ${usd(doc.entryMc)} by @${user}\n` +
            `Now MC: ${usd(nowMc)}`;
        } else if (milestone >= 10) {
          // Moon style (10x+)
          text =
            `🌕${tkr} ${nowX.toFixed(2)}x (${peakX.toFixed(2)}x peak) | ` +
            `💹From ${compactUsd(doc.entryMc)} ↗️ ${compactUsd(nowMc)} ` +
            `within ${when}`;
        }

        try {
          await tg.sendMessage(CH_ID, text, {
            disable_web_page_preview: true,
          });
          // mark milestone as sent
          sentSet.add(milestone);
          doc.multipliersHit = Array.from(sentSet);
          needSave = true;
        } catch (e) {
          console.error('send alert failed:', e.response?.description || e.message);
        }
      }

      if (needSave) {
        await doc.save();
      }
    }
  } catch (e) {
    console.error('tick failed:', e);
  }
}

setInterval(tick, CHECK_MIN * 60 * 1000);
tick();
