// mooncall.js
const { Telegraf, Markup } = require("telegraf");

// --- ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const COMMUNITY = process.env.COMMUNITY_CHANNEL_URL || "https://t.me/your_channel";
const BOOST     = process.env.BOOST_URL || COMMUNITY;
const BANNER    = process.env.START_BANNER_URL || ""; // optional image url

const START_TEXT =
  `Welcome to <b>Mooncall</b>.\n\n` +
  `Call tokens, track PnL, and compete for rewards.\n\n` +
  `• 1 call per user per day\n` +
  `• Calls tracked by PnL\n` +
  `• Top performers get rewards\n\n` +
  `Join: <a href="${COMMUNITY}">${COMMUNITY}</a>`;

function startKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url("👥 Community Calls", COMMUNITY)],
    [
      Markup.button.callback("🏅 Top Callers", "cmd:top"),
      Markup.button.callback("📞 Make a call", "cmd:make"),
    ],
    [
      Markup.button.callback("📒 My calls", "cmd:mycalls"),
      Markup.button.callback("📜 Rules", "cmd:rules"),
    ],
    [
      Markup.button.url("⭐ Subscribe", COMMUNITY),
      Markup.button.url("🚀 Boost", BOOST),
    ],
    [Markup.button.callback("⚡ Boosted Coins", "cmd:boosted")],
  ]);
}

function createBot() {
  const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 9_000 });

  // /start with banner + buttons
  bot.start(async (ctx) => {
    const extra = {
      ...startKeyboard(),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (BANNER) {
      await ctx.replyWithPhoto(BANNER, { caption: START_TEXT, ...extra });
    } else {
      await ctx.reply(START_TEXT, extra);
    }
  });

  // Disallow media (stickers/photos/videos/docs/etc.)
  bot.on(
    [
      "photo",
      "video",
      "document",
      "audio",
      "voice",
      "sticker",
      "video_note",
      "animation",
      "contact",
      "location",
      "dice",
    ],
    async (ctx) => {
      await ctx.reply("Media is disabled. Use the buttons or send text commands.");
    }
  );

  // Minimal button handlers (safe stubs you can wire later)
  bot.action("cmd:rules", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Rules:\n• 1 call per 24h per user\n• No scams/spam\n• Use a valid contract address (Sol SPL or BSC 0x)."
    );
  });

  bot.action("cmd:top", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Top callers coming soon.");
  });

  bot.action("cmd:make", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Paste the token address (Sol SPL mint or BSC 0x…).");
  });

  bot.action("cmd:mycalls", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Your calls summary coming soon.");
  });

  bot.action("cmd:boosted", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Boosted coins coming soon.");
  });

  // Fallback for random text
  bot.on("text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return; // let commands pass
    await ctx.reply("Use /start to open the menu.");
  });

  return bot;
}

// Singleton (so Vercel reuses it across invocations)
let botSingleton;
function getBot() {
  if (!botSingleton) botSingleton = createBot();
  return botSingleton;
}

module.exports = { getBot };
