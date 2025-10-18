// api/telegram.js
const { getBot } = require("../mooncall");

module.exports = async (req, res) => {
  // Health check / sanity
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST updates here" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const bot = getBot();
    await bot.handleUpdate(req.body);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("telegram webhook error:", err);
    // Always 200 to avoid Telegram retry storm
    return res.status(200).json({ ok: true });
  }
};
