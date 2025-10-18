export const config = { runtime: "edge", regions: ["fra1"] }; // pick the closest region

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

async function tg(method, body) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}
const ackCb = (id) => tg("answerCallbackQuery", { callback_query_id: id });
const sendMsg = (chat_id, text, extra = {}) =>
  tg("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
const sendPhoto = (chat_id, photo, caption, extra = {}) =>
  tg("sendPhoto", {
    chat_id,
    photo,
    caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });

export default async function handler(req) {
  // GET → health check (also lets you open the URL in a browser)
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: true, hint: "POST updates here" }), {
      headers: { "content-type": "application/json" },
    });
  }

  let update;
  try { update = await req.json(); } catch { update = {}; }

  // message: /start
  if (update?.message?.chat?.id) {
    const chatId = update.message.chat.id;
    const text = (update.message.text || "").trim();

    if (text.startsWith("/start")) {
      const banner = process.env.START_BANNER_URL;
      const kb = { reply_markup: startKeyboard() };
      if (banner) await sendPhoto(chatId, banner, startCaption(), kb);
      else await sendMsg(chatId, startCaption(), kb);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    // ignore other texts for now
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  // callback buttons
  if (update?.callback_query?.id) {
    const cq = update.callback_query;
    // ACK quickly; don't wait for the rest
    ackCb(cq.id);

    const chatId = cq.message?.chat?.id;
    if (chatId) {
      switch (cq.data) {
        case "cmd:rules":
          await sendMsg(chatId, "📜 <b>Rules</b>\n• 1 call per user per 24h\n• Calls tracked for 7 days (extends on pumps)\n• Alerts at x2/x4/x6/x10 and big drawdowns");
          break;
        case "cmd:leaderboard":
          await sendMsg(chatId, "🏅 Leaderboard coming soon.");
          break;
        case "cmd:mycalls":
          await sendMsg(chatId, "📒 You have no recent calls.");
          break;
        case "cmd:makecall":
          await sendMsg(chatId, "Paste the token address (Sol SPL mint or BSC 0x…).");
          break;
        case "cmd:boosted":
          await sendMsg(chatId, "⚡ Boosted coins coming soon.");
          break;
      }
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
}
