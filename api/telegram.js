// api/telegram.js (Node runtime)
// Fast UX + tolerant address extraction + start buttons + media guard

export const config = {
  runtime: "nodejs", // stable with long external calls
};

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// tolerant patterns: find first token-looking chunk anywhere in the message
const RE_SOL_ANY = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;  // Base58, 32..44 chars
const RE_BSC_ANY = /0x[a-fA-F0-9]{40}/g;

function startCaption() {
  const chUrl = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
  return [
    "Welcome to <b>Mooncall</b>.",
    "",
    "Call tokens, track PnL, and compete for rewards.",
    "",
    "• 1 call per user per day",
    "• Calls tracked by PnL",
    "• Top performers get rewards",
    "",
    `Join: <a href="${chUrl}">${chUrl}</a>`,
  ].join("\n");
}

function startKeyboard() {
  const chUrl = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
  const boost = process.env.BOOST_URL || chUrl;
  return {
    inline_keyboard: [
      [{ text: "👥 Community Calls", url: chUrl }],
      [{ text: "🏅 Top Callers", callback_data: "cmd:leaderboard" }],
      [{ text: "🧾 Make a call", callback_data: "cmd:makecall" }],
      [{ text: "📒 My calls", callback_data: "cmd:mycalls" }],
      [{ text: "📜 Rules", callback_data: "cmd:rules" }],
      [{ text: "⭐ Subscribe", url: chUrl }],
      [{ text: "🚀 Boost", url: boost }],
      [{ text: "⚡ Boosted Coins", callback_data: "cmd:boosted" }],
    ],
  };
}

// --- small helpers ---
async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

async function sendMsg(chat_id, text, extra = {}) {
  return tg("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function sendPhoto(chat_id, photo, caption, extra = {}) {
  return tg("sendPhoto", {
    chat_id,
    photo,
    caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

function extractAddress(text) {
  if (!text) return null;
  const mB = text.match(RE_BSC_ANY);
  const mS = text.match(RE_SOL_ANY);
  return (mB && mB[0]) || (mS && mS[0]) || null;
}

function isMediaUpdate(u) {
  const m = u?.message;
  if (!m) return false;
  return Boolean(
    m.photo || m.video || m.document || m.audio || m.voice ||
    m.sticker || m.animation || m.video_note || m.location ||
    m.contact || m.venue || m.dice || m.poll
  );
}

// --- main handler ---
export default async function handler(req) {
  const update = await req.json().catch(() => ({}));

  // Always ack callback queries quickly
  if (update?.callback_query?.id) {
    tg("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => {});
  }

  // --- Media guard ---
  if (isMediaUpdate(update)) {
    const chatId = update.message.chat.id;
    await sendMsg(chatId, "❌ Media disabled. Paste a token address (Sol mint or BSC 0x…).");
    return jsonOK();
  }

  // --- /start flow ---
  if (update?.message?.text?.startsWith("/start")) {
    const chatId = update.message.chat.id;
    const banner = process.env.START_BANNER_URL;
    const kb = { reply_markup: startKeyboard() };
    if (banner) await sendPhoto(chatId, banner, startCaption(), kb);
    else await sendMsg(chatId, startCaption(), kb);
    return jsonOK();
  }

  // --- Buttons (callbacks) ---
  if (update?.callback_query?.data) {
    const data = update.callback_query.data;
    const chatId = update.callback_query.message.chat.id;
    const from = update.callback_query.from || {};
    const uid = String(from.id);

    if (data === "cmd:leaderboard") {
      // lightweight proxy to existing API if you have it, otherwise stub:
      await sendMsg(chatId, "🏅 Leaderboard coming soon.");
      return jsonOK();
    }

    if (data === "cmd:makecall") {
      await sendMsg(chatId, "Paste the token address (Sol SPL mint or BSC 0x…).");
      return jsonOK();
    }

    if (data === "cmd:mycalls") {
      // delegate to your existing /api/mycalls if present; here a minimal stub
      await sendMsg(chatId, "🧾 You have no recent calls.");
      return jsonOK();
    }

    if (data === "cmd:rules") {
      const BASE_TRACK_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);
      const rules = [
        "📜 <b>Rules</b>",
        "• 1 call per user per 24h (admins bypass)",
        `• Calls tracked for ${BASE_TRACK_DAYS} days (extends on big pumps)`,
        "• Alerts at x2/x4/x6/x10 and on big drawdowns",
        "• Best performers climb the leaderboard",
      ].join("\n");
      await sendMsg(chatId, rules);
      return jsonOK();
    }

    if (data === "cmd:boosted") {
      await sendMsg(chatId, "⚡ Leaderboard coming soon.");
      return jsonOK();
    }

    // Unknown button
    return jsonOK();
  }

  // --- Plain text: tolerant address capture ---
  if (update?.message?.chat?.id) {
    const chatId = update.message.chat.id;
    const text = (update.message.text || "").trim();
    const from = update.message.from || {};

    // ignore commands here (handled above)
    if (text.startsWith("/")) return jsonOK();

    const address = extractAddress(text);
    if (address) {
      // immediate feedback (fast!)
      await sendMsg(chatId, "Got it, posting your call… ⏳");

      // do the heavy work through internal API (will post to channel)
      const origin = new URL(req.url).origin;
      const resp = await fetch(`${origin}/api/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal": process.env.INTERNAL_API_SECRET || "",
        },
        body: JSON.stringify({
          tgId: String(from.id),
          username: from.username || null,
          address,
        }),
      }).catch(() => null);

      let j = null;
      if (resp) { try { j = await resp.json(); } catch {} }

      if (j?.ok) {
        await sendMsg(chatId, "✅ Call recorded and posted.");
      } else {
        await sendMsg(
          chatId,
          `❌ ${j?.error || "Could not create the call. Try again later."}`
        );
      }
      return jsonOK();
    }

    // no address found -> help the user
    await sendMsg(
      chatId,
      "Paste the token address (Sol SPL mint or BSC 0x…), or press “🧾 Make a call”."
    );
    return jsonOK();
  }

  return jsonOK();
}

function jsonOK() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
}
