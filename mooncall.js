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
  .split(',').map(x => x.trim()).filter(Boolean);

const CHANNEL_LINK = process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const WANT_IMAGE = String(process.env.CALL_CARD_USE_IMAGE || '').toLowerCase() === 'true';

const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));
const SOON = '🚧 Available soon.';

const cIdForPrivate = (id) => String(id).replace('-100', '');
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

// --------- robust mint/CA extraction ----------------------------------------
const RX_BASE58_WIDE = /[1-9A-HJ-NP-Za-km-z]{25,64}/;

function extractMintOrCa(input) {
  let s = String(input || '');

  // strip spaces and zero-width chars
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  // handle full pump.fun URLs or trailing “pump”
  s = s
    .replace(/https?:\/\/(www\.)?pump\.fun\/coin\/([A-Za-z0-9]+)/i, '$2')
    .replace(/pump$/i, '');

  // pick 0x CA first
  const bsc = s.match(/0x[a-fA-F0-9]{40}/);
  if (bsc) return bsc[0];

  // or a (relaxed) base58 mint
  const m = s.match(RX_BASE58_WIDE);
  if (m) return m[0];

  return s.trim();
}

// ---------------- /start & buttons ------------------------------------------
bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome to Mooncall bot.\n\n' +
      'Call tokens, track PnL, and compete for rewards.\n\n' +
      '» Each user can make 1 call per day\n' +
      '» Calls are tracked by PnL performance\n' +
      '» The top performer gets rewards + bragging rights',
    { parse_mode: 'HTML', ...menuKeyboard() }
  );

  const botLink = `https://t.me/${BOT_USERNAME}`;
  await ctx.reply(
    `Telegram\nMoon Call 🌕\nThe ultimate call channel ⚡👉:\n${CHANNEL_LINK}\n\n` +
      `Moon Call bot 👉: ${botLink}`
  );
});

['photo','document','video','audio','sticker','voice'].forEach(type =>
  bot.on(type, (ctx) => ctx.reply('This bot only accepts text token addresses.'))
);

bot.action('cmd:rules', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply(rulesText, { parse_mode: 'HTML' }); });
bot.action('cmd:make',  async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('Paste the token address (SOL or BSC).'); });
bot.action('cmd:community', async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply(SOON); });
bot.action('cmd:subscribe', async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply(SOON); });
bot.action('cmd:boost', async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply(SOON); });
bot.action('cmd:boosted', async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply(SOON); });

// --------------- leaderboard (sum of X) --------------------------------------
bot.action('cmd:leaders', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const rows = await Call.aggregate([
      { $project: { user:'$caller.username', tgId:'$caller.tgId', entry:'$entryMc', peak:'$peakMc' } },
      { $match:   { entry: { $gt: 0 }, peak: { $gt: 0 } } },
      { $project: { user:1, tgId:1, x: { $divide: ['$peak', '$entry'] } } },
      { $group:   { _id: { user:'$user', tgId:'$tgId' }, sumX: { $sum: '$x' } } },
      { $sort:    { sumX: -1 } },
      { $limit:   10 }
    ]);
    if (!rows.length) return ctx.reply('No leaderboard data yet — make a call!');
    const medal = (i)=> (i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`);
    const lines = rows.map((r,i)=>`${medal(i)} @${r._id.user || r._id.tgId} — ${r.sumX.toFixed(2)}× total`);
    await ctx.reply('🏆 <b>Top Callers</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
  } catch (e) {
    console.error(e); await ctx.reply('Failed to load leaderboard.');
  }
});

// --------------- my calls ----------------------------------------------------
bot.action('cmd:mycalls', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const tgId = String(ctx.from.id);
    const list = await Call.find({ 'caller.tgId': tgId }).sort({ createdAt: -1 }).limit(10);
    if (!list.length) return ctx.reply('You have no calls yet.');
    const lines = list.map(c => {
      const entry = usd(c.entryMc), now = usd(c.lastMc), tkr = c.ticker ? `$${c.ticker}` : '—';
      return `• ${tkr}\n   MC when called: ${entry}\n   MC now: ${now}`;
    });
    await ctx.reply(`🧾 <b>Your calls</b> (@${ctx.from.username || tgId})\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (e) { console.error(e); }
});

// --------------- token input -------------------------------------------------
bot.on('text', async (ctx) => {
  const raw = (ctx.message?.text || '').trim();
  const caOrMint = extractMintOrCa(raw);
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;

  // Allow anything we could extract; hard validation often blocks real mints
  if (!isSolMint(caOrMint) && !isBsc(caOrMint)) {
    // Not obviously a CA/mint; ignore quietly
    return;
  }

  // throttle (except admins)
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if (!isAdmin(tgId)) {
    const exists = await Call.exists({ 'caller.tgId': tgId, createdAt: { $gte: since } });
    if (exists) return ctx.reply('You already made a call in the last 24h.');
  }

  // Fetch data
  let info = null;
  try {
    info = await getTokenInfo(caOrMint);
  } catch (e) {
    console.error('getTokenInfo error:', e);
  }
  if (!info) return ctx.reply('Could not resolve token info (Dexscreener). Try another CA/mint.');

  // image fallbacks
  if (!info.imageUrl && info.chain === 'SOL') {
    info.imageUrl = `https://cdn.pump.fun/token/${caOrMint}.png`;
  }
  if (!info.imageUrl && info.chain === 'BSC' && caOrMint.startsWith('0x')) {
    info.imageUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/${caOrMint}/logo.png`;
  }

  const chartUrl =
    info.chartUrl ||
    (info.chain === 'SOL'
      ? `https://dexscreener.com/solana/${caOrMint}`
      : `https://dexscreener.com/bsc/${caOrMint}`);

  const body = channelCardText({
    user: username,
    tkr: info.ticker || 'Token',
    chain: info.chain,
    mintOrCa: caOrMint,              // stays plain — copyable
    stats: { mc: info.mc, lp: info.lp, vol24h: info.vol24h },
    ageHours: info.ageHours,
    dex: info.dex || 'dex',
  });

  // Post to channel (+image when possible)
  let messageId;
  try {
    const kb = tradeKeyboards(info.chain, chartUrl);
    if (WANT_IMAGE && info.imageUrl) {
      try {
        const res = await ctx.telegram.sendPhoto(CH_ID, info.imageUrl, { caption: body, parse_mode: 'HTML', ...kb });
        messageId = res?.message_id;
      } catch (_) {
        const res = await ctx.telegram.sendMessage(CH_ID, body, { parse_mode: 'HTML', disable_web_page_preview: false, ...kb });
        messageId = res?.message_id;
      }
    } else {
      const res = await ctx.telegram.sendMessage(CH_ID, body, { parse_mode: 'HTML', disable_web_page_preview: false, ...kb });
      messageId = res?.message_id;
    }
  } catch (e) {
    console.error('send to channel failed:', e.response?.description || e.message);
  }

  // Save call
  await Call.create({
    ca: caOrMint,
    chain: info.chain,
    ticker: info.ticker || undefined,
    entryMc: info.mc ?? null,
    peakMc: info.mc ?? null,
    lastMc: info.mc ?? null,
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

// --------- error/launch ------------------------------------------------------
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
