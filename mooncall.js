// mooncall.js
require('dotenv').config();
require('./lib/db');

const { Telegraf, Markup } = require('telegraf');
const Call = require('./model/call.model');
const { getTokenInfo, isSolMint, isBsc, usd } = require('./lib/price');
const { channelCardText, tradeKeyboards } = require('./card');

const bot = new Telegraf(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const CHANNEL_LINK = process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';

// ---------------- helpers ----------------
const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));
const cIdForPrivate = (id) => String(id).replace('-100', ''); // t.me/c/<id>/<msg>
const awaitingCA = new Map(); // tgId -> true when user tapped "Make a call"

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.url('⚡ Telegram Channel', CHANNEL_LINK)],
    [Markup.button.callback('👥 Community Calls', 'cmd:community')],
    [Markup.button.callback('🏅 Top Callers', 'cmd:leaders')],
    [Markup.button.callback('🧾 Make a call', 'cmd:make')],
    [Markup.button.callback('📒 My calls', 'cmd:mycalls')],
    [Markup.button.callback('📜 Rules', 'cmd:rules')],
    [Markup.button.callback('⭐ Subscribe', 'cmd:soon:subscribe')],
    [Markup.button.callback('🚀 Boost', 'cmd:soon:boost')],
    [Markup.button.callback('⚡ Boosted Coins', 'cmd:soon:boosted')],
  ]);
}

const rulesText =
  '📜 <b>Rules</b>\n\n' +
  '• One call per user in 24h (admins are exempt).\n' +
  '• Paste a SOL mint or BSC 0x address.\n' +
  '• We track PnLs & post milestone alerts.\n' +
  '• Best performers climb the leaderboard.';

function viewChannelButton(messageId) {
  if (!messageId) return Markup.inlineKeyboard([]);
  const shortId = cIdForPrivate(CH_ID);
  const url = `https://t.me/c/${shortId}/${messageId}`;
  return Markup.inlineKeyboard([[Markup.button.url('📣 View Channel', url)]]);
}

// ---------------- UI ----------------
bot.start(async (ctx) => {
  try {
    await ctx.reply(
      'Welcome to Mooncall bot.\n\n' +
        'Call tokens, track PnL, and compete for rewards.\n\n' +
        '» Each user can make 1 call per day\n' +
        '» Calls are tracked by PnL performance\n' +
        '» The top performer gets rewards + bragging rights',
      { parse_mode: 'HTML', ...mainMenu() }
    );
    // (requested) no “Paste the token address …” message here
    awaitingCA.delete(String(ctx.from.id)); // clear any stale state
  } catch (e) {
    console.error(e);
  }
});

// Reject media to keep bot chat clean
['photo', 'document', 'video', 'audio', 'sticker', 'voice'].forEach((type) =>
  bot.on(type, (ctx) => ctx.reply('This bot only accepts text token addresses.'))
);

// Buttons with real actions
bot.action('cmd:rules', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(rulesText, { parse_mode: 'HTML' });
});

bot.action('cmd:leaders', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    // Top callers by best X (peak/entry)
    const rows = await Call.aggregate([
      { $project: { user: '$caller.username', tgId: '$caller.tgId', entry: '$entryMc', peak: '$peakMc' } },
      { $match: { entry: { $gt: 0 }, peak: { $gt: 0 } } },
      { $project: { user: 1, tgId: 1, bestX: { $divide: ['$peak', '$entry'] } } },
      { $sort: { bestX: -1 } },
      { $limit: 10 },
    ]);
    if (!rows.length) return ctx.reply('No leaderboard data yet — make a call!');
    const lines = rows.map((r, i) => `${i + 1}. @${r.user || r.tgId} — ${r.bestX.toFixed(2)}×`);
    return ctx.reply('🏆 <b>Top Callers</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
  } catch (e) {
    console.error(e);
  }
});

bot.action('cmd:mycalls', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const tgId = String(ctx.from.id);
    const list = await Call.find({ 'caller.tgId': tgId }).sort({ createdAt: -1 }).limit(10);
    if (!list.length) return ctx.reply('You have no calls yet.');
    const lines = list.map((c) => {
      const entry = usd(c.entryMc);
      const now = usd(c.lastMc);
      const tkr = c.ticker ? `$${c.ticker}` : '—';
      return `• ${tkr}\n   MC when called: ${entry}\n   MC now: ${now}`;
    });
    return ctx.reply(
      `🧾 <b>Your calls</b> (@${ctx.from.username || tgId})\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error(e);
  }
});

// “Make a call” gate — only prompt for CA after tapping this
bot.action('cmd:make', async (ctx) => {
  await ctx.answerCbQuery();
  const tgId = String(ctx.from.id);
  awaitingCA.set(tgId, true);
  return ctx.reply('Paste the token address (SOL or BSC ).');
});

// “Available soon” placeholders
bot.action(/^cmd:soon:/, async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('🛠️ This feature will be available soon.');
});

// Community Calls placeholder (same message)
bot.action('cmd:community', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('🛠️ Community Calls will be available soon.');
});

// ---------------- token input ----------------
bot.on('text', async (ctx) => {
  const text = (ctx.message?.text || '').trim();
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;

  // Only react to a mint/CA, and either they tapped “Make a call”
  // or we accept direct sends (nice UX fallback)
  const looksLikeToken = isSolMint(text) || isBsc(text);
  if (!looksLikeToken) return;

  const mustHaveTapped = awaitingCA.get(tgId) === true;
  if (!mustHaveTapped) {
    // Fallback behavior: still allow the call, but you could bail out here instead:
    // return ctx.reply('Tap “🧾 Make a call” first.');
  }

  // one call per 24h unless admin
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if (!isAdmin(tgId)) {
    const exists = await Call.exists({ 'caller.tgId': tgId, createdAt: { $gte: since } });
    if (exists) {
      awaitingCA.delete(tgId);
      return ctx.reply('You already made a call in the last 24h.');
    }
  }

  // fetch token info
  let info;
  try {
    info = await getTokenInfo(text);
  } catch (e) {
    console.error('price fetch failed:', e.message);
  }
  if (!info) {
    awaitingCA.delete(tgId);
    await ctx.reply('Could not resolve token info (Dexscreener). Try another CA/mint.');
    return;
  }

  // Post to channel (CA/mint is plain text so it’s copyable)
  const body = channelCardText({
    user: username,
    tkr: info.ticker ? `${info.ticker}` : 'Token',
    chain: info.chain,
    mintOrCa: text, // copyable line
    stats: { mc: info.mc, lp: info.lp, vol24h: info.vol24h },
    ageHours: info.ageHours,
    dex: info.dex,
  });

  let messageId;
  try {
    const res = await ctx.telegram.sendMessage(CH_ID, body, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...tradeKeyboards(info.chain),
    });
    messageId = res?.message_id;
  } catch (e) {
    console.error('send to channel failed:', e.response?.description || e.message);
  }

  // Save call
  const doc = await Call.create({
    ca: text,
    chain: info.chain,
    ticker: info.ticker || undefined,
    entryMc: info.mc || null,
    peakMc: info.mc || null,
    lastMc: info.mc || null,
    multipliersHit: [],
    postedMessageId: messageId || undefined,
    caller: { tgId, username },
  });

  awaitingCA.delete(tgId);

  await ctx.reply(
    '✅ <b>Call saved!</b>\n' +
      `Token: ${info.ticker || info.chain}\n` +
      `Called MC: ${usd(info.mc)}\n` +
      "We’ll track it & alert milestones.",
    { parse_mode: 'HTML', ...viewChannelButton(messageId) }
  );
});

// ---------------- errors & launch ----------------
bot.catch((err, ctx) => {
  console.error('Unhandled error while processing', ctx.update, err);
});

(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 mooncall bot ready');
  } catch (e) {
    console.error('Failed to launch bot:', e);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
