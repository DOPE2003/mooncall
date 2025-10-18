// api/telegram.js
require("dotenv").config();
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const TG = axios.create({
  baseURL: `https://api.telegram.org/bot${BOT_TOKEN}`,
  timeout: 8000,
});

// ----- UI helpers -----
function startCaption() {
  const ch = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
  return [
    "<b>Welcome to Mooncall.</b>",
    "",
    "Call tokens, track PnL, and compete for rewards.",
    "",
    "• 1 call per user per day",
    "• Calls tracked by PnL",
    "• Top performers get rewards",
    "",
    `Join: <a href="${ch}">${ch}</a>`,
  ].join("\n");
}

function startKeyboard() {
  const ch = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
  const boost = process.env.BOOST_URL || ch;
  return {
    inline_keyboard: [
      [{ text: "👥 Community Calls", url: ch }],
      [{ text: "🏅 Top Callers", callback_data: "cmd:leaderboard" }],
      [{ text: "🧾 Make a call", callback_data: "cmd:makecall" }],
      [{ text: "📒 My calls", callback_data: "cmd:mycalls" }],
      [{ text: "📜 Rules", callback_data: "cmd:rules" }],
      [{ text: "⭐ Subscribe", url: ch }],
      [{ text: "🚀 Boost", url: boost }],
      [{ text: "⚡ Boosted Coins", callback_data: "cmd:boosted" }],
    ],
  };
}

const RULES =
  "📜 <b>Rules</b>\n• 1 call per user per 24h\n• Calls tracked for 7 days (extends on big pumps)\n• Alerts at x2/x4/x6/x10 and big drawdowns";

// ----- small send helpers -----
async function sendMessage(chat_id, text, extra = {}) {
  return TG.post("/sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  }).catch(() => {});
}

async function sendPhoto(chat_id, photo, caption, extra = {}) {
  return TG.post("/sendPhoto", {
    chat_id,
    photo,
    caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  }).catch(() => {});
}

async function answerCb(id) {
  return TG.post("/answerCallbackQuery", { callback_query_id: id }).catch(() => {});
}

// ----- webhook -----
module.exports = async (req, res) => {
  // GET: quick health
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, hint: "POST updates here" });
  }

  const u = req.body || {};

  // messages (/start etc.)
  if (u.message && u.message.chat) {
    const chatId = u.message.chat.id;
    const text = (u.message.text || "").trim();

    if (text.startsWith("/start")) {
      const banner = process.env.START_BANNER_URL; // optional
      const kb = { reply_markup: startKeyboard() };
      if (banner) {
        await sendPhoto(chatId, banner, startCaption(), kb);
      } else {
        await sendMessage(chatId, startCaption(), kb);
      }
      return res.status(200).json({ ok: true });
    }

    // You can add more commands here if you want:
    // if (text.startsWith("/rules")) await sendMessage(chatId, RULES);

    // Fallback: ignore
    return res.status(200).json({ ok: true });
  }

  // button clicks
  if (u.callback_query) {
    const cq = u.callback_query;
    const chatId = cq.message?.chat?.id;
    const data = cq.data || "";
    await answerCb(cq.id); // fast ACK so Telegram doesn’t timeout

    if (!chatId) return res.status(200).json({ ok: true });

    if (data === "cmd:rules") {
      await sendMessage(chatId, RULES);
    } else if (data === "cmd:leaderboard") {
      await sendMessage(chatId, "🏅 Leaderboard coming soon.");
    } else if (data === "cmd:mycalls") {
      await sendMessage(chatId, "📒 You have no recent calls.");
    } else if (data === "cmd:makecall") {
      await sendMessage(chatId, "Paste the token address (Sol SPL mint or BSC 0x…).");
    } else if (data === "cmd:boosted") {
      await sendMessage(chatId, "⚡ Boosted coins coming soon.");
    }

    return res.status(200).json({ ok: true });
  }

  // ignore everything else
  return res.status(200).json({ ok: true });
};
