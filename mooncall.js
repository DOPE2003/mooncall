// mooncall.js
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const dbConnect = require("./lib/db");
const Call = require("./model/call.model");
const Settings = require("./model/settings.model");
const { getLeaderboard, formatLeaderboard } = require("./leaderboard");
const { getPrice } = require("./price");
const { buildCallCard, fetchTokenMeta, USD } = require("./card");
const axios = require("axios");

// ----- env & helpers -----
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
const BASE_TRACK_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);
const DEFAULT_MS = (process.env.MILESTONES || "2,4,6,10")
  .split(",").map(s => parseFloat(s.trim())).filter(Number.isFinite).sort((a,b)=>a-b);
const FIRST_MS = DEFAULT_MS.find(m => m > 1) ?? 2;
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(s=>s.trim()).filter(Boolean));
const ADMIN_USERNAMES = new Set((process.env.ADMIN_USERNAMES || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
const isAdmin = (ctx) => ADMIN_IDS.has(String(ctx.from?.id)) ||
  (ctx.from?.username && ADMIN_USERNAMES.has(ctx.from.username.toLowerCase()));

const SOL_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BSC_HEX40 = /^0x[a-fA-F0-9]{40}$/;

// post to channel (HTTP API so works from webhooks & cron)
async function postToChannel(text, keyboard, photoUrl) {
  if (!process.env.ALERTS_CHANNEL_ID) return;
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/` +
              (photoUrl ? "sendPhoto" : "sendMessage");
  const payload = photoUrl ? {
    chat_id: process.env.ALERTS_CHANNEL_ID,
    photo: photoUrl,
    caption: text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard.reply_markup } : {})
  } : {
    chat_id: process.env.ALERTS_CHANNEL_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard.reply_markup } : {})
  };
  await axios.post(url, payload, { timeout: 8000 }).catch(() => {});
}
module.exports.postToChannel = postToChannel;

// ----- bot -----
const bot = new Telegraf(BOT_TOKEN);

// fast ACK to avoid "query too old"
bot.on("callback_query", async (ctx, next) => {
  ctx.answerCbQuery().catch(() => {});
  return next();
});

// disable media
const NO_MEDIA_TEXT = "❌ Media is disabled. Send a token address (Sol SPL mint or BSC 0x…) or use /start.";
[
  "photo","video","document","audio","voice","sticker",
  "animation","video_note","contact","location","venue","dice","poll"
].forEach(t => bot.on(t, ctx => ctx.reply(NO_MEDIA_TEXT).catch(()=>{})));

// start card
function startKeyboard() {
  const chUrl = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
  const boost = process.env.BOOST_URL || chUrl;
  return Markup.inlineKeyboard([
    [Markup.button.url("👥 Community Calls", chUrl)],
    [Markup.button.callback("🏅 Top Callers", "cmd:leaderboard")],
    [Markup.button.callback("🧾 Make a call", "cmd:makecall")],
    [Markup.button.callback("📒 My calls", "cmd:mycalls")],
    [Markup.button.callback("📜 Rules", "cmd:rules")],
    [Markup.button.url("⭐ Subscribe", chUrl)],
    [Markup.button.url("🚀 Boost", boost)],
    [Markup.button.callback("⚡ Boosted Coins", "cmd:boosted")]
  ]);
}
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
    `Join: <a href="${chUrl}">${chUrl}</a>`
  ].join("\n");
}

bot.start(async (ctx) => {
  await dbConnect();
  const banner = process.env.START_BANNER_URL;
  const opts = { caption: startCaption(), parse_mode: "HTML", ...startKeyboard() };
  if (banner) await ctx.replyWithPhoto(banner, opts);
  else await ctx.reply(startCaption(), { parse_mode: "HTML", ...startKeyboard() });
});

// basic commands
const RULES_TEXT = `📜 <b>Rules</b>
• 1 call per user per 24h (admins bypass).
• Calls are tracked for ${BASE_TRACK_DAYS} days (extends on big pumps).
• Alerts at milestones (x2/x4/x6/x10) and big drawdowns.
• Best performers climb the leaderboard.`;

bot.command("rules", ctx => ctx.reply(RULES_TEXT, { parse_mode: "HTML", disable_web_page_preview: true }));

bot.command("leaderboard", async (ctx) => {
  await dbConnect();
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.command("mycalls", async (ctx) => sendMyCalls(ctx));

bot.command("makecall", async (ctx) => {
  sessions.set(String(ctx.from.id), { step: "awaiting_ca" });
  await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
});

bot.command("cancel", async (ctx) => {
  sessions.set(String(ctx.from.id), { step: "idle" });
  await ctx.reply("Cancelled.");
});

// actions (buttons)
bot.action("cmd:leaderboard", async (ctx) => {
  await dbConnect();
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { parse_mode: "HTML", disable_web_page_preview: true });
});
bot.action("cmd:makecall", async (ctx) => {
  sessions.set(String(ctx.from.id), { step: "awaiting_ca" });
  await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
});
bot.action("cmd:mycalls", async (ctx) => sendMyCalls(ctx));
bot.action("cmd:rules", async (ctx) => ctx.reply(RULES_TEXT, { parse_mode: "HTML", disable_web_page_preview: true }));
bot.action("cmd:boosted", async (ctx) => ctx.reply("Boosted coins coming soon."));

// lightweight session
const sessions = new Map(); // key = tgId -> { step }
const setIdle = (id) => sessions.set(id, { step: "idle" });

// message flow
bot.on("text", async (ctx) => {
  await dbConnect();
  const tgId = String(ctx.from.id);
  const handle = ctx.from?.username ? `@${ctx.from.username}` : null;
  const text = (ctx.message.text || "").trim();
  const s = sessions.get(tgId) || { step: "idle" };
  if (text.startsWith("/")) return; // commands handled above

  if (s.step === "awaiting_ca") {
    let chain = null;
    if (BSC_HEX40.test(text)) chain = "bsc";
    else if (SOL_BASE58.test(text)) chain = "sol";
    if (!chain) return ctx.reply("Invalid address. Send a Sol SPL mint or a BSC 0x… address. Or /cancel.");

    if (!isAdmin(ctx)) {
      const cut = new Date(Date.now() - 24*60*60*1000);
      const recent = await Call.findOne({ telegramId: tgId, createdAt: { $gt: cut } });
      if (recent) { setIdle(tgId); return ctx.reply("You already made a call in the last 24h."); }
    }

    const ca = text;
    const [entryPrice, card] = await Promise.all([
      getPrice(chain, ca).catch(()=>null),
      buildCallCard({ chain, addr: ca, handle })
    ]);
    const entryMc = card.meta?.marketCap ?? null;

    const now = Date.now();
    await Call.create({
      telegramId: tgId,
      userId: tgId,
      callerHandle: handle || null,
      chain,
      mintAddress: ca,
      thesis: "",
      entryPrice: entryPrice ?? 0,
      lastPrice: entryPrice ?? null,
      peakPrice: entryPrice ?? null,
      entryMc: entryMc,
      nextMilestone: FIRST_MS,
      status: "active",
      nextCheckAt: new Date(now + CHECK_MIN*60_000),
      expiresAt: new Date(now + (Number(process.env.BASE_TRACK_DAYS||7))*86_400_000)
    });

    try { await postToChannel(card.text, card.keyboard, card.photoUrl); } catch(_) {}
    setIdle(tgId);
    return ctx.reply("✅ Call recorded and posted.");
  }

  await ctx.reply("Use /start or /makecall to begin.");
});

async function sendMyCalls(ctx) {
  await dbConnect();
  const uid = String(ctx.from.id);
  const items = await Call.find({ telegramId: uid }).sort({ createdAt: -1 }).limit(3);
  if (!items.length) return ctx.reply("No recent calls.");

  for (const c of items) {
    const metaNow = await fetchTokenMeta(c.chain, c.mintAddress).catch(()=>null);
    const nowMc = metaNow?.fdv ?? null;
    await ctx.reply(
      [
        `🧾 <b>Your call</b> (${c.callerHandle || (ctx.from.username ? "@"+ctx.from.username : uid)})`,
        `<code>${c.mintAddress}</code>`,
        `MC when called: ${USD(c.entryMc)}`,
        `MC now: ${USD(nowMc)}`
      ].join("\n"), { parse_mode: "HTML" }
    );
  }
}

module.exports.bot = bot;
