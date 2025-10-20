// mooncall.js
require("dotenv").config();
require("./model/db");

const { Telegraf, Markup } = require("telegraf");
const Call = require("./model/call.model");
const { getPriceAndMc, isSol, isEvm } = require("./price");

const bot = new Telegraf(process.env.BOT_TOKEN);
const CH_ID = process.env.ALERTS_CHANNEL_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const pending = new Map(); // simple in-memory "await CA" state

const fmtUSD = (n) =>
  n === null || n === undefined
    ? "—"
    : "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

const shorten = (s) => (s.length <= 10 ? s : s.slice(0, 4) + "…" + s.slice(-4));

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📣 Community Calls", "cmd:open_channel")],
    [
      Markup.button.callback("🏅 Top Callers", "cmd:top"),
      Markup.button.callback("📞 Make a call", "cmd:make"),
    ],
    [
      Markup.button.callback("📋 My calls", "cmd:mycalls"),
      Markup.button.callback("📜 Rules", "cmd:rules"),
    ],
  ]);
}

bot.start(async (ctx) => {
  const text = [
    "Welcome to Mooncall bot.",
    "",
    "Call tokens, track PnL, and compete for rewards.",
    "",
    "» Each user can make 1 call per day",
    "» Calls are tracked by PnL performance",
    "» The top performer gets rewards + bragging rights",
    "",
    "⚡ <a href=\"" +
      (process.env.COMMUNITY_CHANNEL_URL || "https://t.me/") +
      "\">Telegram</a>",
  ].join("\n");

  await ctx.reply(text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...mainKeyboard(),
  });
});

// Buttons
bot.action("cmd:open_channel", async (ctx) => {
  await ctx.answerCbQuery();
  const url = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/";
  await ctx.reply(`Open channel: ${url}`);
});

bot.action("cmd:rules", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    [
      "📜 Rules:",
      "• One call per 24h per user (admins bypass).",
      "• Paste a valid SOL mint or BSC 0x address.",
      "• PnL/MC updates are tracked automatically.",
      "• Milestones: " + (process.env.MILESTONES || "2,4,6,10"),
    ].join("\n")
  );
});

bot.action("cmd:make", async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(String(ctx.from.id), true);
  await ctx.reply("Paste the token address (SOL mint 32–44 chars or BSC 0x...).");
});

bot.action("cmd:mycalls", async (ctx) => {
  await ctx.answerCbQuery();
  const tgId = String(ctx.from.id);
  const calls = await Call.find({ tgId }).sort({ createdAt: -1 }).limit(50);

  if (!calls.length) return ctx.reply("You have no calls yet.");

  const lines = ["🧾 Your calls (@" + (ctx.from.username || "unknown") + ")", ""];
  for (const c of calls) {
    const title = c.ticker ? `$${c.ticker}` : shorten(c.ca);
    const now = c.lastMcUsd ? `${fmtUSD(c.lastMcUsd)}` : "—";
    lines.push(
      `• ${title}\n   MC when called: ${fmtUSD(c.entryMcUsd)}\n   MC now: ${now}`
    );
  }
  await ctx.reply(lines.join("\n"));
});

// Text handler: capture CA after /makecall
bot.on("text", async (ctx) => {
  const uid = String(ctx.from.id);
  if (!pending.get(uid)) return;

  const raw = (ctx.message.text || "").trim();
  if (!isSol(raw) && !isEvm(raw)) {
    return ctx.reply("That doesn't look like a SOL mint or BSC contract. Try again.");
  }

  // 24h limit by tgId (admins bypass)
  const isAdmin = ADMIN_IDS.includes(uid);
  if (!isAdmin) {
    const cut = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await Call.findOne({ tgId: uid, createdAt: { $gt: cut } });
    if (recent) {
      pending.delete(uid);
      return ctx.reply("You already made a call in the last 24h. Try again tomorrow.");
    }
  }

  const chain = isSol(raw) ? "sol" : "bsc";

  // price + marketcap
  const info = await getPriceAndMc(raw, chain);
  if (!info.priceUsd || !info.mcUsd) {
    return ctx.reply("Price unavailable at the moment. Try again in a few minutes.");
  }

  const handle = ctx.from.username || null;

  const call = await Call.create({
    tgId: uid,
    handle,
    ca: raw,
    chain,
    ticker: info.ticker || "",
    entryPriceUsd: info.priceUsd,
    entryMcUsd: info.mcUsd,
    lastPriceUsd: info.priceUsd,
    lastMcUsd: info.mcUsd,
    peakMcUsd: info.mcUsd,
    milestonesHit: {},
  });

  pending.delete(uid);

  // confirm
  const title = call.ticker ? `$${call.ticker}` : shorten(call.ca);
  await ctx.reply(
    [
      "✅ Call saved!",
      `Token: ${title}`,
      `Called MC: ${fmtUSD(call.entryMcUsd)}`,
      `We’ll track it & alert milestones.`,
    ].join("\n")
  );
});

bot.catch((e) => console.error("bot error", e));
bot.launch().then(() => console.log("@mooncall_bot ready"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
