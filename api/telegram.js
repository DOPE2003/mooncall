// api/telegram.js — minimal webhook (no Telegraf), replies to /start
const axios = require("axios");
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("BOT_TOKEN missing");

async function send(chat_id, text, extra = {}) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  await axios.post(url, { chat_id, text, parse_mode: "Markdown", ...extra }, { timeout: 8000 });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      // So a GET to this URL returns 200 (helps debugging + Telegram health)
      return res.status(200).json({ ok: true, hint: "POST updates here" });
    }
    const upd = req.body || {};
    const msg = upd.message || upd.edited_message;

    if (msg?.chat?.id && typeof msg.text === "string") {
      const chatId = msg.chat.id;
      const text   = msg.text.trim();

      if (/^\/start\b/.test(text)) {
        const community = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
        await send(
          chatId,
          "Welcome to *Mooncall*.\n\n" +
          "Call tokens, track PnL, and compete for rewards.\n\n" +
          "• 1 call per user per day\n" +
          "• Calls tracked by PnL\n" +
          "• Top performers get rewards\n\n" +
          "Join: " + community,
          { disable_web_page_preview: true }
        );
        return res.status(200).json({ ok: true });
      }

      await send(chatId, "Use `/call <MINT_OR_0x>` to submit a call.", { disable_web_page_preview: true });
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("webhook error:", e?.response?.data || e.message);
    // Always 200 so Telegram doesn't spam retries
    return res.status(200).json({ ok: true, note: "handled with error" });
  }
};
