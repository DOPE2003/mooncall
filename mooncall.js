// mooncall.js
require('dotenv').config();
require('./lib/db');

const { Telegraf, Markup } = require('telegraf');
const Call = require('./model/call.model');
const { getTokenInfo, isSolMint, isBsc, usd } = require('./lib/price');
const { channelCardText, tradeKeyboards } = require('./card');

// --- env / constants ---------------------------------------------------------
const bot = new Telegraf(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const CHANNEL_LINK = process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const WANT_IMAGE = String(process.env.CALL_CARD_USE_IMAGE || '').toLowerCase() === 'true';

// for duplicate summary only
const MILESTONES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',')
  .map((n) => Number(n))
  .filter((n) => n > 0)
  .sort((a, b) => a - b);

const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));
const SOON = '🚧 Available soon.';

// keep a tiny in-memory “expecting a CA” flag per user
const awaitingCA = new Set();

// --- helpers -----------------------------------------------------------------
const cIdForPrivate = (id) => String(id).replace('-100', ''); // t.me/c/<id>/<msg>
function viewChannelButton(messageId) {
  if (!messageId) return Markup.inlineKeyboard([]);
  const shortId = cIdForPrivate(CH_ID);
  const url = `https://t.me/c/${shortId}/${messageId}`;
  return Markup.inlineKeyboard([[Markup.button.url('📣 View Channel', url)]]);
}
const highestMilestone = (x) => {
  let best = null; for (const m of MILESTONES) if (x >= m) best = m; return best;
};
const normalizeCa = (ca, chainUpper) =>
  chainUpper === 'BSC' ? String(ca || '').toLowerCase() : ca;

// Extract a clean address from free-form user text.
// - BSC: 0x + 40 hex
// - SOL: 32–44 base58 chars, optionally followed by "pump"
function extractAddress(input) {
  const s = String(input || '').trim();

  // Try BSC first
  const bsc = s.match(/0x[a-fA-F0-9]{40}/);
  if (bsc) return { chainHint: 'BSC', value: bsc[0] };

  // SOL base58 (no 0 O I l), 32–44 chars, optionally with trailing "pump"
  const sol = s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})(?:pump)?$/);
  if (sol) return { chainHint: 'SOL', value: sol[1] };

  return null;
}

// --- UI: /start --------------------------------------------------------------
bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome to 🌖 Mooncall bot 🌖 .\n\n' +
      'Call tokens, track PnL, and compete for rewards.\n\n' +
      '» Each user can make 1 call per day\n' +
      '» Calls are tracked by PnL performance\n' +
      '» The top performer gets rewards + bragging rights',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.url('⚡ Telegram Channel', CHANNEL_LINK)],
      [Markup.button.callback('👥 Community Calls', 'cmd:community')],
      [Markup.button.callback('🏅 Top Callers', 'cmd:leaders')],
      [Markup.button.callback('🧾 Make a call', 'cmd:make')],
      [Markup.button.callback('📒 My calls', 'cmd:mycalls')],
      [Markup.button.callback('📜 Rules', 'cmd:rules')],
      [Markup.button.callback('⭐ Subscribe', 'cmd:subscribe')],
      [Markup.button.callback('🚀 Boost', 'cmd:boost')],
      [Markup.button.callback('⚡ Boosted Coins', 'cmd:boosted')],
    ]) }
  );

  const botLink = `https://t.me/${BOT_USERNAME}`;
  await ctx.reply(
    `Telegram\nMoon Call 🌕\nThe ultimate call channel ⚡👉:\n${CHANNEL_LINK}\n\n` +
      `Moon Call bot 👉: ${botLink}`
  );
});

// media guard
['photo','document','video','audio','sticker','voice'].forEach((t) =>
  bot.on(t, (ctx) => ctx.reply('This bot only accepts text token addresses.'))
);

// buttons (static)
bot.action('cmd:rules', async (ctx) => (await ctx.answerCbQuery(), ctx.reply(
  '📜 <b>Rules</b>\n\n' +
  '• One call per user in 24h (admins are exempt).\n' +
  '• Paste a SOL mint (32–44 chars) or BSC 0x address.\n' +
  '• We track PnLs & post milestone alerts.\n' +
  '• Best performers climb the leaderboard.', { parse_mode:'HTML' })));

['community','subscribe','boost','boosted'].forEach(name =>
  bot.action(`cmd:${name}`, async (ctx) => (await ctx.answerCbQuery(), ctx.reply('🚧 Available soon.')))
);

// Make a call: set “awaiting” flag + instructions
bot.action('cmd:make', async (ctx) => {
  await ctx.answerCbQuery();
  awaitingCA.add(String(ctx.from.id));
  await ctx.reply(
    'Paste the token address now:\n' +
    '• SOL: <code>Base58Mint</code> (PumpFun suffix like “…pump” is OK)\n' +
    '• BSC: <code>0x…</code> (40 hex)',
    { parse_mode: 'HTML' }
  );
});

// Top callers
bot.action('cmd:leaders', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const rows = await Call.aggregate([
      { $project: { user: '$caller.username', tgId: '$caller.tgId', entry: '$entryMc', peak: '$peakMc' } },
      { $match: { entry: { $gt: 0 }, peak: { $gt: 0 } } },
      { $project: { user: 1, tgId: 1, x: { $divide: ['$peak', '$entry'] } } },
      { $group: { _id: { user: '$user', tgId: '$tgId' }, sumX: { $sum: '$x' } } },
      { $sort: { sumX: -1 } },
      { $limit: 10 },
    ]);
    if (!rows.length) return ctx.reply('No leaderboard data yet — make a call!');
    const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`);
    const lines = rows.map((r, i) => `${medal(i)} @${r._id.user || r._id.tgId} — ${r.sumX.toFixed(2)}× total`);
    await ctx.reply('🏆 <b>Top Callers</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
  } catch (e) {
    console.error(e);
    await ctx.reply('Failed to load leaderboard.');
  }
});

// My calls
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
    await ctx.reply(`🧾 <b>Your calls</b> (@${ctx.from.username || tgId})\n\n${lines.join('\n')}`, { parse_mode:'HTML' });
  } catch (e) { console.error(e); }
});

// --- Token input flow --------------------------------------------------------
bot.on('text', async (ctx) => {
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;
  const raw = (ctx.message?.text || '').trim();

  // Try to extract a CA/mint from whatever the user pasted
  const extracted = extractAddress(raw);

  // If user pressed "Make a call" and pasted something invalid, guide them
  if (!extracted) {
    if (awaitingCA.has(tgId)) {
      return ctx.reply(
        'That doesn’t look like a valid address.\n' +
        'Examples:\n• SOL: <code>6Vx…R1f</code> or <code>6Vx…R1fpump</code>\n• BSC: <code>0xAbC…123</code>',
        { parse_mode: 'HTML' }
      );
    }
    return; // ignore unrelated chatter
  }

  // From here on, we’ll handle the call; clear “awaiting”
  awaitingCA.delete(tgId);

  const caOrMint = extracted.value;

  // One call per 24h unless admin
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if (!isAdmin(tgId)) {
    const exists = await Call.exists({ 'caller.tgId': tgId, createdAt: { $gte: since } });
    if (exists) return ctx.reply('You already made a call in the last 24h.');
  }

  // Fetch token info
  let info;
  try { info = await getTokenInfo(caOrMint); }
  catch (e) { console.error('price fetch failed:', e.message); }
  if (!info) {
    return ctx.reply('Could not resolve token info (Dexscreener). Try another CA/mint.');
  }

  const chainUpper = String(info.chain || '').toUpperCase();

  // DUP check
  const normCa = normalizeCa(caOrMint, chainUpper);
  const existing = await Call.findOne({ ca: normCa, chain: chainUpper }).sort({ createdAt: -1 });

  if (existing) {
    const xNow = info.mc && existing.entryMc > 0 ? info.mc / existing.entryMc : null;
    const hit = xNow ? highestMilestone(xNow) : null;
    await ctx.reply(
      `⚠️ <b>Token already called</b> by @${existing.caller?.username || existing.caller?.tgId}.\n\n` +
      `Called MC: ${usd(existing.entryMc)}\n` +
      (xNow
        ? `Now MC: ${usd(info.mc)} — <b>${xNow.toFixed(2)}×</b> since call` + (hit ? ` (hit <b>${hit}×</b>)` : '') + `.`
        : `Now MC: ${usd(info.mc)}.`),
      { parse_mode:'HTML', ...(existing.postedMessageId ? viewChannelButton(existing.postedMessageId) : {}) }
    );
    return;
  }

  // Caller totals for header
  const userCalls = await Call.find({ 'caller.tgId': tgId });
  const totalCalls = userCalls.length;
  const totalX = userCalls.reduce((sum, c) => {
    if (!c.entryMc || c.entryMc <= 0) return sum;
    const peak = c.peakMc || c.entryMc;
    return sum + peak / c.entryMc;
  }, 0);
  const avgX = totalCalls ? totalX / totalCalls : 0;

  // Caption
  const chartUrl =
    info.chartUrl ||
    (chainUpper === 'SOL'
      ? `https://dexscreener.com/solana/${encodeURIComponent(caOrMint)}`
      : `https://dexscreener.com/bsc/${encodeURIComponent(caOrMint)}`);

  const caption = channelCardText({
    user: username,
    totals: { totalCalls, totalX, avgX },

    name: info.name,
    tkr: info.ticker || '',
    chain: chainUpper,
    mintOrCa: caOrMint,

    stats: { mc: info.mc, lp: info.lp, vol24h: info.vol24h },

    createdOnName: info.dex || info.dexName || 'DEX',
    createdOnUrl: info.tradeUrl || info.pairUrl || info.chartUrl || chartUrl,
    dexPaid: info.dexPaid,

    bubblemapUrl: info.bubblemapUrl,
    burnPct: info.liquidityBurnedPct,
    freezeAuth: info.freezeAuthority,
    mintAuth: info.mintAuthority,

    twitterUrl: info.twitter,
    botUsername: BOT_USERNAME,
  });

  // Post
  let messageId;
  try {
    const kb = tradeKeyboards(chainUpper, chartUrl);
    if (WANT_IMAGE && info.imageUrl) {
      const res = await ctx.telegram.sendPhoto(CH_ID, info.imageUrl, {
        caption,
        parse_mode: 'HTML',
        ...kb,
      });
      messageId = res?.message_id;
    } else {
      const res = await ctx.telegram.sendMessage(CH_ID, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        ...kb,
      });
      messageId = res?.message_id;
    }
  } catch (e) {
    console.error('send to channel failed:', e?.response?.description || e.message);
  }

  // Save
  await Call.create({
    ca: normCa,
    chain: chainUpper,
    ticker: info.ticker || undefined,
    entryMc: info.mc || 0,
    peakMc: info.mc || 0,
    lastMc: info.mc || 0,
    multipliersHit: [],
    postedMessageId: messageId || undefined,
    caller: { tgId, username },
  });

  await ctx.reply(
    '✅ <b>Call saved!</b>\n' +
      `Token: ${info.ticker || chainUpper}\n` +
      `Called MC: ${usd(info.mc)}\n` +
      'We’ll track it & alert milestones.',
    { parse_mode: 'HTML', ...viewChannelButton(messageId) }
  );
});

// --- global error / launch ---------------------------------------------------
bot.catch((err, ctx) => {
  console.error('Unhandled error while processing', ctx.update, err);
});

(async () => {
  try {
    if (process.env.DISABLE_BOT_LAUNCH === '1') {
      console.log('Bot launch disabled by env (DISABLE_BOT_LAUNCH=1).');
      return;
    }
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 mooncall bot ready');
  } catch (e) {
    console.error('Failed to launch bot:', e);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
