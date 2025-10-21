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

const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));
const SOON = '🚧 Available soon.';

// --- helpers -----------------------------------------------------------------
const cIdForPrivate = (id) => String(id).replace('-100', ''); // t.me/c/<id>/<msg>

function viewChannelButton(messageId) {
  if (!messageId) return Markup.inlineKeyboard([]);
  const shortId = cIdForPrivate(CH_ID);
  const url = `https://t.me/c/${shortId}/${messageId}`;
  return Markup.inlineKeyboard([[Markup.button.url('📣 View Channel', url)]]);
}

const rulesText =
  '📜 <b>Rules</b>\n\n' +
  '• One call per user in 24h (admins are exempt).\n' +
  '• Paste a SOL mint (32–44 chars) or BSC 0x address.\n' +
  '• We track PnLs & post milestone alerts.\n' +
  '• Best performers climb the leaderboard.';

const menuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.url('⚡ Telegram Channel', CHANNEL_LINK)],
    [Markup.button.callback('👥 Community Calls', 'cmd:community')],
    [Markup.button.callback('🏅 Top Callers', 'cmd:leaders')],
    [Markup.button.callback('🧾 Make a call', 'cmd:make')],
    [Markup.button.callback('📒 My calls', 'cmd:mycalls')],
    [Markup.button.callback('📜 Rules', 'cmd:rules')],
    [Markup.button.callback('⭐ Subscribe', 'cmd:subscribe')],
    [Markup.button.callback('🚀 Boost', 'cmd:boost')],
    [Markup.button.callback('⚡ Boosted Coins', 'cmd:boosted')],
  ]);

// --- input sanitizers --------------------------------------------------------
const BASE58_SOL = /[1-9A-HJ-NP-Za-km-z]{32,44}/; // SOL mint (base58)
const BSC_ADDR   = /(0x[a-fA-F0-9]{40})/;         // BSC 0x CA

function extractMintOrCa(input) {
  let s = String(input || '').trim();
  // strip common pump.fun suffix
  s = s.replace(/pump$/i, '');
  // pick a SOL mint if present
  const mSol = s.match(BASE58_SOL);
  if (mSol) return mSol[0];
  // or a BSC 0x CA if present
  const mBsc = s.match(BSC_ADDR);
  if (mBsc) return mBsc[0];
  return s;
}

// --- UI: /start --------------------------------------------------------------
bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome to Mooncall bot.\n\n' +
      'Call tokens, track PnL, and compete for rewards.\n\n' +
      '» Each user can make 1 call per day\n' +
      '» Calls are tracked by PnL performance\n' +
      '» The top performer gets rewards + bragging rights',
    { parse_mode: 'HTML', ...menuKeyboard() }
  );

  // Raw links so Telegram shows a big preview card under the intro
  const botLink = `https://t.me/${BOT_USERNAME}`;
  await ctx.reply(
    `Telegram\nMoon Call 🌕\nThe ultimate call channel ⚡👉:\n${CHANNEL_LINK}\n\n` +
      `Moon Call bot 👉: ${botLink}`
  );
});

// --- Simple media guard (text addresses only) --------------------------------
['photo', 'document', 'video', 'audio', 'sticker', 'voice'].forEach((type) =>
  bot.on(type, (ctx) => ctx.reply('This bot only accepts text token addresses.'))
);

// --- Buttons -----------------------------------------------------------------
bot.action('cmd:rules', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(rulesText, { parse_mode: 'HTML' });
});

bot.action('cmd:make', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Paste the token address (SOL or BSC).');
});

bot.action('cmd:community', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(SOON); });
bot.action('cmd:subscribe', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(SOON); });
bot.action('cmd:boost', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(SOON); });
bot.action('cmd:boosted', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(SOON); });

// --- Top Callers: total X = Σ(peak/entry) per user ---------------------------
bot.action('cmd:leaders', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const rows = await Call.aggregate([
      { $project: { user: '$caller.username', tgId: '$caller.tgId', entry: '$entryMc', peak: '$peakMc' } },
      { $match:   { entry: { $gt: 0 }, peak: { $gt: 0 } } },
      { $project: { user: 1, tgId: 1, x: { $divide: ['$peak', '$entry'] } } },
      { $group:   { _id: { user: '$user', tgId: '$tgId' }, sumX: { $sum: '$x' } } },
      { $sort:    { sumX: -1 } },
      { $limit:   10 }
    ]);

    if (!rows.length) return ctx.reply('No leaderboard data yet — make a call!');

    const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`);
    const lines = rows.map((r, i) => {
      const handle = r._id.user || r._id.tgId;
      return `${medal(i)} @${handle} — ${r.sumX.toFixed(2)}× total`;
    });

    await ctx.reply('🏆 <b>Top Callers</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
  } catch (e) {
    console.error(e);
    await ctx.reply('Failed to load leaderboard.');
  }
});

// --- My calls ----------------------------------------------------------------
bot.action('cmd:mycalls', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const tgId = String(ctx.from.id);
    const list = await Call.find({ 'caller.tgId': tgId }).sort({ createdAt: -1 }).limit(10);

    if (!list.length) return ctx.reply('You have no calls yet.');

    const lines = list.map((c) => {
      const entry = usd(c.entryMc);
      const now   = usd(c.lastMc);
      const tkr   = c.ticker ? `$${c.ticker}` : '—';
      return `• ${tkr}\n   MC when called: ${entry}\n   MC now: ${now}`;
    });

    await ctx.reply(
      `🧾 <b>Your calls</b> (@${ctx.from.username || tgId})\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error(e);
  }
});

// --- Token input flow --------------------------------------------------------
bot.on('text', async (ctx) => {
  const textRaw = (ctx.message?.text || '').trim();
  const text    = extractMintOrCa(textRaw);
  const tgId    = String(ctx.from.id);
  const username = ctx.from.username || tgId;

  // Accept only a valid SOL mint or BSC 0x CA
  if (!isSolMint(text) && !isBsc(text)) return; // ignore unrelated chat

  // One call per 24h (unless admin)
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if (!isAdmin(tgId)) {
    const exists = await Call.exists({ 'caller.tgId': tgId, createdAt: { $gte: since } });
    if (exists) return ctx.reply('You already made a call in the last 24h.');
  }

  // Fetch token info (Dexscreener/Jupiter in your lib)
  let info;
  try {
    info = await getTokenInfo(text);
  } catch (e) {
    console.error('price fetch failed:', e.message);
  }
  if (!info) return ctx.reply('Could not resolve token info (Dexscreener). Try another CA/mint.');

  // Image fallback if Dexscreener had none
  if (!info.imageUrl && info.chain === 'SOL') {
    info.imageUrl = `https://cdn.pump.fun/token/${text}.png`;
  }
  if (!info.imageUrl && info.chain === 'BSC' && text.startsWith('0x')) {
    info.imageUrl =
      `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/${text}/logo.png`;
  }

  // Best-effort chart URL
  const chartUrl =
    info.chartUrl ||
    (info.chain === 'SOL' ? `https://dexscreener.com/solana/${text}`
                          : `https://dexscreener.com/bsc/${text}`);

  // Compose post body (CA/mint stays plain so it’s copyable)
  const body = channelCardText({
    user: username,
    tkr: info.ticker ? `${info.ticker}` : 'Token',
    chain: info.chain,
    mintOrCa: text,
    stats: { mc: info.mc, lp: info.lp, vol24h: info.vol24h },
    ageHours: info.ageHours,
    dex: info.dex,
  });

  // Post to channel
  let messageId;
  try {
    const kb = tradeKeyboards(info.chain, chartUrl);

    if (WANT_IMAGE && info.imageUrl) {
      try {
        const res = await ctx.telegram.sendPhoto(CH_ID, info.imageUrl, {
          caption: body,
          parse_mode: 'HTML',
          ...kb,
        });
        messageId = res?.message_id;
      } catch (e) {
        // If image fails (404/CORS), fall back to text post
        const res2 = await ctx.telegram.sendMessage(CH_ID, body, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          ...kb,
        });
        messageId = res2?.message_id;
      }
    } else {
      const res = await ctx.telegram.sendMessage(CH_ID, body, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        ...kb,
      });
      messageId = res?.message_id;
    }
  } catch (e) {
    console.error('send to channel failed:', e.response?.description || e.message);
  }

  // Save call
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
    { parse_mode: 'HTML', ...viewChannelButton(messageId) }
  );
});

// --- global error / launch ---------------------------------------------------
bot.catch((err, ctx) => {
  console.error('Unhandled error while processing', ctx.update, err);
});

(async () => {
  try {
    // ensures polling (not webhook) and clears any pending updates
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 mooncall bot ready');
  } catch (e) {
    console.error('Failed to launch bot:', e);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
