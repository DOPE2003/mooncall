// api/cron.js
const dbConnect = require("../lib/db");
const Call = require("../model/call.model");
const Settings = require("../model/settings.model");
const { getSolPrice, getBscPrice } = require("../price");
const axios = require("axios");

async function postToChannel(text) {
  if (!process.env.ALERTS_CHANNEL_ID) return;
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  await axios.post(url, { chat_id: process.env.ALERTS_CHANNEL_ID, text, parse_mode: "Markdown", disable_web_page_preview: true })
    .catch(()=>{});
}

module.exports = async (req, res) => {
  try {
    await dbConnect();

    const s = await Settings.findById("global").lean();
    const paused = !!s?.paused;
    const ladder = (s?.milestones?.length ? s.milestones : (process.env.MILESTONES||"2,4,6,10")
      .split(",").map(Number).filter(Boolean)).sort((a,b)=>a-b);
    const stepMin = Number(s?.checkIntervalMinutes || process.env.CHECK_INTERVAL_MINUTES || 60);

    const now = new Date();
    const due = paused ? [] : await Call.find({ status: "active", nextCheckAt: { $lte: now } }).limit(200);
    let processed = 0;

    for (const c of due) {
      let price = null;
      if (c.chain === "sol") price = await getSolPrice(c.mintAddress).catch(()=>null);
      else if (c.chain === "bsc") price = await getBscPrice(c.mintAddress).catch(()=>null);

      if (!price) {
        c.nextCheckAt = new Date(Date.now() + stepMin*60*1000);
        await c.save();
        continue;
      }

      c.lastPrice = price;
      if (!c.peakPrice || price > c.peakPrice) {
        c.peakPrice = price;
        c.peakMultiple = c.entryPrice ? (price / c.entryPrice) : null;
      }

      // milestones
      for (const m of ladder) {
        const flag = `hit${m}x`;
        if (!c[flag] && c.entryPrice && price >= m * c.entryPrice) {
          c[flag] = true;
          await postToChannel(`🚀 ${c.chain.toUpperCase()} call hit *${m}×*!\n\`${c.mintAddress}\`\nEntry: ${c.entryPrice}\nNow: ${price}`);
        }
      }

      // dump alert
      const dd = Number(process.env.DUMP_ALERT_DRAWDOWN || 0);
      if (dd > 0 && c.peakPrice && price <= (1 - dd) * c.peakPrice && !c.dumpAlerted) {
        c.dumpAlerted = true;
        await postToChannel(`⚠️ ${c.chain.toUpperCase()} call dumped ${Math.round(dd*100)}% from peak.\n\`${c.mintAddress}\``);
      }

      // next tick / expiry
      c.nextCheckAt = new Date(Date.now() + stepMin*60*1000);
      if (c.expiresAt && c.expiresAt <= now) c.status = "expired";
      await c.save();
      processed++;
    }

    res.status(200).json({ ok: true, processed, paused });
  } catch (e) {
    console.error("cron error:", e.message);
    res.status(200).json({ ok: false, processed: 0, error: e.message });
  }
};
