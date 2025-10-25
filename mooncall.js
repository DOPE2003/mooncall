// mooncall.js
require('dotenv').config();
require('./lib/db');

const { Telegraf, Markup } = require('telegraf');
const Call = require('./model/call.model');
const PremiumUser = require('./model/premium.model');
const { getTokenInfo, usd } = require('./lib/price');
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

const PREMIUM_SOL_WALLET = (process.env.PREMIUM_SOL_WALLET || '').trim();
const PREMIUM_PRICE_SOL = Number(process.env.PREMIUM_PRICE_SOL || 0.1);
const ADMIN_NOTIFY_ID = (process.env.ADMIN_NOTIFY_ID || '').trim();

// for duplicate summary only
const MILESTONES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',')
  .map(Number)
  .filter((n) => n > 0)
  .sort((a, b) => a - b);

const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));
const SOON = '🚧 Available soon.';

// simple state flags
const awaitingCA = new Set();
const awaitingTxSig = new Set();

// --- helpers -----------------------------------------------------------------
const cIdForPrivate = (id) => String(id).replace('-100', ''); // t.me/c/<id>/<msg>
function viewChannelButton(messageId) {
  if (!messageId) return Markup.inlineKeyboard([]);
  const shortId = cIdForPrivate(CH_ID);
  const url = `https://t.me/c/${shortId}/${messageId}`;
  return Markup.inlineKeyboard([[Markup.button.url('📣 View Channel', url)]]);
}
const highestMilestone = (x) => { let best = null; for (const m of MILESTONES) if (x >= m) best = m; return best; };
const normalizeCa = (ca, chainUpper) => (chainUpper === 'BSC' ? String(ca || '').toLowerCase() : ca);

// extract BSC/SOL address (SOL may end with “…pump”)
function extractAddress(input) {
  const s = String(input || '').trim();
  const bsc = s.match(/0x[a-fA-F0-9]{40}/);
  if (bsc) return { chainHint: 'BSC', value: bsc[0] };
  const sol = s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})(?:pump)?$/);
  if (sol) return { chainHint: 'SOL', value: sol[1] };
  return null;
}

// plausible Solana tx sig?
function looksLikeSig(s) { return /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(String(s).trim()); }

// limits
async function getDailyLimit(tgId) {
  if (isAdmin(tgId)) return Infinity;
  const p = await PremiumUser.findOne({ tgId: String(tgId) }).lean();
  if (p?.permanent) return p.callsPerDay || 4;
  return 1;
}
async function callsInLast24h(tgId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  return Call.countDocuments({ 'caller.tgId': String(tgId), createdAt: { $gte: since } });
}

// Telegram-safe Phantom link (URLs only; Telegram blocks custom schemes)
function phantomPayLink(recipient, amount, label, message) {
  const base = 'https://phantom.app/ul/transfer';
  const q = new URLSearchParams({
    recipient,
    amount: String(amount),
    token: 'SOL',
    label,
    message,
  });
  return `${base}?${q.toString()}`;
}

// Best-effort Pump.fun bonding-curve % fetch
async function fetchPumpfunProgress(mint) {
  try {
    const clean = String(mint || '').replace(/pump$/i, '');
    // Primary JSON endpoint
    let r = await fetch(`https://pump.fun/api/data/${clean}`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      let pct =
        j?.bonding_curve_progress ??
        j?.bondingCurveProgress ??
        j?.curveProgress ??
        j?.progress ??
        j?.bondingProgress ??
        j?.curve_progress ??
        null;
      if (typeof pct === 'number') {
        if (pct <= 1) pct = pct * 100;
        return Math.max(0, Math.min(100, pct));
      }
    }

    // Fallback: scrape coin HTML for a numeric value in embedded state
    r = await fetch(`https://pump.fun/coin/${clean}`, { headers: { accept: 'text/html' } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/"bonding(?:_curve_|Curve)progress"\s*:\s*([0-9.]+)/i)
           || html.match(/"bondingCurveProgress"\s*:\s*([0-9.]+)/);
    if (m && m[1]) {
      let pct = Number(m[1]);
      if (pct <= 1) pct *= 100;
      if (Number.isFinite(pct)) return Math.max(0, Math.min(100, pct));
    }
    return null;
  } catch {
    return null;
  }
}

// Bubblemap URL for EVM chains
function makeBubblemapUrl(chainUpper, ca) {
  if (!ca?.startsWith?.('0x')) return null;
  const map = {
    ETH: 'eth', ETHEREUM: 'eth',
    BSC: 'bsc',
    ARBITRUM: 'arbitrum', ARB: 'arbitrum',
    BASE: 'base',
    OPTIMISM: 'optimism', OP: 'optimism',
    POLYGON: 'polygon', MATIC: 'polygon',
    AVALANCHE: 'avalanche', AVAX: 'avalanche',
  };
  const key = map[chainUpper];
  return key ? `https://app.bubblemaps.io/token/${key}/${ca}` : null;
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

// static buttons
bot.action('cmd:rules', async (ctx) => (await ctx.answerCbQuery(), ctx.reply(
  '📜 <b>Rules</b>\n\n' +
  '• One call per user in 24h (admins are exempt).\n' +
  '• Paste a SOL mint (32–44 chars) or BSC 0x address.\n' +
  '• We track PnLs & post milestone alerts.\n' +
  '• Best performers climb the leaderboard.', { parse_mode:'HTML' })));

['community','boost','boosted'].forEach(name =>
  bot.action(`cmd:${name}`, async (ctx) => (await ctx.answerCbQuery(), ctx.reply(SOON)))
);

// Make a call
bot.action('cmd:make', async (ctx) => {
  await ctx.answerCbQuery();
  awaitingCA.add(String(ctx.from.id));
  await ctx.reply(
    'Paste the token address now:\n' +
    '• SOL: base58 (suffix “…pump” is OK)\n' +
    '• BSC: 0x + 40 hex',
    { parse_mode: 'HTML' }
  );
});

// PREMIUM: Subscribe
bot.action('cmd:subscribe', async (ctx) => {
  await ctx.answerCbQuery();
  if (!PREMIUM_SOL_WALLET) {
    return ctx.reply('Premium is temporarily unavailable. Please try again later.');
  }
  const payUrl = phantomPayLink(
    PREMIUM_SOL_WALLET,
    PREMIUM_PRICE_SOL,
    'Mooncall Premium (lifetime)',
    `Premium for @${ctx.from.username || ctx.from.id}`
  );

  const kb = Markup.inlineKeyboard([
    [Markup.button.url(`Pay ${PREMIUM_PRICE_SOL} SOL`, payUrl)],
    [Markup.button.callback('I Paid ✅', 'premium:paid')],
    [Markup.button.callback('Submit Tx Signature', 'premium:txsig')],
  ]);

  await ctx.reply(
    '⭐ <b>Premium</b>\n\n' +
    'Unlock <b>4 calls per day forever</b>.\n' +
    `Price: <b>${PREMIUM_PRICE_SOL} SOL</b>\n\n` +
    '1) Tap “Pay … SOL” and complete the transfer in your wallet.\n' +
    '2) Then tap “Submit Tx Signature” and paste your transaction signature.\n' +
    'If you can’t find your signature, tap “I Paid ✅” and we’ll review it.',
    { parse_mode: 'HTML', ...kb }
  );
});

bot.action('premium:paid', async (ctx) => {
  await ctx.answerCbQuery();
  const tgId = String(ctx.from.id);

  await PremiumUser.updateOne(
    { tgId },
    { $set: { pending: true }, $setOnInsert: { permanent: false, callsPerDay: 4 } },
    { upsert: true }
  );

  await ctx.reply('Thanks! Payment marked as pending. If you have the tx signature, tap "Submit Tx Signature" to auto-activate.');

  if (ADMIN_NOTIFY_ID) {
    await bot.telegram.sendMessage(
      ADMIN_NOTIFY_ID,
      `💰 <b>Payment marked as pending</b>\nUser: @${ctx.from.username || tgId} (${tgId})\nAmount: ${PREMIUM_PRICE_SOL} SOL`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.action('premium:txsig', async (ctx) => {
  await ctx.answerCbQuery();
  awaitingTxSig.add(String(ctx.from.id));
  await ctx.reply(
    'Please paste your <b>transaction signature</b>.\n' +
    'Tip: In Phantom → Recent Activity → the transaction → “Copy Signature”.',
    { parse_mode: 'HTML' }
  );
});

// Leaderboard
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

// Text intake (tx sig OR call)
bot.on('text', async (ctx) => {
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;
  const raw = (ctx.message?.text || '').trim();

  // 1) tx signature path
  if (awaitingTxSig.has(tgId)) {
    const maybeSig = raw.replace(/^https?:\/\/(www\.)?solscan\.io\/tx\//i, '').trim();
    if (!looksLikeSig(maybeSig)) {
      return ctx.reply('That does not look like a valid Solana signature. Please paste the signature only.');
    }
    await PremiumUser.updateOne(
      { tgId },
      { $set: { permanent: true, pending: false, callsPerDay: 4, lastPaymentTx: maybeSig } },
      { upsert: true }
    );
    awaitingTxSig.delete(tgId);

    await ctx.reply('✅ Premium activated! You can now make 4 calls/day (lifetime).');

    if (ADMIN_NOTIFY_ID) {
      await bot.telegram.sendMessage(
        ADMIN_NOTIFY_ID,
        `✅ <b>Premium auto-activated</b>\nUser: @${username} (${tgId})\nTx: <code>${maybeSig}</code>`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  // 2) token address flow
  const extracted = extractAddress(raw);
  if (!extracted) {
    if (awaitingCA.has(tgId)) {
      return ctx.reply(
        'That doesn’t look like a valid address.\n' +
        'Examples:\n• SOL: <code>6Vx…R1f</code> or <code>6Vx…R1fpump</code>\n• BSC: <code>0xAbC…123</code>',
        { parse_mode: 'HTML' }
      );
    }
    return; // ignore non-address messages
  }

  awaitingCA.delete(tgId);

  // daily limit
  if (!isAdmin(tgId)) {
    const limit = await getDailyLimit(tgId);
    const used = await callsInLast24h(tgId);
    if (used >= limit) {
      return ctx.reply(
        limit === 1
          ? 'You already made a call in the last 24h.'
          : `You reached your ${limit} calls in the last 24h.`
      );
    }
  }

  const caOrMint = extracted.value;

  // token info
  let info;
  try { info = await getTokenInfo(caOrMint); }
  catch (e) { console.error('price fetch failed:', e.message); }
  if (!info) return ctx.reply('Could not resolve token info (Dexscreener). Try another CA/mint.');

  const chainUpper = String(info.chain || '').toUpperCase();
  const normCa = normalizeCa(caOrMint, chainUpper);

  // dup check
  const existing = await Call.findOne({ ca: normCa, chain: chainUpper }).sort({ createdAt: -1 });
  if (existing) {
    const xNow = info.mc && existing.entryMc > 0 ? info.mc / existing.entryMc : null;
    const hit = xNow ? highestMilestone(xNow) : null;
    await ctx.reply(
      `⚠️ <b>Token already called</b> by @${existing.caller?.username || existing.caller?.tgId}.\n\n` +
      `Called MC: ${usd(existing.entryMc)}\n` +
      (xNow
        ? `Now MC: ${usd(info.mc)} — <b>${xNow.toFixed(2)}×</b> since call${hit ? ` (hit <b>${hit}×</b>)` : ''}.`
        : `Now MC: ${usd(info.mc)}.`),
      { parse_mode:'HTML', ...(existing.postedMessageId ? viewChannelButton(existing.postedMessageId) : {}) }
    );
    return;
  }

  // caller totals
  const userCalls = await Call.find({ 'caller.tgId': tgId });
  const totalCalls = userCalls.length;
  const totalX = userCalls.reduce((sum, c) => {
    if (!c.entryMc || c.entryMc <= 0) return sum;
    const peak = c.peakMc || c.entryMc;
    return sum + peak / c.entryMc;
  }, 0);
  const avgX = totalCalls ? totalX / totalCalls : 0;

  // urls
  const chartUrl =
    info.chartUrl ||
    (chainUpper === 'SOL'
      ? `https://dexscreener.com/solana/${encodeURIComponent(caOrMint)}`
      : `https://dexscreener.com/bsc/${encodeURIComponent(caOrMint)}`);
  const tradeUrl = info.tradeUrl || info.pairUrl || info.chartUrl || chartUrl;

  // bonding curve (Pump.fun only)
  let curveProgress = null;
  const createdOnName = info.dex || info.dexName || 'DEX';
  const looksPump = chainUpper === 'SOL' && (/pumpfun/i.test(createdOnName) || /pump$/i.test(raw));
  if (looksPump) {
    try { curveProgress = await fetchPumpfunProgress(caOrMint); } catch {} // ignore errors
  }

  // bubblemap (EVM only)
  const bubblemapUrl = info.bubblemapUrl || makeBubblemapUrl(chainUpper, normCa);

  // caption
  const caption = channelCardText({
    user: username,
    totals: { totalCalls, totalX, avgX },

    name: info.name,
    tkr: info.ticker || '',
    chain: chainUpper,
    mintOrCa: caOrMint,

    stats: { mc: info.mc, lp: info.lp, vol24h: info.vol24h },

    createdOnName,
    createdOnUrl: tradeUrl,
    dexPaid: info.dexPaid,

    curveProgress,                 // ← bonding curve %
    bubblemapUrl,
    burnPct: info.liquidityBurnedPct,
    freezeAuth: info.freezeAuthority,
    mintAuth: info.mintAuthority,

    twitterUrl: info.twitter,
    botUsername: BOT_USERNAME,
  });

  // post
  let messageId;
  try {
    const kb = tradeKeyboards(chainUpper, chartUrl);
    if (WANT_IMAGE && info.imageUrl) {
      const res = await ctx.telegram.sendPhoto(CH_ID, info.imageUrl, {
        caption, parse_mode: 'HTML', ...kb,
      });
      messageId = res?.message_id;
    } else {
      const res = await ctx.telegram.sendMessage(CH_ID, caption, {
        parse_mode: 'HTML', disable_web_page_preview: false, ...kb,
      });
      messageId = res?.message_id;
    }
  } catch (e) {
    console.error('send to channel failed:', e?.response?.description || e.message);
  }

  // save
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

// errors & launch
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
