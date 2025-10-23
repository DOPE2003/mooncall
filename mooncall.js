// mooncall.js
require('dotenv').config();
require('./lib/db');

const { Telegraf, Markup } = require('telegraf');
const Call = require('./model/call.model');
const PremiumUser = require('./model/premium.model'); // ✅ premium model (uses mongoose)
const { getTokenInfo, isSolMint, isBsc, usd } = require('./lib/price');
const { channelCardText, tradeKeyboards } = require('./card');

// --- env / constants ---------------------------------------------------------
const bot = new Telegraf(process.env.BOT_TOKEN);
const CH_ID = Number(process.env.ALERTS_CHANNEL_ID);
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const CHANNEL_LINK = process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';
const WANT_IMAGE = String(process.env.CALL_CARD_USE_IMAGE || '').toLowerCase() === 'true';

// premium / payments
const PREMIUM_WALLET = process.env.PREMIUM_SOL_WALLET || '64Um13jy1E2ApiDwwPx5mYK3QQZ2fzLknPYvdvWxF5mZ';
const PREMIUM_PRICE = Number(process.env.PREMIUM_PRICE_SOL || 0.1);
const ADMIN_NOTIFY_ID = process.env.ADMIN_NOTIFY_ID ? String(process.env.ADMIN_NOTIFY_ID) : null;

// just for duplicate summary text if needed
const MILESTONES = String(process.env.MILESTONES || '2,3,4,5,6,7,8')
  .split(',')
  .map(n => Number(n))
  .filter(n => n > 0)
  .sort((a, b) => a - b);

const isAdmin = tgId => ADMIN_IDS.includes(String(tgId));
const awaitingCA = new Set();        // flow: "Make a call"
const awaitingSig = new Set();       // flow: "Submit Tx Signature"
const SOON = '🚧 Available soon.';

// ---------- helpers ----------
const cIdForPrivate = id => String(id).replace('-100', '');
function viewChannelButton(messageId) {
  if (!messageId) return Markup.inlineKeyboard([]);
  const shortId = cIdForPrivate(CH_ID);
  const url = `https://t.me/c/${shortId}/${messageId}`;
  return Markup.inlineKeyboard([[Markup.button.url('📣 View Channel', url)]]);
}
const highestMilestone = (x) => { let best = null; for (const m of MILESTONES) if (x >= m) best = m; return best; };
const normalizeCa = (ca, chainUpper) => chainUpper === 'BSC' ? String(ca || '').toLowerCase() : ca;

function phantomPayUrl({ to, amount, label, message, reference }) {
  // Telegram accepts ONLY http/https. This universal link opens Phantom on mobile/desktop.
  // Docs: https://phantom.app/ul/transfer
  const base = 'https://phantom.app/ul/transfer';
  const p = new URLSearchParams({
    to,
    amount: String(amount),              // decimal
    token: 'SOL',
    network: 'mainnet-beta',
    label: label || 'Payment',
    message: message || '',
  });
  if (reference) p.append('reference', String(reference));
  return `${base}?${p.toString()}`;
}

async function getDailyLimit(tgId) {
  if (isAdmin(tgId)) return Infinity;
  const p = await PremiumUser.findOne({ tgId: String(tgId) }).lean();
  if (p && p.permanent) return Math.max(1, p.callsPerDay || 4); // lifetime 4/day
  return 1;
}

// rough test if text could be a Solana tx signature (base58-ish length)
function looksLikeSig(s) {
  const b58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return typeof s === 'string' && s.length >= 40 && s.length <= 120 && b58.test(s);
}

// ---------- /start ----------
bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome to 🌖 Mooncall bot 🌖 .\n\n' +
      'Call tokens, track PnL, and compete for rewards.\n\n' +
      '» Each user can make 1 call per day (admins unlimited, premium 4/day)\n' +
      '» Calls are tracked by PnL performance\n' +
      '» The top performer gets rewards + bragging rights',
    { parse_mode: 'HTML',
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
      ])
    }
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
  '• One call per user in 24h (admins unlimited; premium 4/day).\n' +
  '• Paste a SOL mint (32–44 chars) or BSC 0x address.\n' +
  '• We track PnLs & post milestone alerts.\n' +
  '• Best performers climb the leaderboard.', { parse_mode:'HTML' })));

['community','boost','boosted'].forEach(name =>
  bot.action(`cmd:${name}`, async (ctx) => (await ctx.answerCbQuery(), ctx.reply(SOON)))
);

// ---------- Subscribe / Premium ----------
bot.action('cmd:subscribe', async (ctx) => {
  await ctx.answerCbQuery();

  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;

  const payUrl = phantomPayUrl({
    to: PREMIUM_WALLET,
    amount: PREMIUM_PRICE,
    label: 'Mooncall Premium (lifetime)',
    message: `Premium for @${username}`,
    reference: tgId, // just an identifier for you
  });

  const kb = Markup.inlineKeyboard([
    [Markup.button.url(`💳 Pay ${PREMIUM_PRICE} SOL`, payUrl)],
    [Markup.button.callback('✅ Submit Tx Signature', 'cmd:submit_tx')],
  ]);

  await ctx.reply(
    '⭐ <b>Premium</b>\n\n' +
    'Unlock <b>4 calls per day forever</b>.\n' +
    `Price: <b>${PREMIUM_PRICE} SOL</b>\n\n` +
    '1) Tap “Pay” and complete the transfer.\n' +
    '2) Then tap “Submit Tx Signature” and paste your transaction signature.\n' +
    'We’ll activate you right after verification.',
    { parse_mode: 'HTML', ...kb }
  );
});

bot.action('cmd:submit_tx', async (ctx) => {
  await ctx.answerCbQuery();
  const tgId = String(ctx.from.id);
  awaitingSig.add(tgId);
  await ctx.reply('Please paste your <b>transaction signature</b> for the premium payment:', { parse_mode: 'HTML' });
});

// ---------- Leaderboard ----------
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

// ---------- My calls ----------
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
    await ctx.reply(`🧾 <b>Your calls</b> (@${ctx.from.username || tgId})\n\n${lines.join('\n')}`, {
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.error(e);
  }
});

// ---------- Token input & premium signature handling ----------
bot.on('text', async (ctx) => {
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || tgId;
  const raw = (ctx.message?.text || '').trim();

  // 1) Handle premium signature submission first
  if (awaitingSig.has(tgId)) {
    if (!looksLikeSig(raw)) {
      return ctx.reply('That doesn’t look like a valid transaction signature. Please paste the signature string.');
    }
    awaitingSig.delete(tgId);

    // Store/activate premium (lifetime)
    await PremiumUser.findOneAndUpdate(
      { tgId },
      { $set: { tgId, username, callsPerDay: 4, permanent: true } },
      { upsert: true }
    );

    // Notify admin (your TG)
    if (ADMIN_NOTIFY_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_NOTIFY_ID,
          `💰 Premium payment submitted\nUser: @${username} (${tgId})\nSig: <code>${raw}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (_) {}
    }

    return ctx.reply('✅ Premium activated! You can now make <b>4 calls/day</b>.', { parse_mode: 'HTML' });
  }

  // 2) Address capture flow (“Make a call”)
  const extracted = (function extractAddress(input) {
    const s = String(input || '').trim();
    const bsc = s.match(/0x[a-fA-F0-9]{40}/);
    if (bsc) return { chainHint: 'BSC', value: bsc[0] };
    const sol = s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})(?:pump)?$/);
    if (sol) return { chainHint: 'SOL', value: sol[1] };
    return null;
  })(raw);

  if (!extracted) {
    if (awaitingCA.has(tgId)) {
      return ctx.reply(
        'That doesn’t look like a valid address.\n' +
        'Examples:\n• SOL: <code>6Vx…R1f</code> or <code>6Vx…R1fpump</code>\n• EVM: <code>0xAbC…123</code>',
        { parse_mode: 'HTML' }
      );
    }
    return; // ignore random text
  }

  awaitingCA.delete(tgId);
  const caOrMint = extracted.value;

  // Daily limit check (admins unlimited, premium 4/day, normal 1/day)
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const limit = await getDailyLimit(tgId);
  if (!isAdmin(tgId)) {
    const used = await Call.countDocuments({ 'caller.tgId': tgId, createdAt: { $gte: since } });
    if (used >= limit) {
      return ctx.reply(`You reached your daily limit (${limit}/24h). Tap ⭐ Subscribe to raise it.`);
    }
  }

  // Fetch token info
  let info;
  try { info = await getTokenInfo(caOrMint); }
  catch (e) { console.error('price fetch failed:', e.message); }
  if (!info) return ctx.reply('Could not resolve token info (Dexscreener). Try another CA/mint.');

  const chainUpper = String(info.chain || '').toUpperCase();

  // Duplicate check
  const normCa = normalizeCa(caOrMint, chainUpper);
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

  // Caller totals for header (optional; used in upgraded cards)
  const userCalls = await Call.find({ 'caller.tgId': tgId });
  const totalCalls = userCalls.length;
  const totalX = userCalls.reduce((sum, c) => {
    if (!c.entryMc || c.entryMc <= 0) return sum;
    const peak = c.peakMc || c.entryMc;
    return sum + peak / c.entryMc;
  }, 0);
  const avgX = totalCalls ? totalX / totalCalls : 0;

  // URLs
  const chartUrl =
    info.chartUrl ||
    (chainUpper === 'SOL'
      ? `https://dexscreener.com/solana/${encodeURIComponent(caOrMint)}`
      : `https://dexscreener.com/${chainUpper === 'BSC' ? 'bsc' : 'ethereum'}/${encodeURIComponent(normCa)}`);

  // Caption (will place copyable CA)
  const captionRaw = channelCardText({
    user: username,
    // you can expand channelCardText to include totals if you want
    name: info.name,
    tkr: info.ticker || '',
    chain: chainUpper,
    mintOrCa: caOrMint,
    stats: { mc: info.mc, lp: info.lp, vol24h: info.vol24h },
    ageHours: info.ageHours,
    dexName: info.dex || 'DEX',
    dexUrl: info.tradeUrl || info.pairUrl || info.chartUrl || chartUrl,
    botUsername: BOT_USERNAME,
  });
  const caption = captionRaw.replace(caOrMint, `<code>${caOrMint}</code>`);

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
