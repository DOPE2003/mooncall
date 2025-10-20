// mooncall.js
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
require("./model/db"); // ensures Mongo connects
const Call = require("./model/call.model");

// --- ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || "your_bot";
const COMMUNITY_CHANNEL_URL = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/your_channel";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing in .env");

const bot = new Telegraf(BOT_TOKEN);

// ---------- helpers ----------
const fmt = new Intl.NumberFormat("en-US");
const money = (n) => (n == null ? "—" : `$${fmt.format(Math.round(n))}`);
const xfmt = (x) => (x == null ? "—" : `${x.toFixed(2)}×`);
const mention = (handle, id) => (handle ? `@${handle}` : `tg://user?id=${id}`);

function startCard() {
  const text =
`Welcome to Mooncall bot.

Call tokens, track PnL, and compete for rewards.

» Each user can make 1 call per day
» Calls are tracked by PnL performance
» The top performer gets rewards + bragging rights

⚡ Telegram Channel`;

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.url("⚡ Telegram Channel", COMMUNITY_CHANNEL_URL)],
      [Markup.button.callback("👥 Community Calls", "cmd:community")],
      [
        Markup.button.callback("🥇 Top Callers", "cmd:leaders"),
        Markup.button.callback("🧾 Make a call", "cmd:make"),
      ],
      [
        Markup.button.callback("📒 My calls", "cmd:mycalls"),
        Markup.button.callback("📜 Rules", "cmd:rules"),
      ],
      [
        Markup.button.url("⭐ Subscribe", COMMUNITY_CHANNEL_URL),
        Markup.button.url("🚀 Boost", COMMUNITY_CHANNEL_URL),
      ],
      [Markup.button.url("⚡ Boosted Coins", COMMUNITY_CHANNEL_URL)],
    ]),
  };
}

function startOnly() {
  const { text, keyboard } = startCard();
  return { text, extra: { ...keyboard, disable_web_page_preview: false } };
}

function chainTag(chain) {
  if (chain === "bsc") return "#BSC (PancakeSwap)";
  return "#SOL (PumpFun)";
}

// ---------- commands ----------
bot.start(async (ctx) => {
  const { text, extra } = startOnly();
  await ctx.reply(text, extra);
  // Hint prompt
  await ctx.reply("Paste the token address (SOL mint 32–44 chars or BSC 0x...).");
});

// “Make a call” button = same prompt
bot.action("cmd:make", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Paste the token address (SOL mint 32–44 chars or BSC 0x...).");
});

// Community / Rules shortcuts (text only)
bot.action("cmd:community", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Community Calls live in our channel:", Markup.inlineKeyboard([
    Markup.button.url("Open channel", COMMUNITY_CHANNEL_URL),
  ]));
});

bot.action("cmd:rules", async (ctx) => {
  await ctx.answerCbQuery();
  const msg =
`📜 Rules

• 1 call per user per 24h
• Post a valid mint/CA only (SOL mint or BSC 0x…)
• We track MC and X performance automatically
• No spam/scams — mods may remove any call`;
  await ctx.reply(msg);
});

// ---------- /mycalls ----------
bot.command("mycalls", async (ctx) => {
  const tgId = String(ctx.from.id);
  const handle = ctx.from.username || null;

  const calls = await Call
    .find({ userId: tgId })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!calls.length) {
    return ctx.reply("You don’t have any calls yet. Use “Make a call”.");
  }

  const header = `🧾 Your calls (${mention(handle, tgId)})`;
  const lines = calls.map((c) => {
    const t = c.ticker ? `$${c.ticker}` : (c.chain === "bsc" ? "$BSC" : "$SOL");
    return [
      `• ${t}`,
      `   MC when called: ${money(c.entryMc)}`,
      `   MC now: ${money(c.lastMc)}${c.lastMc!=null && c.entryMc!=null ? ` (${(((c.lastMc-c.entryMc)/c.entryMc)*100).toFixed(1)}%)` : ""}`
    ].join("\n");
  });

  await ctx.reply([header, "", ...lines].join("\n"));
});

// Button -> /mycalls
bot.action("cmd:mycalls", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.state.calledFromButton = true;
  await bot.handleUpdate({ message: { ...ctx.update.callback_query.message, text: "/mycalls", from: ctx.from, chat: ctx.chat } });
});

// ---------- /leaderboard ----------
bot.command("leaderboard", async (ctx) => {
  // rank by best peakMultiple per user (top 10)
  const top = await Call.aggregate([
    { $match: { peakMultiple: { $gt: 1 } } },
    { $group: {
        _id: "$userId",
        handle: { $last: "$userHandle" },
        bestX: { $max: "$peakMultiple" },
        totalCalls: { $sum: 1 },
      }
    },
    { $sort: { bestX: -1 } },
    { $limit: 10 }
  ]);

  if (!top.length) return ctx.reply("No leaderboard data yet. Make some calls first!");

  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const lines = top.map((u, i) => {
    const tag = mention(u.handle, u._id);
    return `${medals[i]} ${tag} — Best: ${xfmt(u.bestX)}  • Calls: ${u.totalCalls}`;
  });

  const text = ["🏆 Top Callers (best X)", "", ...lines].join("\n");
  await ctx.reply(text, { disable_web_page_preview: true });
});

// Button -> /leaderboard
bot.action("cmd:leaders", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.state.calledFromButton = true;
  await bot.handleUpdate({ message: { ...ctx.update.callback_query.message, text: "/leaderboard", from: ctx.from, chat: ctx.chat } });
});

// ---------- Handle MEDIA: show /start ----------
const mediaUpdates = [
  "photo","video","animation","sticker","document","audio","voice",
  "video_note","contact","location","poll"
];
for (const t of mediaUpdates) {
  bot.on(t, async (ctx) => {
    const { text, extra } = startOnly();
    await ctx.reply(text, extra);
  });
}

// ---------- Mint/CA intake (simple) ----------
// This keeps whatever CA-intake flow you already have in worker,
// here we just save basic shell for the card + "we'll track it".
const SOL_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BSC_CA = /^0x[a-fA-F0-9]{40}$/;

bot.on("text", async (ctx, next) => {
  const text = (ctx.message && ctx.message.text || "").trim();

  // Let command handlers run
  if (text.startsWith("/")) return next();

  // Looks like a CA/mint? Save minimal info; your worker will enrich (price/MC/peaks)
  const isSol = SOL_MINT.test(text);
  const isBsc = BSC_CA.test(text);

  if (!isSol && !isBsc) {
    // Not a CA: just gently show start again
    const { text: s, extra } = startOnly();
    return ctx.reply(s, extra);
  }

  const tgId = String(ctx.from.id);
  const handle = ctx.from.username || null;

  // soft limit: 1 call / 24h unless admin bypass is in your worker
  const since = new Date(Date.now() - 24*60*60*1000);
  const recent = await Call.findOne({ userId: tgId, createdAt: { $gt: since } });
  if (recent) {
    return ctx.reply("You already made a call in the last 24h.");
  }

  const chain = isBsc ? "bsc" : "sol";
  const ca = text;
  const ticker = chain === "bsc" ? "" : ""; // worker can discover later
  const now = new Date();

  const call = await Call.create({
    userId: tgId,
    userHandle: handle,
    chain,
    ca,
    ticker,
    entryMc: null,
    lastMc: null,
    peakMultiple: null,
    createdAt: now,
    updatedAt: now,
  });

  const header = "✅ Call saved!";
  const tokenLine = `Token: ${ticker ? `$${ticker}` : (chain === "bsc" ? "$BSC" : "$SOL")}`;
  const mcLine = `Called MC: ${money(call.entryMc)}`;
  await ctx.reply([header, tokenLine, mcLine, "We’ll track it & alert milestones."].join("\n"));

  // Immediately echo one line in “my calls” style
  const my = `🧾 Your calls (${mention(handle, tgId)})\n\n• ${ticker ? `$${ticker}` : (chain === "bsc" ? "$BSC" : "$SOL")}\n   MC when called: ${money(call.entryMc)}\n   MC now: ${money(call.lastMc)}`;
  await ctx.reply(my, { disable_web_page_preview: true });
});

// ---------- errors & launch ----------
bot.catch((err, ctx) => {
  console.error("Unhandled error while processing", ctx.update);
  console.error(err);
});

async function main() {
  await bot.launch();
  console.log("@", BOT_USERNAME, "ready");
}

main();
process.on("SIGINT", () => bot.stop("SIGINT"));
process.on("SIGTERM", () => bot.stop("SIGTERM"));
