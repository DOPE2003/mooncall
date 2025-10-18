require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const callModel = require("./model/call.model");
const Settings = require("./model/settings.model");
const Session = require("./model/session.model");
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

// Admins (unlimited calls)
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

// ---------- Mongo connect (idempotent) ----------
mongoose.set("strictQuery", true);
let mongoOnce;
async function connectMongo() {
  if (mongoOnce) return mongoOnce;
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  mongoOnce = mongoose
    .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
    .then(() => {
      const c = mongoose.connection;
      console.log(`✅ Mongo connected: ${c.host}/${c.name}`);
      c.on("error", (e) => console.error("❌ Mongo error:", e.message));
      c.on("disconnected", () => console.error("⚠️  Mongo disconnected"));
    })
    .catch((e) => {
      mongoOnce = null;
      throw e;
    });
  return mongoOnce;
}

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);

// Fast ACK for callback queries
bot.on("callback_query", async (ctx, next) => {
  ctx.answerCbQuery().catch(() => {});
  return next();
});

// Robust CA extraction (handles “…pump”, text before/after, etc.)
const RE_BSC = /0x[a-fA-F0-9]{40}/;
const RE_SOL = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

function extractCA(text) {
  if (!text) return null;
  const bsc = text.match(RE_BSC)?.[0];
  if (bsc) return { chain: "bsc", addr: bsc.toLowerCase() };
  const sol = text.match(RE_SOL)?.[0];
  if (sol) return { chain: "sol", addr: sol };
  return null;
}

// Start card
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
    `Join: <a href="${chUrl}">${chUrl}</a>`,
  ].join("\n");
}

const RULES_TEXT =
  `📜 <b>Rules</b>
• 1 call per user per 24h (admins bypass).
• Calls are tracked for ${BASE_TRACK_DAYS} days (extends on big pumps).
• Alerts at milestones (x2/x4/x6/x10) and on big drawdowns.
• Best performers climb the leaderboard.`;

// /start
bot.start(async (ctx) => {
  const banner = process.env.START_BANNER_URL;
  const opts = { caption: startCaption(), parse_mode: "HTML", ...startKeyboard() };
  if (banner) await ctx.replyWithPhoto(banner, opts);
  else await ctx.reply(startCaption(), { parse_mode: "HTML", ...startKeyboard() });
});

// Disable media
const NO_MEDIA_TEXT =
  "❌ Media is disabled. Send a token address (Sol SPL mint or BSC 0x…) or use /start.";
[
  "photo","video","document","audio","voice","sticker","animation","video_note",
  "contact","location","venue","dice","poll",
].forEach((t) => bot.on(t, (ctx) => ctx.reply(NO_MEDIA_TEXT).catch(() => {})));

// Commands
bot.command("rules", (ctx) =>
  ctx.reply(RULES_TEXT, { parse_mode: "HTML", disable_web_page_preview: true })
);
bot.command("leaderboard", async (ctx) => {
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { disable_web_page_preview: true });
});
bot.command("mycalls", sendMyCalls);
bot.command("makecall", async (ctx) => {
  const uid = String(ctx.from.id);
  await Session.findOneAndUpdate(
    { userId: uid },
    { $set: { step: "awaiting_ca" }, $currentDate: { updatedAt: true } },
    { upsert: true }
  );
  await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
});
bot.command("cancel", async (ctx) => {
  await Session.deleteOne({ userId: String(ctx.from.id) });
  await ctx.reply("Cancelled.");
});

// Actions
bot.action("cmd:leaderboard", async (ctx) => {
  const rows = await getLeaderboard(10);
  await ctx.reply(formatLeaderboard(rows), { disable_web_page_preview: true });
});
bot.action("cmd:makecall", async (ctx) => {
  const uid = String(ctx.from.id);
  await Session.findOneAndUpdate(
    { userId: uid },
    { $set: { step: "awaiting_ca" }, $currentDate: { updatedAt: true } },
    { upsert: true }
  );
  await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
});
bot.action("cmd:mycalls", sendMyCalls);
bot.action("cmd:rules", (ctx) =>
  ctx.reply(RULES_TEXT, { parse_mode: "HTML", disable_web_page_preview: true })
);
bot.action("cmd:boosted", (ctx) => ctx.reply("Boosted coins coming soon."));

// Channel posting helper
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

// My calls (shows MC at entry vs now)
async function sendMyCalls(ctx) {
  const uid = String(ctx.from.id);
  const items = await callModel.find({ telegramId: uid }).sort({ createdAt: -1 }).limit(3);
  if (!items.length) return ctx.reply("🗂 You have no recent calls.");

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

// Text flow (session persisted in Mongo)
bot.on("text", async (ctx) => {
  const uid = String(ctx.from.id);
  const txt = (ctx.message.text || "").trim();

  if (txt.startsWith("/")) return; // other commands already handled

  const sess = await Session.findOne({ userId: uid });
  if (!sess || sess.step !== "awaiting_ca") {
    return ctx.reply("Use /start or /makecall to begin.");
  }

  const found = extractCA(txt);
  if (!found) {
    await ctx.reply("Invalid address. Send a Sol SPL mint or a BSC 0x… address. Or /cancel.");
    return;
  }

  // enforce cooldown (non-admin)
  const handle = ctx.from?.username ? `@${ctx.from.username}` : null;
  if (!isAdmin(ctx)) {
    const cut = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await callModel.findOne({ telegramId: uid, createdAt: { $gt: cut } });
    if (recent) {
      await Session.deleteOne({ userId: uid });
      return ctx.reply("You already made a call in the last 24h.");
    }
  }

  // Quick feedback to user
  await ctx.reply("✅ Got it. Checking and posting…");

  const chain = found.chain;
  const ca = found.addr;

  const [entryPrice, card] = await Promise.all([
    getPrice(chain, ca).catch(() => null),
    buildCallCard({ chain, addr: ca, handle }),
  ]);
  const entryMc = card?.meta?.marketCap ?? null;

  const now = Date.now();
  await callModel.create({
    telegramId: uid,
    userId: uid,
    callerHandle: handle || null,
    chain,
    mintAddress: ca,
    thesis: "",
    entryPrice: entryPrice ?? 0,
    lastPrice: entryPrice ?? null,
    peakPrice: entryPrice ?? null,
    entryMc,
    nextMilestone: FIRST_MS,
    status: "active",
    nextCheckAt: new Date(now + CHECK_MIN * 60_000),
    expiresAt: new Date(now + BASE_TRACK_DAYS * 86_400_000),
  });

  try {
    if (card) await postToChannel(card.text, card.keyboard, card.photoUrl);
  } catch (e) {
    console.error("Channel post failed:", e.message);
  } finally {
    await Session.deleteOne({ userId: uid });
  }
});

// Export init for webhook
let botInitOnce;
async function initBot() {
  if (botInitOnce) return botInitOnce;
  botInitOnce = (async () => {
    await connectMongo();
    const me = await bot.telegram.getMe().catch(() => null);
    if (me) console.log(`🤖 @${me.username} ready`);
  })();
  return botInitOnce;
}
module.exports.initBot = initBot;
module.exports.bot = bot;

// If run directly (local dev)
if (require.main === module) {
  (async () => {
    await initBot();
    bot.launch().then(() => console.log("Telegram bot launched (polling)"));
  })();
}
