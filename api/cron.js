// api/cron.js
const dbConnect = require("../lib/db");
const callModel = require("../model/call.model");
const { getSolPrice, getBscPrice } = require("../lib/price");
const axios = require("axios");

async function postToChannel(text) {
  if (!process.env.ALERTS_CHANNEL_ID) return;
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: process.env.ALERTS_CHANNEL_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true
  }, { timeout: 8000 }).catch(() => {});
}

module.exports = async (req, res) => {
  // simple protection
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: "bad secret" });
  }
  await dbConnect();

  const now = new Date();
  const due = await callModel.find({ status: "active", nextCheckAt: { $lte: now } }).limit(100);
  let processed = 0;

  for (const c of due) {
    let price = null;
    if (c.chain === "SOL") price = await getSolPrice(c.tokenMint).catch(() => null);
    else if (c.chain === "BSC") price = (await getBscPrice(c.tokenMint).catch(() => null))?.price ?? null;

    if (!price) {
      // retry later
      c.nextCheckAt = new Date(Date.now() + Number(process.env.CHECK_INTERVAL_MINUTES || 60) * 60000);
      await c.save();
      continue;
    }

    // update stats
    c.lastPrice = price;
    if (!c.peakPrice || price > c.peakPrice) {
      c.peakPrice = price;
      c.peakMultiple = c.entryPrice ? (price / c.entryPrice) : null;
    }

    // milestones
    const ladder = (process.env.MILESTONES || "2,4,6,10").split(",").map(Number).filter(Boolean);
    for (const m of ladder) {
      const flag = `hit${m}x`;
      if (!c[flag] && c.entryPrice && price >= m * c.entryPrice) {
        c[flag] = true;
        await postToChannel(`🚀 ${c.chain} call hit *${m}×*!\n\`${c.tokenMint}\`\nEntry: ${c.entryPrice}\nNow: ${price}`);
      }
    }

    // dump alert
    const dd = Number(process.env.DUMP_ALERT_DRAWDOWN || 0);
    if (dd > 0 && c.peakPrice && price <= (1 - dd) * c.peakPrice && !c.dumpAlerted) {
      c.dumpAlerted = true;
      await postToChannel(`⚠️ ${c.chain} call dumped ${Math.round(dd*100)}% from peak.\n\`${c.tokenMint}\``);
    }

    // next check / expiry
    const step = Number(process.env.CHECK_INTERVAL_MINUTES || 60) * 60000;
    c.nextCheckAt = new Date(Date.now() + step);
    if (c.expiresAt && c.expiresAt <= now) c.status = "expired";

    await c.save();
    processed++;
  }

  return res.status(200).json({ ok: true, processed });
};
