// mooncall.js
require('dotenv').config();
require('./lib/db');

const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');
const Call = require('./model/call.model');
const PremiumUser = require('./model/premium.model');
const Boost = require('./model/boost.model');
const { getTokenInfo, usd } = require('./lib/price');
const { channelCardText, tradeKeyboards } = require('./card');

// --- minimal KV settings model (in this file) -------------------------------
const AppSetting =
  mongoose.models.AppSetting ||
  mongoose.model(
    'AppSetting',
    new mongoose.Schema(
      { _id: String, value: mongoose.Schema.Types.Mixed },
      { timestamps: true, collection: 'app_settings' }
    )
  );

// helpers to persist season start
async function getSeasonStart() {
  const doc = await AppSetting.findById('leaderboardSeasonStart').lean();
  if (!doc?.value) return null;
  const d = new Date(doc.value);
  return Number.isFinite(d.valueOf()) ? d : null;
}
async function setSeasonStart(d) {
  await AppSetting.findByIdAndUpdate(
    'leaderboardSeasonStart',
    { value: d.toISOString() },
    { upsert: true }
  );
}
async function clearSeasonStart() {
  await AppSetting.findByIdAndDelete('leaderboardSeasonStart');
}

// --- fetch polyfill (Node < 18) ---------------------------------------------
const doFetch =
  typeof fetch !== 'undefined'
    ? fetch
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// --- env / constants ---------------------------------------------------------
const bot = new Telegraf(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

// runtime-toggleable flag (can be changed via /lbhideadmins)
let LEADERBOARD_HIDE_ADMINS =
  String(process.env.LEADERBOARD_HIDE_ADMINS || '').toLowerCase() === 'true';

const CHANNEL_LINK = process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const WANT_IMAGE =
  String(process.env.CALL_CARD_USE_IMAGE || '').toLowerCase() === 'true';

const PREMIUM_SOL_WALLET = (process.env.PREMIUM_SOL_WALLET || '').trim();
const PREMIUM_PRICE_SOL = Number(process.env.PREMIUM_PRICE_SOL || 0.1);
const ADMIN_NOTIFY_ID = (process.env.ADMIN_NOTIFY_ID || '').trim();

// BOOST config
const BOOST_SOL_WALLET =
  (process.env.BOOST_SOL_WALLET || PREMIUM_SOL_WALLET || '').trim();
const BOOST_PRICE_SOL = Number(process.env.BOOST_PRICE_SOL || 1);
const BOOST_POSTS = Number(process.env.BOOST_POSTS || 24);
const BOOST_INTERVAL_MIN = Number(process.env.BOOST_INTERVAL_MIN || 60);

// for duplicate summary only
const MILESTONES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',')
  .map(Number)
  .filter((n) => n > 0)
  .sort((a, b) => a - b);

const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));
const SOON = '🚧 Available soon.';

// simple state flags
const awaitingCA = new Set(); // for /make
const awaitingTxSig = new Set(); // for premium

// boost flow state
const awaitingBoostCA = new Map(); // tgId -> { isAdmin: boolean }
const awaitingBoostTxSig = new Map(); // tgId -> boostId

// --- leaderboard cache (season-aware) ---------------------------------------
const LB_TTL_MS = 60_000; // 1 minute
let LB_CACHE = { rows: null, ts: 0, hideAdmins: null, seasonKey: null };

function fmtDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function rebuildLeaderboardCache(hideAdmins) {
  const seasonStart = await getSeasonStart();
  const rows = await Call.aggregate(
    leaderboardPipeline({ hideAdmins, seasonStart })
  ).exec();
  LB_CACHE = {
    rows,
    ts: Date.now(),
    hideAdmins,
    seasonKey: seasonStart ? fmtDate(seasonStart) : 'all',
  };
  return rows;
}

async function getLeaderboard(hideAdmins) {
  const seasonStart = await getSeasonStart();
  const seasonKey = seasonStart ? fmtDate(seasonStart) : 'all';

  if (
    LB_CACHE.rows &&
    Date.now() - LB_CACHE.ts < LB_TTL_MS &&
    LB_CACHE.hideAdmins === hideAdmins &&
    LB_CACHE.seasonKey === seasonKey
  ) {
    return LB_CACHE.rows;
  }
  return rebuildLeaderboardCache(hideAdmins);
}

// --- helpers -----------------------------------------------------------------
const cIdForPrivate = (id) => String(id).replace('-100', ''); // t.me/c/<id>/<msg>
function viewChannelButton(messageId) {
  if (!messageId) return Markup.inlineKeyboard([]);
  const shortId = cIdForPrivate(CH_ID);
  const url = `https://t.me/c/${shortId}/${messageId}`;
  return Markup.inlineKeyboard([[Markup.button.url('📣 View Channel', url)]]);
}
const highestMilestone = (x) => {
  let best = null;
  for (const m of MILESTONES) if (x >= m) best = m;
  return best;
};
const normalizeCa = (ca, chainUpper) =>
  chainUpper === 'BSC' ? String(ca || '').toLowerCase() : ca;

function isAdminUser(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}
function fmtUser(u, id) {
  return u && u !== 'undefined' ? `@${u}` : id;
}
function parseMsgIdFromLink(s = '') {
  const m = String(s).match(/t\.me\/c\/\d+\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

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
function looksLikeSig(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(String(s).trim());
}

// limits
async function getDailyLimit(tgId) {
  if (isAdmin(tgId)) return Infinity;
  const p = await PremiumUser.findOne({ tgId: String(tgId) }).lean();
  if (p?.permanent) return p.callsPerDay || 4;
  return 1;
}
async function callsInLast24h(tgId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  return Call.countDocuments({
    'caller.tgId': String(tgId),
    createdAt: { $gte: since },
  });
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

// Best-effort Pump.fun bonding-curve % fetch (SOL)
async function fetchPumpfunProgress(mint) {
  try {
    const clean = String(mint || '').replace(/pump$/i, '');

    // JSON endpoint
    let r = await doFetch(`https://pump.fun/api/data/${clean}`, {
      headers: { accept: 'application/json' },
    });
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
    // HTML fallback
    r = await doFetch(`https://pump.fun/coin/${clean}`, {
      headers: { accept: 'text/html' },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m =
      html.match(/"bonding(?:_curve_|Curve)progress"\s*:\s*([0-9.]+)/i) ||
      html.match(/"bondingCurveProgress"\s*:\s*([0-9.]+)/);
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
    ETH: 'eth',
    ETHEREUM: 'eth',
    BSC: 'bsc',
    ARBITRUM: 'arbitrum',
    ARB: 'arbitrum',
    BASE: 'base',
    OPTIMISM: 'optimism',
    OP: 'optimism',
    POLYGON: 'polygon',
    MATIC: 'polygon',
    AVALANCHE: 'avalanche',
    AVAX: 'avalanche',
  };
  const key = map[chainUpper];
  return key ? `https://app.bubblemaps.io/token/${key}/${ca}` : null;
}

// --- totals helper used by cards (filters out excluded calls) ---------------
async function getUserTotalsForCards(tgId) {
  const calls = await Call.find({
    'caller.tgId': String(tgId),
    entryMc: { $gt: 0 },
    peakMc: { $gt: 0 },
    $or: [
      { excludedFromLeaderboard: { $exists: false } },
      { excludedFromLeaderboard: { $ne: true } },
    ],
  }).lean();

  const totalCalls = calls.length;
  const totalX = calls.reduce((sum, c) => sum + c.peakMc / c.entryMc, 0);
  const avgX = totalCalls ? totalX / totalCalls : 0;
  return { totalCalls, totalX, avgX };
}

// --- UI: /start --------------------------------------------------------------
bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome to 🌕 Mooncall bot 🌕 .\n\n' +
      'Call tokens, track PnL, and compete for rewards.\n\n' +
      '» Each user can make 1 call per day\n' +
      '» Calls are tracked by PnL performance\n' +
      '» The top performer gets rewards + bragging rights',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('⚡ Telegram Channel', CHANNEL_LINK)],
        [Markup.button.callback('👥 Community Calls', 'cmd:community')],
        [Markup.button.callback('🏅 Top Callers', 'cmd:leaders')],
        [Markup.button.callback('🧾 Make a call', 'cmd:make')],
        [Markup.button.callback('📒 My calls', 'cmd:mycalls')],
        [Markup.button.callback('📜 Rules', 'cmd:rules')],
        [Markup.button.callback('⭐ Subscribe', 'cmd:subscribe')],
        [Markup.button.callback('🚀 Boost', 'cmd:boost')],
        [Markup.button.callback('⚡ Boosted Coins', 'cmd:boosted')],
      ]),
    }
  );

  const botLink = `https://t.me/${BOT_USERNAME}`;
  await ctx.reply(
    `Telegram\nMoon Call 🌕\nThe ultimate call channel ⚡👉:\n${CHANNEL_LINK}\n\n` +
      `Moon Call bot 👉: ${botLink}`
  );
});

// media guard
['photo', 'document', 'video', 'audio', 'sticker', 'voice'].forEach((t) =>
  bot.on(t, (ctx) => ctx.reply('This bot only accepts text token addresses.'))
);

// static buttons
bot.action(
  'cmd:rules',
  async (ctx) => (
    await ctx.answerCbQuery(),
    ctx.reply(
      '📜 <b>Rules</b>\n\n' +
        '• One call per user in 24h (admins are exempt).\n' +
        '• Paste a SOL mint (32–44 chars) or BSC 0x address.\n' +
        '• We track PnLs & post milestone alerts.\n' +
        '• Best performers climb the leaderboard.',
      { parse_mode: 'HTML' }
    )
  )
);

// community still "soon"
bot.action('cmd:community', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(SOON);
});

// --- Slash command mirrors ---------------------------------------------------
function promptMakeCall(ctx) {
  awaitingCA.add(String(ctx.from.id));
  return ctx.reply(
    'Paste the token address now:\n' +
      '• SOL: is accepted\n' +
      '• BSC: is accepted 🆕🆕',
    { parse_mode: 'HTML' }
  );
}
bot.action('cmd:make', async (ctx) => (await ctx.answerCbQuery(), promptMakeCall(ctx)));
bot.command('make', promptMakeCall);
bot.command('rules', (ctx) =>
  ctx.reply(
    '📜 <b>Rules</b>\n\n' +
      '• One call per user in 24h (admins are exempt).\n' +
      '• Paste a SOL mint (32–44 chars) or BSC 0x address.\n' +
      '• We track PnLs & post milestone alerts.\n' +
      '• Best performers climb the leaderboard.',
    { parse_mode: 'HTML' }
  )
);
bot.command('help', (ctx) =>
  ctx.reply(
    'Commands:\n' +
      '/start – open menu\n' +
      '/make – make a call\n' +
      '/leaders – top callers\n' +
      '/leaders_all – top callers (admins included)\n' +
      '/mycalls – list your last 10 calls\n' +
      '/rules – rules\n' +
      '/subscribe – premium info\n' +
      '/boost – boost a token\n' +
      '/boosted – list boosted tokens\n' +
      '/booststop – stop boosted token (admin)\n' +
      '/ping – check bot',
    { parse_mode: 'HTML' }
  )
);
bot.command('ping', (ctx) => ctx.reply('pong ✅'));

// PREMIUM flow ---------------------------------------------------------------
bot.action('cmd:subscribe', async (ctx) => {
  await ctx.answerCbQuery();
  return handleSubscribe(ctx);
});
bot.command('subscribe', handleSubscribe);
async function handleSubscribe(ctx) {
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
}
bot.action('premium:paid', async (ctx) => {
  await ctx.answerCbQuery();
  const tgId = String(ctx.from.id);
  await PremiumUser.updateOne(
    { tgId },
    { $set: { pending: true }, $setOnInsert: { permanent: false, callsPerDay: 4 } },
    { upsert: true }
  );
  await ctx.reply(
    'Thanks! Payment marked as pending. If you have the tx signature, tap "Submit Tx Signature" to auto-activate.'
  );
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

// --- BOOST FLOW --------------------------------------------------------------
async function boostMenuHandler(ctx) {
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery();
  const tgId = String(ctx.from.id);
  const admin = isAdmin(tgId);

  if (!BOOST_SOL_WALLET && !admin) {
    return ctx.reply('Boost is temporarily unavailable. Please try again later.');
  }

  awaitingBoostCA.set(tgId, { isAdmin: admin });

  const priceLine = admin
    ? 'As an admin, your boost is <b>free</b>.'
    : `Price: <b>${BOOST_PRICE_SOL} SOL</b> for 24h (posted every hour).`;

  return ctx.reply(
    '🚀 <b>Boost your token</b>\n\n' +
      'Send the token address you want to boost (SOL mint or BSC 0x CA).\n' +
      'We will advertise it in the channel every hour for 24 hours.\n\n' +
      priceLine + '\n\n' +
      (admin
        ? 'Paste the CA now.'
        : 'After you send the CA we will give you a payment link and ask for the transaction signature.'),
    { parse_mode: 'HTML' }
  );
}

async function boostedListHandler(ctx) {
  if (ctx.updateType === 'callback_query') await ctx.answerCbQuery();
  const now = new Date();

  const boosts = await Boost.find({
    status: 'active',
    expiresAt: { $gt: now },
    postsRemaining: { $gt: 0 },
  })
    .sort({ expiresAt: 1 })
    .limit(20)
    .lean();

  if (!boosts.length) {
    return ctx.reply('No tokens are currently boosted.');
  }

  const lines = boosts.map((b) => {
    const hoursLeft = Math.max(
      0,
      Math.round((b.expiresAt - now) / (60 * 60 * 1000))
    );
    const shortCa =
      b.ca.length > 12 ? `${b.ca.slice(0, 4)}…${b.ca.slice(-4)}` : b.ca;
    const byUser = fmtUser(b.requester?.username, b.requester?.tgId);
    return `• ${b.chain} ${shortCa} — ${hoursLeft}h left (by ${byUser})`;
  });

  return ctx.reply('⚡ <b>Boosted tokens</b>\n\n' + lines.join('\n'), {
    parse_mode: 'HTML',
  });
}

bot.action('cmd:boost', boostMenuHandler);
bot.command('boost', boostMenuHandler);

bot.action('cmd:boosted', boostedListHandler);
bot.command('boosted', boostedListHandler);

// --- Admin: stop/cancel boosted token(s) ------------------------------------
bot.command('booststop', async (ctx) => {
  if (!isAdminUser(ctx)) return; // only admins

  const arg = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  if (!arg) {
    return ctx.reply('Usage: /booststop <CA or mint>');
  }

  // Try to parse address, otherwise use raw text
  const extracted = extractAddress(arg);
  const caKey = extracted ? extracted.value : arg.trim();

  // Match CA case-insensitively (BSC is lowercased in DB)
  const query = {
    ca: new RegExp(`^${caKey}$`, 'i'),
    status: { $in: ['active', 'await_payment'] },
  };

  const res = await Boost.updateMany(query, {
    $set: { status: 'cancelled', postsRemaining: 0 },
  });

  const modified = res.modifiedCount ?? res.nModified ?? 0;

  if (!modified) {
    return ctx.reply('No active/awaiting boosts found for that CA.');
  }

  await ctx.reply(
    `🛑 Stopped ${modified} boost(s) for CA:\n<code>${caKey}</code>`,
    { parse_mode: 'HTML' }
  );
});

// --- Leaderboard pipeline (season-aware) ------------------------------------
function leaderboardPipeline({ hideAdmins = false, seasonStart = null } = {}) {
  const matchStages = [
    { entryMc: { $gt: 0 } },
    { peakMc: { $gt: 0 } },
    {
      $or: [
        { excludedFromLeaderboard: { $exists: false } },
        { excludedFromLeaderboard: { $ne: true } },
      ],
    },
  ];
  if (hideAdmins && ADMIN_IDS.length) {
    matchStages.push({ 'caller.tgId': { $nin: ADMIN_IDS.map(String) } });
  }
  if (seasonStart instanceof Date) {
    matchStages.push({ createdAt: { $gte: seasonStart } });
  }
  return [
    { $match: { $and: matchStages } },
    {
      $project: {
        user: '$caller.username',
        tgId: '$caller.tgId',
        x: { $divide: ['$peakMc', '$entryMc'] },
      },
    },
    { $group: { _id: { user: '$user', tgId: '$tgId' }, sumX: { $sum: '$x' } } },
    { $sort: { sumX: -1 } },
    { $limit: 10 },
  ];
}

// Leaderboard commands --------------------------------------------------------
bot.action('cmd:leaders', leadersHandler(false));
bot.command('leaders', leadersHandler(false));
bot.command('leaders_all', leadersHandler(true));
function leadersHandler(forceAll) {
  return async (ctx) => {
    try {
      if (ctx.updateType === 'callback_query') await ctx.answerCbQuery();
      const hideAdmins = forceAll ? false : LEADERBOARD_HIDE_ADMINS;
      const rows = await getLeaderboard(hideAdmins);
      if (!rows.length) return ctx.reply('No leaderboard data yet — make a call!');

      const seasonStart = await getSeasonStart();
      const seasonLine = seasonStart
        ? ` (Season since ${fmtDate(seasonStart)})`
        : '';

      const medal = (i) =>
        i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const lines = rows.map(
        (r, i) =>
          `${medal(i)} ${fmtUser(r._id.user, r._id.tgId)} — ${r.sumX.toFixed(
            2
          )}× total`
      );
      await ctx.reply(`🏆 <b>Top Callers</b>${seasonLine}\n` + lines.join('\n'), {
        parse_mode: 'HTML',
      });
    } catch (e) {
      console.error(e);
      await ctx.reply('Failed to load leaderboard.');
    }
  };
}

// Admin: force refresh leaderboard cache
bot.command('lbrefresh', async (ctx) => {
  if (!isAdminUser(ctx)) return;
  try {
    const rows = await rebuildLeaderboardCache(LEADERBOARD_HIDE_ADMINS);
    await ctx.reply(`♻️ Leaderboard rebuilt (${rows.length} rows).`);
  } catch (e) {
    console.error(e);
    await ctx.reply('Failed to rebuild leaderboard.');
  }
});

// Admin: toggle hide-admins at runtime
bot.command('lbhideadmins', async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const arg = (ctx.message.text || '').split(/\s+/)[1]?.toLowerCase();
  if (!arg || !['on', 'off'].includes(arg)) {
    return ctx.reply('Usage: /lbhideadmins on|off');
  }
  LEADERBOARD_HIDE_ADMINS = arg === 'on';
  LB_CACHE = { rows: null, ts: 0, hideAdmins: null, seasonKey: null };
  await ctx.reply(
    `✅ Hide-admins on /leaders: ${LEADERBOARD_HIDE_ADMINS ? 'ON' : 'OFF'}`
  );
});

// Admin: SEASON controls ------------------------------------------------------
bot.command('lbseason', async (ctx) => {
  if (!isAdminUser(ctx)) return;

  const parts = (ctx.message.text || '').trim().split(/\s+/).slice(1);
  const sub = (parts[0] || '').toLowerCase();

  try {
    if (sub === 'get' || !sub) {
      const s = await getSeasonStart();
      return ctx.reply(
        s
          ? `📅 Current season since: <b>${fmtDate(s)}</b>`
          : '📅 Season: <b>ALL-TIME</b>',
        { parse_mode: 'HTML' }
      );
    }

    if (sub === 'reset') {
      const now = new Date();
      await setSeasonStart(now);
      LB_CACHE = { rows: null, ts: 0, hideAdmins: null, seasonKey: null };
      return ctx.reply(
        `🆕 New season started: <b>${fmtDate(now)}</b> (totals reset)`,
        { parse_mode: 'HTML' }
      );
    }

    if (sub === 'set') {
      const d = new Date(parts[1]);
      if (!parts[1] || !Number.isFinite(d.valueOf())) {
        return ctx.reply('Usage: /lbseason set YYYY-MM-DD');
      }
      await setSeasonStart(d);
      LB_CACHE = { rows: null, ts: 0, hideAdmins: null, seasonKey: null };
      return ctx.reply(`✅ Season start set to <b>${fmtDate(d)}</b>`, {
        parse_mode: 'HTML',
      });
    }

    if (sub === 'clear') {
      await clearSeasonStart();
      LB_CACHE = { rows: null, ts: 0, hideAdmins: null, seasonKey: null };
      return ctx.reply('🔁 Season cleared — leaderboard is ALL-TIME again.');
    }

    return ctx.reply('Usage: /lbseason get | reset | set YYYY-MM-DD | clear');
  } catch (e) {
    console.error(e);
    return ctx.reply('Failed to update season.');
  }
});

// My calls (button + /mycalls) -----------------------------------------------
bot.action('cmd:mycalls', myCallsHandler);
bot.command('mycalls', myCallsHandler);
async function myCallsHandler(ctx) {
  try {
    if (ctx.updateType === 'callback_query') await ctx.answerCbQuery();
    const tgId = String(ctx.from.id);
    const list = await Call.find({ 'caller.tgId': tgId })
      .sort({ createdAt: -1 })
      .limit(10);
    if (!list.length) return ctx.reply('You have no calls yet.');
    const lines = list.map((c) => {
      const entry = usd(c.entryMc);
      const now = usd(c.lastMc);
      const tkr = c.ticker ? `$${c.ticker}` : '—';
      return `• ${tkr}\n   MC when called: ${entry}\n   MC now: ${now}`;
    });
    await ctx.reply(
      `🧾 <b>Your calls</b> (@${ctx.from.username || tgId})\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error(e);
  }
}

// --- Admin MEV/curation tools -----------------------------------------------
bot.command('exclude', async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const arg = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply('Usage: /exclude <t.me link | CA>');
  const msgId = parseMsgIdFromLink(arg);
  const q = msgId ? { postedMessageId: msgId } : { ca: arg.trim() };
  const res = await Call.updateMany(q, { $set: { excludedFromLeaderboard: true } });
  await ctx.reply(`✅ Excluded ${res.modifiedCount} call(s) from leaderboard.`);
});

bot.command('include', async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const arg = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply('Usage: /include <t.me link | CA>');
  const msgId = parseMsgIdFromLink(arg);
  const q = msgId ? { postedMessageId: msgId } : { ca: arg.trim() };
  const res = await Call.updateMany(q, { $set: { excludedFromLeaderboard: false } });
  await ctx.reply(`✅ Included ${res.modifiedCount} call(s) back in leaderboard.`);
});

bot.command('capx', async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const parts = (ctx.message.text || '').split(' ').slice(1);
  if (parts.length < 2) return ctx.reply('Usage: /capx <t.me link | CA> <xCap>');
  const cap = Number(parts.pop());
  const key = parts.join(' ');
  if (!Number.isFinite(cap) || cap <= 0)
    return ctx.reply('Cap must be a positive number (e.g., 200).');

  const msgId = parseMsgIdFromLink(key);
  const q = msgId ? { postedMessageId: msgId } : { ca: key.trim() };
  const docs = await Call.find(q).limit(20);
  if (!docs.length) return ctx.reply('No matching calls found.');

  let changed = 0;
  for (const c of docs) {
    if (!c.entryMc || c.entryMc <= 0) continue;
    const maxPeak = c.entryMc * cap;
    const newPeak = Math.min(c.peakMc || c.entryMc, maxPeak);
    if (newPeak !== c.peakMc) {
      c.peakMc = newPeak;
      if (c.lastMc > newPeak) c.lastMc = newPeak;
      c.peakLocked = true;
      await c.save();
      changed++;
    }
  }
  await ctx.reply(`✅ Capped ${changed} call(s) at ${cap}×. (peaks locked)`);
});

// --- FIXED settotalx: match leaderboard scope (season + exclusions) ---------
bot.command('settotalx', async (ctx) => {
  if (!isAdminUser(ctx)) return;

  const parts = (ctx.message.text || '').split(' ').slice(1);
  if (parts.length < 2) {
    return ctx.reply('Usage: /settotalx <@username | tgId> <targetX>');
  }

  const target = Number(parts.pop());
  const who = parts.join(' ').trim();

  if (!Number.isFinite(target) || target <= 0) {
    return ctx.reply('targetX must be a positive number.');
  }

  const username = who.startsWith('@') ? who.slice(1) : null;
  const baseUserQuery = username
    ? { 'caller.username': username }
    : { 'caller.tgId': String(who) };

  const seasonStart = await getSeasonStart();

  const query = {
    ...baseUserQuery,
    entryMc: { $gt: 0 },
    peakMc: { $gt: 0 },
    $or: [
      { excludedFromLeaderboard: { $exists: false } },
      { excludedFromLeaderboard: { $ne: true } },
    ],
    ...(seasonStart instanceof Date ? { createdAt: { $gte: seasonStart } } : {}),
  };

  const docs = await Call.find(query).exec();

  if (!docs.length) {
    return ctx.reply(
      'No leaderboard-eligible calls found for that user (check season/exclusions).'
    );
  }

  // current total X in leaderboard scope
  let current = 0;
  for (const d of docs) {
    current += d.peakMc / d.entryMc;
  }

  if (!Number.isFinite(current) || current <= 0) {
    return ctx.reply('Current total X is not valid for this user.');
  }

  const factor = target / current; // scale all X in-scope to reach target

  let changed = 0;
  let newTotal = 0;

  for (const d of docs) {
    const baseX = d.peakMc / d.entryMc;
    const newX = baseX * factor;
    const newPeak = d.entryMc * newX;

    if (!Number.isFinite(newPeak) || newPeak <= 0) continue;

    d.peakMc = newPeak;
    if (d.lastMc > newPeak) d.lastMc = newPeak;
    d.peakLocked = true;
    await d.save();

    changed++;
    newTotal += newX;
  }

  // Invalidate leaderboard cache so /leaders uses new values
  LB_CACHE = { rows: null, ts: 0, hideAdmins: null, seasonKey: null };

  // Optional: warm cache best-effort
  try {
    await rebuildLeaderboardCache(LEADERBOARD_HIDE_ADMINS);
  } catch {}

  const seasonLine =
    seasonStart instanceof Date ? ` (season since ${fmtDate(seasonStart)})` : '';

  await ctx.reply(
    `✅ Forced total X for ${who} to ≈ ${newTotal.toFixed(
      2
    )}×${seasonLine} (target: ${target}×, updated ${changed} call(s), peaks locked).`
  );
});

bot.command('unlockpeak', async (ctx) => {
  if (!isAdminUser(ctx)) return;
  const arg = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply('Usage: /unlockpeak <t.me link | CA>');
  const msgId = parseMsgIdFromLink(arg);
  const q = msgId ? { postedMessageId: msgId } : { ca: arg.trim() };
  const res = await Call.updateMany(q, { $set: { peakLocked: false } });
  await ctx.reply(`🔓 Unlocked peaks on ${res.modifiedCount} call(s).`);
});

// --- BOOST helper to create boost from CA -----------------------------------
async function handleBoostAddress(ctx, { extracted, username, tgId, boostState }) {
  const caOrMint = extracted.value;

  let info;
  try {
    info = await getTokenInfo(caOrMint);
  } catch (e) {
    console.error('boost price fetch failed:', e.message);
  }
  if (!info) {
    await ctx.reply(
      'Could not resolve token info (Dexscreener) for that address. Try another CA/mint.'
    );
    return;
  }

  const chainUpper = String(info.chain || '').toUpperCase();
  const normCa = normalizeCa(caOrMint, chainUpper);
  const isAdminFlag = boostState.isAdmin;

  // --- ADMIN: free boost ----------------------------------------------------
  if (isAdminFlag) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Boost.create({
      ca: normCa,
      chain: chainUpper,
      requester: { tgId, username },
      paid: true,
      freeByAdmin: true,
      status: 'active',
      postsRemaining: BOOST_POSTS,
      nextPostAt: new Date(),
      expiresAt,
    });

    await ctx.reply(
      `✅ Admin boost started for <b>${
        info.ticker || info.name || 'token'
      }</b>.\n` +
        `It will be posted every hour for the next 24 hours.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // --- Normal user: needs payment ------------------------------------------
  if (!BOOST_SOL_WALLET || !Number.isFinite(BOOST_PRICE_SOL) || BOOST_PRICE_SOL <= 0) {
    await ctx.reply('Boost payments are not configured. Please contact an admin.');
    return;
  }

  const payUrl = phantomPayLink(
    BOOST_SOL_WALLET,
    BOOST_PRICE_SOL,
    'Mooncall Boost (24h)',
    `Boost for @${username || tgId} ${info.ticker || chainUpper}`
  );

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const boost = await Boost.create({
    ca: normCa,
    chain: chainUpper,
    requester: { tgId, username },
    paid: false,
    freeByAdmin: false,
    status: 'await_payment',
    postsRemaining: BOOST_POSTS,
    expiresAt,
  });

  awaitingBoostTxSig.set(tgId, String(boost._id));

  const kb = Markup.inlineKeyboard([
    [Markup.button.url(`Pay ${BOOST_PRICE_SOL} SOL`, payUrl)],
  ]);

  await ctx.reply(
    '🚀 <b>Boost created</b>\n\n' +
      `Token: <b>${info.ticker || info.name || chainUpper}</b>\n` +
      `Price: <b>${BOOST_PRICE_SOL} SOL</b>\n\n` +
      '1) Tap “Pay … SOL” and complete the transfer in your wallet.\n' +
      '2) Then <b>paste the transaction signature here</b>.\n\n' +
      'Once we receive the signature, your token will be posted every hour for 24 hours.',
    { parse_mode: 'HTML', ...kb }
  );
}

// Token intake & posting ------------------------------------------------------
bot.on('text', async (ctx) => {
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;
  const raw = (ctx.message?.text || '').trim();

  // --- short-circuit slash commands so they never hit the CA parser --------
  if (raw.startsWith('/boost')) {
    awaitingCA.delete(tgId);
    awaitingBoostCA.delete(tgId);
    awaitingBoostTxSig.delete(tgId);
    return boostMenuHandler(ctx);
  }

  if (raw.startsWith('/boosted')) {
    awaitingCA.delete(tgId);
    awaitingBoostCA.delete(tgId);
    awaitingBoostTxSig.delete(tgId);
    return boostedListHandler(ctx);
  }

  // 1) PREMIUM tx signature path --------------------------------------------
  if (awaitingTxSig.has(tgId)) {
    const maybeSig = raw
      .replace(/^https?:\/\/(www\.)?solscan\.io\/tx\//i, '')
      .trim();
    if (!looksLikeSig(maybeSig)) {
      return ctx.reply(
        'That does not look like a valid Solana signature. Please paste the signature only.'
      );
    }
    await PremiumUser.updateOne(
      { tgId },
      {
        $set: {
          permanent: true,
          pending: false,
          callsPerDay: 4,
          lastPaymentTx: maybeSig,
        },
      },
      { upsert: true }
    );
    awaitingTxSig.delete(tgId);

    await ctx.reply(
      '✅ Premium activated! You can now make 4 calls/day (lifetime).'
    );

    if (ADMIN_NOTIFY_ID) {
      await bot.telegram.sendMessage(
        ADMIN_NOTIFY_ID,
        `✅ <b>Premium auto-activated</b>\nUser: @${username} (${tgId})\nTx: <code>${maybeSig}</code>`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  // 1b) BOOST tx signature path ---------------------------------------------
  const boostId = awaitingBoostTxSig.get(tgId);
  if (boostId) {
    const maybeSig = raw
      .replace(/^https?:\/\/(www\.)?solscan\.io\/tx\//i, '')
      .trim();
    if (!looksLikeSig(maybeSig)) {
      return ctx.reply(
        'That does not look like a valid Solana signature. Please paste the signature only.'
      );
    }

    const boost = await Boost.findById(boostId);
    if (!boost) {
      awaitingBoostTxSig.delete(tgId);
      return ctx.reply('Could not find your pending boost. Please use /boost again.');
    }
    if (boost.status !== 'await_payment') {
      awaitingBoostTxSig.delete(tgId);
      return ctx.reply('This boost is already processed.');
    }

    boost.status = 'active';
    boost.txSig = maybeSig;
    boost.paid = true;
    boost.nextPostAt = new Date();
    await boost.save();

    awaitingBoostTxSig.delete(tgId);

    await ctx.reply(
      '✅ Boost activated!\nYour token will be posted every hour for the next 24 hours.',
      { parse_mode: 'HTML' }
    );

    if (ADMIN_NOTIFY_ID) {
      await bot.telegram.sendMessage(
        ADMIN_NOTIFY_ID,
        `⚡ <b>New paid boost</b>\nUser: @${username} (${tgId})\nToken: ${boost.chain} ${boost.ca}\nTx: <code>${maybeSig}</code>`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  // 2) token address / boost / call flow ------------------------------------
  const extracted = extractAddress(raw);

  // 2a) If user is in "awaitingBoostCA" mode -> treat as boost CA
  const boostState = awaitingBoostCA.get(tgId);
  if (boostState) {
    if (!extracted) {
      return ctx.reply(
        'That doesn’t look like a valid address.\n' +
          'Paste a SOL mint (32–44 chars) or BSC 0x address for the token you want to boost.'
      );
    }
    awaitingBoostCA.delete(tgId);
    await handleBoostAddress(ctx, { extracted, username, tgId, boostState });
    return;
  }

  // 2b) normal call flow ----------------------------------------------------
  if (!extracted) {
    if (awaitingCA.has(tgId)) {
      return ctx.reply(
        'That doesn’t look like a valid address.\n' +
          'Examples:\n• SOL: <code>6Vx…R1f</code> or <code>6Vx…R1fpump</code>\n• BSC: <code>0xAbC…123</code>',
        { parse_mode: 'HTML' }
      );
    }
    return;
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
  try {
    info = await getTokenInfo(caOrMint);
  } catch (e) {
    console.error('price fetch failed:', e.message);
  }
  if (!info) {
    return ctx.reply(
      'Could not resolve token info (Dexscreener). Try another CA/mint.'
    );
  }

  const chainUpper = String(info.chain || '').toUpperCase();
  const normCa = normalizeCa(caOrMint, chainUpper);

  // dup check — show *capped* MC/X using saved peak (respects admin trims)
  const existing = await Call.findOne({ ca: normCa, chain: chainUpper }).sort({
    createdAt: -1,
  });
  if (existing) {
    const live = Number(info.mc) || 0;
    const peak = Number(existing.peakMc) || live;
    const nowMcCapped = Math.min(live, peak);
    const xNow =
      existing.entryMc > 0 ? nowMcCapped / existing.entryMc : null;
    const hit = xNow ? highestMilestone(xNow) : null;
    await ctx.reply(
      `⚠️ <b>Token already called</b> by ${fmtUser(
        existing.caller?.username,
        existing.caller?.tgId
      )}.\n\n` +
        `Called MC: ${usd(existing.entryMc)}\n` +
        (xNow
          ? `Now MC: ${usd(
              nowMcCapped
            )} — <b>${xNow.toFixed(2)}×</b> since call${
              hit ? ` (hit <b>${hit}×</b>)` : ''
            }.`
          : `Now MC: ${usd(nowMcCapped)}.`),
      {
        parse_mode: 'HTML',
        ...(existing.postedMessageId
          ? viewChannelButton(existing.postedMessageId)
          : {}),
      }
    );
    return;
  }

  // caller totals (FILTERED like leaderboard)
  const { totalCalls, totalX, avgX } = await getUserTotalsForCards(tgId);

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
  const looksPump =
    chainUpper === 'SOL' &&
    (/\bpump(fun|swap)?\b/i.test(String(createdOnName || '')) ||
      /\bpump$/i.test(String(caOrMint || '')) ||
      /\bpump$/i.test(String(raw || '')));
  if (looksPump) {
    try {
      curveProgress = await fetchPumpfunProgress(caOrMint);
    } catch {}
  }

  // bubblemap (EVM only)
  const bubblemapUrl =
    info.bubblemapUrl || makeBubblemapUrl(chainUpper, normCa);

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
    curveProgress,
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
    console.error(
      'send to channel failed:',
      e?.response?.description || e.message
    );
  }

  // save
  await Call.create({
    ca: normCa,
    chain: chainUpper,
    ticker: info.ticker || undefined,
    entryMc: info.mc || 0,
    peakMc: info.mc || 0,
    lastMc: info.mc || 0,
    peakLocked: false,
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

  // touch leaderboard cache (best-effort)
  try {
    await rebuildLeaderboardCache(LEADERBOARD_HIDE_ADMINS);
  } catch {}
});

// --- BOOST SCHEDULER: posts boosted tokens every BOOST_INTERVAL_MIN minutes --
async function runBoostScheduler() {
  const now = new Date();
  try {
    const boosts = await Boost.find({
      status: 'active',
      nextPostAt: { $lte: now },
      expiresAt: { $gt: now },
      postsRemaining: { $gt: 0 },
    })
      .sort({ nextPostAt: 1 })
      .limit(10)
      .lean();

    if (!boosts.length) return;

    for (const b of boosts) {
      try {
        let info = null;
        try {
          info = await getTokenInfo(b.ca);
        } catch (e) {
          console.error('boost: getTokenInfo failed', e.message);
        }

        const byUser = fmtUser(b.requester?.username, b.requester?.tgId);
        const baseText =
          `🚀 <b>Boosted token</b>\n` +
          `By: ${byUser}\n\n` +
          `Chain: <b>${b.chain}</b>\n` +
          `CA: <code>${b.ca}</code>\n\n`;

        let extra = '';
        if (info) {
          const mc = usd(info.mc);
          extra =
            `${info.ticker ? `Ticker: <b>${info.ticker}</b>\n` : ''}` +
            `Market Cap: <b>${mc}</b>\n`;
        }

        const text = baseText + extra;

        const chainUpper = String(b.chain || '').toUpperCase();
        const chartUrl =
          info?.chartUrl ||
          (chainUpper === 'SOL'
            ? `https://dexscreener.com/solana/${encodeURIComponent(b.ca)}`
            : `https://dexscreener.com/bsc/${encodeURIComponent(b.ca)}`);
        const kb = tradeKeyboards(chainUpper, chartUrl);

        await bot.telegram.sendMessage(CH_ID, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          ...kb,
        });

        const next = new Date(now.getTime() + BOOST_INTERVAL_MIN * 60 * 1000);

        const res = await Boost.findByIdAndUpdate(
          b._id,
          {
            $set: { lastPostAt: now, nextPostAt: next },
            $inc: { postsRemaining: -1 },
          },
          { new: true }
        ).lean();

        if (!res || res.postsRemaining <= 0 || res.expiresAt <= now) {
          await Boost.updateOne(
            { _id: b._id },
            { $set: { status: 'finished' } }
          );
        }
      } catch (e) {
        console.error('boost scheduler error for boost', b._id, e);
      }
    }
  } catch (e) {
    console.error('boost scheduler tick failed', e);
  }
}

setInterval(runBoostScheduler, 60_000);

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
