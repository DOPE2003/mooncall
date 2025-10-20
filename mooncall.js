// mooncall.js
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { Telegraf, Markup } = require("telegraf");

// 🔌 single shared Mongo connection
require("./model/db");

const callModel = require("./model/call.model");
const Settings = require("./model/settings.model");

const { getPrice } = require("./price");
const { getLeaderboard, formatLeaderboard } = require("./leaderboard");
const { buildCallCard, fetchTokenMeta, USD } = require("./card");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const ALERTS_CHANNEL_ID = process.env.ALERTS_CHANNEL_ID; // fallback if no runtime override
if (!ALERTS_CHANNEL_ID) console.warn("ALERTS_CHANNEL_ID missing (channel posts will fail)");

const RAW_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
const FIRST_CHECK_MIN = Math.max(1, Math.min(RAW_MIN, 5)); // ensure first recheck happens quickly (1–5m)
const BASE_TRACK_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);

const DEFAULT_MS = (process.env.MILESTONES || "2,4,6,10")
  .split(",")
  .map((s) => parseFloat(s.trim()))
  .filter(Number.isFinite)
  .sort((a, b) => a - b);
const FIRST_MS = DEFAULT_MS.find((m) => m > 1) ?? 2;

// Admin allowlists
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const isAdmin = (ctx) =>
  ADMIN_IDS.has(String(ctx.from?.id)) ||
  (ctx.from?.username && ADMIN_USERNAMES.has(ctx.from.username.toLowerCase()));

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);

// Always ACK callback queries fast (prevents “query is too old” errors)
bot.on("callback_query", async (ctx, next) => {
  ctx.answerCbQuery().catch(() => {});
  return next();
});

// Validators
const SOL_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BSC_HEX40 = /^0x[a-fA-F0-9]{40}$/;

// Minimal in-memory session
const sessions = new Map(); // tgId -> { step, chain, ca }
const setIdle = (id) => sessions.set(id, { step: "idle" });

// ----- /start card -----
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
    [Markup.button.callback("⚡ Boosted Coins", "cmd:boosted")],
  ]);
}

function startCaption() {
  const chUrl = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
  return [
    "<b>Welcome to Mooncall bot.</b>",
    "",
    "Call tokens, track PnL, and compete for rewards.",
    "",
    "» Each user can make 1 call per day",
    "» Calls are tracked by PnL performance",
    "» The top performer gets rewards + bragging rights",
    "",
    `⚡ <a href="${chUrl}">Telegram Channel</a>`,
  ].join("\n");
}

const RULES_TEXT = (days) => `📜 <b>Rules</b>
• 1 call per user per 24h (admins bypass).
• Calls are tracked for ${days} days (extends on big pumps).
• Alerts at milestones (x2/x4/x6/x10).
• Best performers climb the leaderboard.`;

// ----- disable media completely -----
const NO_MEDIA_TEXT =
  "❌ Media is disabled. Send a token address (Sol SPL mint or BSC 0x…) or use /start.";

[
  "photo","video","document","audio","voice","sticker","animation",
  "video_note","contact","location","venue","dice","poll",
].forEach((t) => bot.on(t, async (ctx) => { try { await ctx.reply(NO_MEDIA_TEXT); } catch (_) {} }));

// ----- commands -----
bot.start(async (ctx) => {
  const banner = process.env.START_BANNER_URL;
  const opts = { caption: startCaption(), parse_mode: "HTML", ...startKeyboard() };
  if (banner) await ctx.replyWithPhoto(banner, opts);
  else await ctx.reply(startCaption(), { parse_mode: "HTML", ...startKeyboard() });
});

bot.command("rules", async (ctx) =>
  ctx.reply(RULES_TEXT(BASE_TRACK_DAYS), { parse_mode: "HTML", disable_web_page_preview: true })
);

bot.command("leaderboard", async (ctx) => {
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { disable_web_page_preview: true });
});

bot.command("stats", async (ctx) => {
  const uid = String(ctx.from.id);
  const calls = await callModel.find({ telegramId: uid }).sort({ createdAt: -1 }).limit(100);
  if (!calls.length) return ctx.reply("No calls yet. Use /makecall to start.");

  let bestX = 1, sumX = 0, n = 0;
  for (const c of calls) {
    const e = c.entryPrice || 0;
    const cur = c.lastPrice || e;
    if (e > 0) {
      const x = cur / e;
      bestX = Math.max(bestX, x);
      sumX += x;
      n++;
    }
  }
  const avgX = n ? sumX / n : 1;
  const lines = [
    `📊 <b>Your stats</b> (${ctx.from.username ? "@" + ctx.from.username : uid})`,
    `Total calls: ${calls.length}`,
    `Best X: ${bestX.toFixed(2)}×`,
    `Average X: ${avgX.toFixed(2)}×`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

bot.command("mycalls", async (ctx) => sendMyCalls(ctx));

bot.command("makecall", async (ctx) => {
  const id = String(ctx.from.id);
  setIdle(id);
  sessions.set(id, { step: "awaiting_ca" });
  await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
});

bot.command("cancel", async (ctx) => {
  setIdle(String(ctx.from.id));
  await ctx.reply("Cancelled.");
});

// ----- Admin toggles / settings -----
bot.command("setmilestones", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  const arr = arg
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!arr.length) return ctx.reply("Usage: /setmilestones 2,4,6,10");
  await Settings.findByIdAndUpdate("global", { $set: { milestones: arr } }, { upsert: true });
  await ctx.reply(`Milestones updated: ${arr.join("×, ")}×`);
});

bot.command("setinterval", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const m = parseInt((ctx.message.text || "").split(" ")[1], 10);
  if (!Number.isFinite(m) || m < 1) return ctx.reply("Usage: /setinterval 5");
  await Settings.findByIdAndUpdate(
    "global",
    { $set: { checkIntervalMinutes: m } },
    { upsert: true }
  );
  await ctx.reply(`Worker interval set to ${m} min. (applies on next tick)`);
});

bot.command("pauseworker", (ctx) =>
  isAdmin(ctx) &&
  Settings.findByIdAndUpdate("global", { $set: { paused: true } }, { upsert: true }).then(() =>
    ctx.reply("Worker paused ✅")
  )
);

bot.command("resumeworker", (ctx) =>
  isAdmin(ctx) &&
  Settings.findByIdAndUpdate("global", { $set: { paused: false } }, { upsert: true }).then(() =>
    ctx.reply("Worker resumed ▶️")
  )
);

// Change channel at runtime (optional)
bot.command("setchannel", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = (ctx.message.text || "").split(/\s+/)[1];
  if (!id || !/^(-?\d+)$/.test(id)) return ctx.reply("Send: /setchannel -100XXXXXXXXXXXX");
  await Settings.findByIdAndUpdate("global", { $set: { channelId: id } }, { upsert: true });
  await ctx.reply(`Channel updated to ${id}`);
});

// ----- start buttons -----
bot.action("cmd:leaderboard", async (ctx) => {
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { disable_web_page_preview: true });
});

bot.action("cmd:makecall", async (ctx) => {
  sessions.set(String(ctx.from.id), { step: "awaiting_ca" });
  await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
});

bot.action("cmd:mycalls", async (ctx) => sendMyCalls(ctx));

bot.action("cmd:rules", async (ctx) =>
  ctx.reply(RULES_TEXT(BASE_TRACK_DAYS), { parse_mode: "HTML", disable_web_page_preview: true })
);

bot.action("cmd:boosted", async (ctx) => ctx.reply("Boosted coins coming soon."));

// ----- Channel posting helper (used here & by worker) -----
async function postToChannel(text, keyboard, photoUrl) {
  // allow runtime override via Settings.channelId
  let chatId = ALERTS_CHANNEL_ID;
  try {
    const s = await Settings.findById("global").lean().catch(() => null);
    if (s?.channelId) chatId = s.channelId;
  } catch (_) {}

  if (!chatId) throw new Error("ALERTS_CHANNEL_ID missing");

  const common = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard?.reply_markup ? { reply_markup: keyboard.reply_markup } : {}),
  };

  if (photoUrl) {
    await bot.telegram.sendPhoto(chatId, photoUrl, { caption: text, ...common });
  } else {
    await bot.telegram.sendMessage(chatId, text, common);
  }
}
module.exports.postToChannel = postToChannel;

// ----- /mycalls: single list with tickers + MCs -----
async function sendMyCalls(ctx) {
  const uid = String(ctx.from.id);

  const items = await callModel
    .find({ telegramId: uid })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  if (!items.length) return ctx.reply("No calls yet.");

  const rows = [];
  for (const c of items) {
    const metaNow = await fetchTokenMeta(c.chain, c.mintAddress).catch(() => null);
    const symbol =
      metaNow?.symbol ||
      c.symbol ||
      (c.chain === "bsc" ? "BSC" : "SOL");

    const entryMc = c.entryMc ?? null;          // stored when call posted (card builder)
    const nowMc = metaNow?.marketCap ?? null;   // live

    const delta =
      entryMc && nowMc && entryMc > 0
        ? (((nowMc - entryMc) / entryMc) * 100).toFixed(1)
        : null;

    rows.push(
      `• <b>$${symbol}</b>\n` +
      `   MC when called: ${USD(entryMc)}\n` +
      `   MC now: ${USD(nowMc)}${delta !== null ? ` (${delta >= 0 ? "+" : ""}${delta}%)` : ""}`
    );
  }

  const header = `🧾 <b>Your calls</b> (${ctx.from.username ? "@" + ctx.from.username : uid})`;
  const text = [header, "", ...rows].join("\n");

  return ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true });
}

// ----- text flow (no thesis) -----
bot.on("text", async (ctx) => {
  const tgId = String(ctx.from.id);
  const handle = ctx.from?.username ? `@${ctx.from.username}` : null;
  const text = (ctx.message.text || "").trim();
  const s = sessions.get(tgId) || { step: "idle" };

  if (text.startsWith("/")) return;

  if (s.step === "awaiting_ca") {
    let chain = null;
    if (BSC_HEX40.test(text)) chain = "bsc";
    else if (SOL_BASE58.test(text)) chain = "sol";

    if (!chain) {
      return ctx.reply("Invalid address. Send a Sol SPL mint or a BSC 0x… address. Or /cancel.");
    }

    // Daily limit unless admin
    if (!isAdmin(ctx)) {
      const cut = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await callModel.findOne({ telegramId: tgId, createdAt: { $gt: cut } });
      if (recent) {
        setIdle(tgId);
        return ctx.reply("You already made a call in the last 24h.");
      }
    }

    const ca = text;

    // Prepare card + attempt an entry price (worker seeds later if null)
    const [entryPrice, card] = await Promise.all([
      getPrice(chain, ca).catch(() => null),
      buildCallCard({ chain, addr: ca, handle }),
    ]);
    const entryMc = card.meta?.marketCap ?? null;

    const now = Date.now();
    await callModel.create({
      telegramId: tgId,
      userId: tgId,
      callerHandle: handle || null,
      chain,
      mintAddress: ca,
      thesis: "",
      entryPrice: entryPrice ?? 0,          // worker will seed if 0
      lastPrice: entryPrice ?? null,
      peakPrice: entryPrice ?? null,
      entryMc: entryMc,
      nextMilestone: FIRST_MS,
      status: "active",
      nextCheckAt: new Date(now + FIRST_CHECK_MIN * 60_000), // fast first check
      expiresAt: new Date(now + BASE_TRACK_DAYS * 86_400_000),
    });

    try {
      await postToChannel(card.text, card.keyboard, card.photoUrl);
    } catch (e) {
      console.error("Channel post failed:", e.message);
      await ctx.reply("✅ Call recorded, but channel post failed. Check bot admin & ALERTS_CHANNEL_ID.");
      setIdle(tgId);
      return;
    }

    setIdle(tgId);
    await ctx.reply("✅ Call recorded and posted.");
    return;
  }

  await ctx.reply("Use /start or /makecall to begin.");
});

// ----- bootstrap -----
async function initiateMooncallBot() {
  const me = await bot.telegram.getMe().catch(() => null);
  if (me) console.log(`🤖 @${me.username} ready`);
  await bot.launch();
  console.log("Telegram bot launched");
}

module.exports.initiateMooncallBot = initiateMooncallBot;
module.exports.bot = bot;
module.exports.Settings = Settings; // (optional) if you need externally
module.exports.postToChannel = postToChannel;

// Run directly
if (require.main === module) {
  initiateMooncallBot();
}
