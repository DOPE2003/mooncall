// api/telegram.js
const { bot, ensureDb } = require("../mooncall");

// IMPORTANT: reply immediately so Vercel doesn't time out.
// Do the heavy work after we respond.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, hint: "POST Telegram updates here" });
  }

  // 1) ACK right away
  res.status(200).end("OK");

  // 2) Then, process in background (no await on res)
  try {
    await ensureDb();                // cached mongo connect (fast after first time)
  } catch (e) {
    console.error("ensureDb failed:", e.message);
    // still try to process the update so the bot can at least /start
  }

  try {
    await bot.handleUpdate(req.body);  // let Telegraf handle it
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
};
