// mooncall.js
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");

const callModel = require("./model/call.model");
const Settings = require("./model/settings.model");

const { getLeaderboard, formatLeaderboard } = require("./leaderboard");
const { getPrice } = require("./price");
const { buildCallCard, fetchTokenMeta, USD } = require("./card");

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
const BASE_TRACK_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);
const DEFAULT_MS = (process.env.MILESTONES || "2,4,6,10")
  .split(",")
  .map((s) => parseFloat(s.trim()))
  .filter(Number.isFinite)
  .sort((a, b) => a - b);
const FIRST_MS = DEFAULT_MS.find((m) => m > 1) ?? 2;

// Admin whitelist (unlimited calls)
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

// ---------- Mongo connect (with retry + exportable guard) ----------
mongoose.set("strictQuery", true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mongoReady = false;
async function connectWithRetry() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  for (;;) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      const c = mongoose.connection;
      console.log(`✅ Mongo connected: ${c.host}/${c.name}`);
      c.on("error", (e) => console.error("❌ Mongo error:", e.message));
      c.on("disconnected", () => {
        console.error("⚠️  Mongo disconnected");
        mongoReady = false;
      });
      mongoReady = true;
      return;
    } catch (e) {
      console.error("❌ Mongo connect failed:", e.message);
      console.log("⏳ retrying in 5s…");
      await sleep(5000);
    }
  }
}
async function ensureDb() {
  if (mongoReady) return;
  await connectWithRetry();
}
module.exports.ensureDb = ensureDb;

// ---------- Bot (disable waiting for webhook HTTP reply) ----------
const bot = new Telegraf(BOT_TOKEN, { telegram: { webhookReply: false } });
module.exports.bot = bot;

// Fast ACK for ALL callback queries (prevents “query is too old”)
bot.on("callback_query", async (ctx, next) => {
  ctx.answerCbQuery().catch(() => {});
  return next();
});

// Detect chain by address
const SOL_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BSC_HEX40 = /^0x[a-fA-F0-9]{40}$/;

// ---------- Start card ----------
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

const RULES_TEXT =
  `📜 <b>Rules</b>
• 1 call per user per 24h (admins bypass).
• Calls are tracked for ${BASE_TRACK_DAYS} days (extends on big pumps).
• Alerts at milestones (x2/x4/x6/x10) and on big drawdowns.
• Best performers climb the leaderboard.`;

// ---------- very light in-memory session ----------
const sessions = new Map(); // key = tgId -> { step, ca, chain }
const setIdle = (id) => sessions.set(id, { step: "idle" });

// /start
bot.start(async (ctx) => {
  const banner = process.env.START_BANNER_URL;
  const opts = { caption: startCaption(), parse_mode: "HTML", ...startKeyboard() };
  if (banner) await ctx.replyWithPhoto(banner, opts);
  else await ctx.reply(startCaption(), { parse_mode: "HTML", ...startKeyboard() });
});

// ---------- DISABLE MEDIA ----------
const NO_MEDIA_TEXT =
  "❌ Media is disabled. Please send a token address (Sol SPL mint or BSC 0x…) or use /start.";

const MEDIA_TYPES = [
  "photo",
  "video",
  "document",
  "audio",
  "voice",
  "sticker",
  "animation",
  "video_note",
  "contact",
  "location",
  "venue",
  "dice",
  "poll",
];

for (const t of MEDIA_TYPES) {
  bot.on(t, async (ctx) => {
    try {
      await ctx.reply(NO_MEDIA_TEXT);
    } catch (_) {}
  });
}

// ---------- Commands ----------
bot.command("rules", async (ctx) => {
  await ctx.reply(RULES_TEXT, { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.command("leaderboard", async (ctx) => {
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { disable_web_page_preview: true });
});

bot.command("stats", async (ctx) => {
  const uid = String(ctx.from.id);
  const calls = await callModel
    .find({ telegramId: uid })
    .sort({ createdAt: -1 })
    .limit(100);
  if (!calls.length) return ctx.reply("No calls yet. Use /makecall to start.");

  let bestX = 1,
    sumX = 0,
    n = 0;
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

bot.command("mycalls", async (ctx) => {
  await sendMyCalls(ctx);
});

async function sendMyCalls(ctx) {
  const uid = String(ctx.from.id);
  const items = await callModel
    .find({ telegramId: uid })
    .sort({ createdAt: -1 })
    .limit(3);

  if (!items.length) return ctx.reply("No recent calls.");

  for (const c of items) {
    const chain = c.chain;
    const addr = c.mintAddress;

    const metaNow = await fetchTokenMeta(chain, addr).catch(() => null);
    const nowMc = metaNow?.marketCap ?? null;
    const entryMc = c.entryMc ?? null;

    await ctx.reply(
      [
        `🧾 <b>Your call</b> (${c.callerHandle || (ctx.from.username ? "@" + ctx.from.username : uid)})`,
        `<code>${addr}</code>`,
        `MC when called: ${USD(entryMc)}`,
        `MC now: ${USD(nowMc)}`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  }
}

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

// Admin toggles
bot.command("setmilestones", async (ctx) => {
  const isAdm =
    ADMIN_IDS.has(String(ctx.from?.id)) ||
    (ctx.from?.username && ADMIN_USERNAMES.has(ctx.from.username.toLowerCase()));
  if (!isAdm) return;

  const arg = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  const arr = arg
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!arr.length) return ctx.reply("Usage: /setmilestones 2,4,6,10");
  await Settings.findByIdAndUpdate(
    "global",
    { $set: { milestones: arr } },
    { upsert: true }
  );
  await ctx.reply(`Milestones updated: ${arr.join("×, ")}×`);
});

bot.command("setinterval", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const m = parseInt((ctx.message.text || "").split(" ")[1], 10);
  if (!Number.isFinite(m) || m < 1) return ctx.reply("Usage: /setinterval 15");
  await Settings.findByIdAndUpdate(
    "global",
    { $set: { checkIntervalMinutes: m } },
    { upsert: true }
  );
  await ctx.reply(`Worker interval set to ${m} min. (applies on next tick)`);
});

bot.command("pauseworker", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await Settings.findByIdAndUpdate("global", { $set: { paused: true } }, { upsert: true });
  await ctx.reply("Worker paused ✅");
});
bot.command("resumeworker", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await Settings.findByIdAndUpdate("global", { $set: { paused: false } }, { upsert: true });
  await ctx.reply("Worker resumed ▶️");
});

// ---------- Buttons under /start ----------
bot.action("cmd:leaderboard", async (ctx) => {
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { disable_web_page_preview: true });
});

bot.action("cmd:makecall", async (ctx) => {
  sessions.set(String(ctx.from.id), { step: "awaiting_ca" });
  await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
});

bot.action("cmd:mycalls", async (ctx) => {
  await sendMyCalls(ctx);
});

bot.action("cmd:rules", async (ctx) => {
  await ctx.reply(RULES_TEXT, { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.action("cmd:boosted", async (ctx) => {
  await ctx.reply("Boosted coins coming soon.");
});

// ---------- Post to channel (exported) ----------
async function postToChannel(text, keyboard, photoUrl) {
  const chat = process.env.ALERTS_CHANNEL_ID;
  if (!chat) throw new Error("ALERTS_CHANNEL_ID missing");
  const common = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard?.reply_markup ? { reply_markup: keyboard.reply_markup } : {}),
  };
  if (photoUrl) await bot.telegram.sendPhoto(chat, photoUrl, { caption: text, ...common });
  else await bot.telegram.sendMessage(chat, text, common);
}
module.exports.postToChannel = postToChannel;

// ---------- Text flow (sanitized CA; admin bypass 24h rule) ----------
bot.on("text", async (ctx) => {
  const tgId = String(ctx.from.id);
  const handle = ctx.from?.username ? `@${ctx.from.username}` : null;
  const raw = (ctx.message.text || "").trim();

  // Ignore commands here (handled above)
  if (raw.startsWith("/")) return;

  const s = sessions.get(tgId) || { step: "idle" };

  if (s.step === "awaiting_ca") {
    // keep ONLY the first token; users often paste “… pump”
    const text = raw.split(/\s+/)[0];

    let chain = null;
    if (BSC_HEX40.test(text)) chain = "bsc";
    else if (SOL_BASE58.test(text)) chain = "sol";
    if (!chain)
      return ctx.reply(
        "Invalid address. Send a Sol SPL mint or a BSC 0x… address. Or /cancel."
      );

    if (!isAdmin(ctx)) {
      const cut = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await callModel.findOne({
        telegramId: tgId,
        createdAt: { $gt: cut },
      });
      if (recent) {
        setIdle(tgId);
        return ctx.reply("You already made a call in the last 24h.");
      }
    }

    const ca = text;

    const [entryPrice, card] = await Promise.all([
      getPrice(chain, ca).catch(() => null),
      buildCallCard({ chain, addr: ca, handle }),
    ]);
    const entryMc = card?.meta?.marketCap ?? null;

    const now = Date.now();
    await callModel.create({
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
      nextCheckAt: new Date(now + CHECK_MIN * 60_000),
      expiresAt: new Date(now + BASE_TRACK_DAYS * 86_400_000),
    });

    try {
      await postToChannel(card.text, card.keyboard, card.photoUrl);
    } catch (e) {
      console.error("Channel post failed:", e.message);
    }

    setIdle(tgId);
    await ctx.reply("✅ Call recorded and posted.");
    return;
  }

  await ctx.reply("Use /start or /makecall to begin.");
});

// ---------- Local-only launcher (NOT used on Vercel) ----------
async function initiateMooncallBot() {
  await ensureDb();
  const me = await bot.telegram.getMe().catch(() => null);
  if (me) console.log(`🤖 @${me.username} ready`);
  bot.launch().then(() => console.log("Telegram bot launched (local dev)"));
}
module.exports.initiateMooncallBot = initiateMooncallBot;

if (require.main === module) {
  initiateMooncallBot();
}
