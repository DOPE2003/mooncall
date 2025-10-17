// api/telegram.js
const { Telegraf, Markup } = require("telegraf");
const dbConnect = require("../lib/db");
const userModel = require("../model/mooncall.model");
const callModel = require("../model/call.model");
const { getSolPrice, getBscPrice } = require("../lib/price");

const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { webhookReply: true } });
const CH_ID = process.env.ALERTS_CHANNEL_ID;

// Helpers
const isSolMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const isBscAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
const adminIds = (process.env.ADMIN_IDS || "").split(",").filter(Boolean).map(x => x.trim());

// /start — static card
bot.start(async (ctx) => {
  const kb = Markup.inlineKeyboard([
    [Markup.button.url("👥 Community Calls", process.env.COMMUNITY_CHANNEL_URL || "https://t.me/")],
    [Markup.button.callback("🏆 Top Callers", "cmd:top"), Markup.button.callback("📜 Rules", "cmd:rules")],
    [Markup.button.callback("🧾 My Calls", "cmd:mycalls")],
    [Markup.button.url("⚡ Boost", process.env.BOOST_URL || "https://t.me/")],
  ]);
  await ctx.reply(
    "Welcome to Mooncall bot.\n\nCall tokens, track PnL, and compete for rewards.\n\n" +
    "» Each user can make 1 call per day\n" +
    "» Calls are tracked by PnL performance\n" +
    "» The top performer gets rewards + bragging rights\n\n" +
    "⚡ Telegram",
    kb
  );
});

// Simple stateless call: /call <MINT_OR_0x>
bot.hears(/^\/call(?:@[\w_]+)?\s+(\S+)/i, async (ctx) => {
  await dbConnect();

  const who = String(ctx.from.id);
  const handle = ctx.from.username || null;
  const target = ctx.match[1].trim();

  // allow unlimited for admins
  const unlimited = adminIds.includes(who);

  // Upsert user
  const user = await userModel.findOneAndUpdate(
    { tgId: who },
    { $set: { handle } },
    { new: true, upsert: true }
  );

  // 1 call / 24h (unless admin)
  if (!unlimited) {
    const cut = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await callModel.findOne({ userId: user._id, createdAt: { $gt: cut } });
    if (recent) return ctx.reply("You already made a call in the last 24h. Try again tomorrow.");
  }

  // figure chain + price
  let entryPrice = null, chain = null;
  if (isSolMint(target)) { chain = "SOL"; entryPrice = await getSolPrice(target).catch(() => null); }
  else if (isBscAddr(target)) { 
    chain = "BSC"; const r = await getBscPrice(target).catch(() => null); entryPrice = r?.price ?? null;
  } else {
    return ctx.reply("That doesn't look like a valid SOL mint or BSC 0x address.");
  }

  // save call
  const call = await callModel.create({
    userId: user._id,
    tokenMint: target,
    chain,
    entryPrice: entryPrice ?? null,
    // seed tracking room (worker/cron will pick up)
    status: "active",
    nextCheckAt: new Date(Date.now() + (Number(process.env.CHECK_INTERVAL_MINUTES||60) * 60000)),
    expiresAt: new Date(Date.now() + (Number(process.env.BASE_TRACK_DAYS||7) * 86400000)),
  });

  // post to channel
  if (CH_ID) {
    const tag = chain === "SOL" ? "#SOL (PumpFun) | 🆕 New" : "#BSC (PancakeSwap) | 🆕 New";
    const mc = entryPrice ? `\n\n📊 MC: —  (fill if you compute)` : "";
    const txt =
`New Call by @${handle || "unknown"}

${chain} call
\`${target}\`

${tag}

🧾 Stats${mc}

Make a call here 👉 @${ctx.me || "yourbot"}`;
    await ctx.telegram.sendMessage(CH_ID, txt, { parse_mode: "Markdown", disable_web_page_preview: true });
  }

  // confirm to caller
  await ctx.reply("✅ Call recorded.");
});

// minimal callbacks
bot.action("cmd:rules", (ctx) =>
  ctx.answerCbQuery("Rules: 1 call/day, no spam. Best performance wins.")
);
bot.action("cmd:top", (ctx) =>
  ctx.answerCbQuery("Leaderboard coming soon.")
);
bot.action("cmd:mycalls", async (ctx) => {
  await dbConnect();
  const who = String(ctx.from.id);
  const user = await userModel.findOne({ tgId: who });
  if (!user) return ctx.answerCbQuery("No calls yet.");
  const last = await callModel.find({ userId: user._id }).sort({ createdAt: -1 }).limit(1);
  if (!last[0]) return ctx.answerCbQuery("No calls yet.");
  const c = last[0];
  await ctx.editMessageText(
    `Your call:\n${c.tokenMint}\nEntry: ${c.entryPrice ?? "—"}\nLast: ${c.lastPrice ?? "—"}\nPeak: ${c.peakPrice ?? "—"}`,
    { disable_web_page_preview: true }
  ).catch(() => ctx.answerCbQuery("Opened."));
});

// export serverless handler
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  // Telegram may send empty body on setWebhook test
  let body = {};
  try { body = req.body || {}; } catch {}
  try {
    await bot.handleUpdate(body, res); // webhookReply = true
  } catch (e) {
    console.error("webhook error:", e);
    res.status(200).end(); // avoid retry storms
  }
};
