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
  .map(x => x.trim())
  .filter(Boolean);

const CHANNEL_LINK = process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';
const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));

const menuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.url('⚡ Telegram Channel', CHANNEL_LINK)],
    [
      Markup.button.callback('🧾 My calls', 'cmd:mycalls'),
      Markup.button.callback('🏅 Top Callers', 'cmd:leaders'),
    ],
    [Markup.button.callback('🧾 Make a call', 'cmd:make')],
    [Markup.button.callback('📜 Rules', 'cmd:rules')],
  ]);

const RULES =
  '📜 <b>Rules</b>\n\n' +
  '• One call per user in 24h (admins are exempt).\n' +
  '• Paste a SOL mint or BSC 0x.\n' +
  '• We track PnL milestones and show a leaderboard.\n' +
  '• Best performers climb the board.';

bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome to Mooncall bot.\n\n' +
      'Call tokens, track PnL, and compete for rewards.\n\n' +
      '» Each user can make 1 call per day\n' +
      '» Calls are tracked by PnL performance\n' +
      '» The top performer gets rewards + bragging rights',
    { parse_mode: 'HTML', ...menuKeyboard() }
  );
});

bot.action('cmd:rules', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(RULES, { parse_mode: 'HTML' });
});

bot.action('cmd:make', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Paste the token address (SOL mint 32–44 chars or BSC 0x...).');
});

bot.action('cmd:leaders', async (ctx) => {
  await ctx.answerCbQuery();
  // Sum of user X across ALL calls (we don’t punish losers: min 1x)
  const rows = await Call.aggregate([
    {
      $project: {
        tgId: '$caller.tgId',
        user: '$caller.username',
        entry: '$entryMc',
        peak: '$peakMc',
      },
    },
    { $match: { entry: { $gt: 0 }, peak: { $gt: 0 } } },
    {
      $project: {
        tgId: 1,
        user: 1,
        x: { $divide: ['$peak', '$entry'] },
      },
    },
    {
      $project: {
        tgId: 1,
        user: 1,
        xSafe: { $cond: [{ $gt: ['$x', 1] }, '$x', 1] },
      },
    },
    {
      $group: {
        _id: '$tgId',
        user: { $first: '$user' },
        totalX: { $sum: '$xSafe' },
        calls: { $sum: 1 },
      },
    },
    { $sort: { totalX: -1 } },
    { $limit: 10 },
  ]);

  if (!rows.length) return ctx.reply('No leaderboard data yet — make a call!');

  const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`);
  const lines = rows.map((r, i) => {
    const name = r.user ? `@${r.user}` : r._id;
    return `${medal(i)} ${name} — ${r.totalX.toFixed(2)}× (from ${r.calls} calls)`;
  });

  await ctx.reply('🏆 <b>Top Callers</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
});

bot.action('cmd:mycalls', async (ctx) => {
  await ctx.answerCbQuery();
  const tgId = String(ctx.from.id);
  const list = await Call.find({ 'caller.tgId': tgId }).sort({ createdAt: -1 }).limit(10);

  if (!list.length) return ctx.reply('You have no calls yet.');

  const lines = list.map((c) => {
    const tkr = c.ticker ? `$${c.ticker}` : '—';
    return `• ${tkr}\n   MC when called: ${usd(c.entryMc)}\n   MC now: ${usd(c.lastMc)}`;
  });

  await ctx.reply(`🧾 <b>Your calls</b> (@${ctx.from.username || tgId})\n\n${lines.join('\n')}`, {
    parse_mode: 'HTML',
  });
});

// Reject media
;['photo','document','video','audio','sticker','voice'].forEach(t =>
  bot.on(t, ctx => ctx.reply('This bot only accepts text token addresses.'))
);

// ====== Handle addresses (make a call) ======
bot.on('text', async (ctx) => {
  const text = (ctx.message?.text || '').trim();
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;

  if (!isSolMint(text) && !isBsc(text)) return;

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if (!isAdmin(tgId)) {
    const exists = await Call.exists({ 'caller.tgId': tgId, createdAt: { $gte: since } });
    if (exists) return ctx.reply('You already made a call in the last 24h.');
  }

  let info = null;
  try { info = await getTokenInfo(text); } catch {}
  if (!info) return ctx.reply('Could not resolve token info (Dexscreener). Try another CA/mint.');

  // Build caption (always keep the CA copyable)
  const caption = channelCardText({
    user: username,
    tkr: info.ticker || 'Token',
    chain: info.chain,
    mintOrCa: text,
    stats: { mc: info.mc, lp: info.lp, vol24h: info.vol24h },
    ageHours: info.ageHours,
    dex: info.dex,
  });

  let messageId;
  try {
    if (process.env.CALL_CARD_USE_IMAGE === 'true' && info.image) {
      const m = await ctx.telegram.sendPhoto(CH_ID, info.image, {
        caption,
        parse_mode: 'HTML',
        ...tradeKeyboards(info.chain, info.chartUrl),
      });
      messageId = m?.message_id;
    } else {
      const m = await ctx.telegram.sendMessage(CH_ID, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...tradeKeyboards(info.chain, info.chartUrl),
      });
      messageId = m?.message_id;
    }
  } catch (e) {
    console.error('send to channel failed:', e.response?.description || e.message);
  }

  await Call.create({
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

  await ctx.reply(
    '✅ <b>Call saved!</b>\n' +
      `Token: ${info.ticker || info.chain}\n` +
      `Called MC: ${usd(info.mc)}\n` +
      "We’ll track it & alert milestones.",
    { parse_mode: 'HTML' }
  );
});

// Errors & launch
bot.catch((err, ctx) => console.error('Unhandled', ctx.update, err));

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
