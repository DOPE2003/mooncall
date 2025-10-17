// api/cron.js
const dbConnect = require("../lib/db");
const Call = require("../model/call.model");
const { getSolPrice, getBscPrice } = require("../lib/price");
const axios = require("axios");

// --- helpers ---
async function postToChannel(text) {
  const chatId = process.env.ALERTS_CHANNEL_ID;
  const token  = process.env.BOT_TOKEN;
  if (!chatId || !token) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true },
      { timeout: 8000 }
    );
  } catch (e) {
    console.log("postToChannel error:", e?.response?.data || e.message);
  }
}

module.exports = async (req, res) => {
  const out = { ok: true, processed: 0, skipped: 0 };

  try {
    // Optional protection
    if (process.env.CRON_SECRET) {
      const hdr = req.headers["x-cron-secret"];
      if (hdr !== process.env.CRON_SECRET) {
        out.ok = false; out.error = "bad secret";
        return res.status(200).json(out);
      }
    }

    // DB connect (should be cached inside lib/db)
    await dbConnect();

    const now      = new Date();
    const batch    = Number(process.env.CRON_BATCH || 50);
    const stepMin  = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
    const ladder   = (process.env.MILESTONES || "2,4,6,10").split(",").map(Number).filter(Boolean);
    const drawdown = Number(process.env.DUMP_ALERT_DRAWDOWN || 0);

    // Pull a small batch due for checking
    const due = await Call.find({ status: "active", nextCheckAt: { $lte: now } }).limit(batch);

    for (const c of due) {
      let price = null;
      try {
        if (c.chain === "SOL") price = await getSolPrice(c.tokenMint);
        else if (c.chain === "BSC") price = (await getBscPrice(c.tokenMint))?.price ?? null;
      } catch (_) {}

      if (!price) {
        // retry later
        c.nextCheckAt = new Date(Date.now() + stepMin * 60_000);
        await c.save();
        out.skipped++;
        continue;
      }

      // Update stats
      c.lastPrice = price;
      if (!c.peakPrice || price > c.peakPrice) {
        c.peakPrice   = price;
        c.peakMultiple = c.entryPrice ? price / c.entryPrice : null;
      }

      // Milestone alerts (2x/4x/6x/10x…)
      if (c.entryPrice) {
        for (const m of ladder) {
          const flag = `hit${m}x`;
          if (!c[flag] && price >= m * c.entryPrice) {
            c[flag] = true;
            await postToChannel(
              `🚀 *${c.chain}* call hit *${m}×*!\n\`${c.tokenMint}\`\nEntry: ${c.entryPrice}\nNow: ${price}`
            );
          }
        }
      }

      // Drawdown alert
      if (drawdown > 0 && c.peakPrice && !c.dumpAlerted && price <= (1 - drawdown) * c.peakPrice) {
        c.dumpAlerted = true;
        await postToChannel(
          `⚠️ *${c.chain}* call dumped ${Math.round(drawdown * 100)}% from peak.\n\`${c.tokenMint}\``
        );
      }

      // Next tick / expiry
      c.nextCheckAt = new Date(Date.now() + stepMin * 60_000);
      if (c.expiresAt && c.expiresAt <= now) c.status = "expired";
      await c.save();
      out.processed++;
    }

    return res.status(200).json(out);
  } catch (e) {
    console.error("cron fatal:", e);
    out.ok = false;
    out.error = e?.message || String(e);
    // Still return 200 so Vercel doesn’t mark the invocation as failed
    return res.status(200).json(out);
  }
};
