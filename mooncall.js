// mooncall.js
require('dotenv').config();
require('./model/db'); // connects Mongo, logs ✅/❌
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// ---- Models ---------------------------------------------------------------
// Use your existing Call model; if its name/path differs, adjust the require.
const Call = require('./model/call.model.js');

// ---- Bot init -------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');

const bot = new Telegraf(BOT_TOKEN);

// ---- Config & helpers -----------------------------------------------------
const COMMUNITY_URL =
  process.env.COMMUNITY_CHANNEL_URL || 'https://t.me/+X04uVvmrXKAwMDJk';

const BOOST_URL =
  COMMUNITY_URL + (COMMUNITY_URL.includes('?') ? '&' : '?') + 'boost=1';

const ADMIN_IDS_RAW = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAdminCtx(ctx) {
  const uid = String(ctx.from?.id || '');
  const uname = ctx.from?.username ? '@' + ctx.from.username : null;
  return ADMIN_IDS_RAW.some((a) => {
    if (!a) return false;
    if (a.startsWith('@')) return uname && a.toLowerCase() === uname.toLowerCase();
    return a === uid;
  });
}

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // SPL mint
const evm0x = /^0x[a-fA-F0-9]{40}$/; // BSC/ETH CA

function detectChainFromAddress(a) {
  if (base58.test(a)) return 'sol';
  if (evm0x.test(a)) return 'bsc';
  return null;
}

function fUSD(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  if (v >= 1_000_000_000) return '$' + (v / 1_000_000_000).toFixed(2) + 'B';
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return '$' + (v / 1_000).toFixed(2) + 'K';
  return '$' + v.toLocaleString();
}

function pct(a, b) {
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / a) * 100;
}

function shortCa(ca) {
  if (!ca) return '';
  if (ca.startsWith('0x')) return ca.slice(0, 4) + '…' + ca.slice(-4);
  return ca.slice(0, 4) + '…' + ca.slice(-4);
}

function tokenLabel(call) {
  // Prefer ticker/symbol if you store it; fall back to chain tag
  const t = call?.ticker || call?.symbol;
  if (t) return `$${t}`;
  return call?.chain === 'bsc' ? '$BSC' : '$SOL';
}

// ---- Start card -----------------------------------------------------------
function startCard() {
  return {
    text:
`Welcome to Mooncall bot.

Call tokens, track PnL, and compete for rewards.

» Each user can make 1 call per day
» Calls are tracked by PnL performance
» The top performer gets rewards + bragging rights

⚡ Telegram Channel`,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.url('⚡ Telegram Channel', COMMUNITY_URL)],
      [Markup.button.url('👥 Community Calls', COMMUNITY_URL)],
      [
        Markup.button.callback('🏅 Top Callers', 'cmd:leaders'),
        Markup.button.callback('🧾 Make a call', 'cmd:make')
      ],
      [
        Markup.button.callback('🗂 My calls', 'cmd:mycalls'),
        Markup.button.callback('📜 Rules', 'cmd:rules')
      ],
      [
        Markup.button.url('⭐ Subscribe', COMMUNITY_URL),
        Markup.button.url('🚀 Boost', BOOST_URL)
      ],
    ])
  };
}

// ---- Block media in bot chat ----------------------------------------------
bot.on(['photo', 'video', 'document', 'sticker', 'audio', 'voice'], async (ctx) => {
  return ctx.reply('Media is disabled here. Use the buttons or /makecall.', {
    disable_web_page_preview: true,
  });
});

// ---- /start ---------------------------------------------------------------
bot.start(async (ctx) => {
  const card = startCard();
  await ctx.reply(card.text, {
    reply_markup: card.keyboard,
    disable_web_page_preview: true,
  });
  await ctx.reply('Paste the token address (SOL mint 32–44 chars or BSC 0x…).');
});

// ---- Button actions → route to commands -----------------------------------
bot.action('cmd:make', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Paste the token address (SOL mint 32–44 chars or BSC 0x…).');
});

bot.action('cmd:mycalls', async (ctx) => {
  await ctx.answerCbQuery();
  return handleMyCalls(ctx);
});

bot.action('cmd:leaders', async (ctx) => {
  await ctx.answerCbQuery();
  return handleLeaderboard(ctx);
});

bot.action('cmd:rules', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
`📜 Rules

• 1 call per user per 24h (admins can bypass)
• SOL & BSC tokens supported
• PnL tracked with milestone alerts (2×/4×/6×/… and special 10×+)
• Abusive/spam calls may be removed`,
    { disable_web_page_preview: true }
  );
});

// ---- Commands -------------------------------------------------------------
bot.command('makecall', async (ctx) => {
  return ctx.reply('Paste the token address (SOL mint 32–44 chars or BSC 0x…).');
});

bot.command('mycalls', handleMyCalls);
bot.command('leaderboard', handleLeaderboard);
bot.command('rules', async (ctx) => bot.telegram.emit('callback_query', { data: 'cmd:rules', from: ctx.from, message: ctx.message }));

// ---- Make-call flow (single-message CA) -----------------------------------
bot.on('text', async (ctx) => {
  const text = (ctx.message?.text || '').trim();

  // Ignore slash commands here (handled above)
  if (text.startsWith('/')) return;

  const chain = detectChainFromAddress(text);
  if (!chain) {
    // Let it be a regular message; don't spam errors.
    return;
  }

  // Check per-user last 24h (admins bypass)
  const tgId = String(ctx.from.id);
  const handle = ctx.from.username || null;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await Call.findOne({ tgId, createdAt: { $gt: cutoff } }).lean();

  if (!isAdminCtx(ctx) && recent) {
    return ctx.reply('You already made a call in the last 24h.');
  }

  // Save the call (worker fills entryMc/lastMc/etc later)
  const callDoc = await Call.create({
    tgId,
    handle,
    chain,
    ca: text,
    ticker: null,       // worker can backfill
    entryPrice: null,   // worker can backfill
    entryMc: null,      // worker can backfill
    lastPrice: null,
    lastMc: null,
    peakPrice: null,
    peakMultiple: null,
    createdAt: new Date(),
  });

  // Acknowledge
  const title = tokenLabel(callDoc);
  await ctx.reply(
    `✅ Call saved!\nToken: ${title}\nCA: \`${text}\`\n\nCalled MC: —\nWe’ll track it & alert milestones.`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );

  // Immediately show user their latest calls
  await handleMyCalls(ctx);
});

// ---- My Calls -------------------------------------------------------------
async function handleMyCalls(ctx) {
  try {
    const tgId = String(ctx.from.id);
    const calls = await Call.find({ tgId }).sort({ createdAt: -1 }).limit(10).lean();

    if (!calls.length) {
      return ctx.reply('You have no calls yet. Use **Make a call**.', {
        parse_mode: 'Markdown',
      });
    }

    const header = `🧾 Your calls (${ctx.from.username ? '@' + ctx.from.username : tgId})`;
    const lines = [header, ''];

    for (const c of calls) {
      const title = tokenLabel(c);
      const entryMc = c.entryMc ?? c.calledMc ?? null;
      const nowMc = c.lastMc ?? null;
      const p = pct(entryMc, nowMc);
      const delta = p == null ? '' : ` (${p >= 0 ? '+' : ''}${p.toFixed(1)}%)`;

      lines.push(`• ${title}`);
      lines.push(`   MC when called: ${fUSD(entryMc)}`);
      lines.push(`   MC now: ${nowMc == null ? '—' : fUSD(nowMc) + delta}`);
    }

    return ctx.reply(lines.join('\n'), { disable_web_page_preview: true });
  } catch (e) {
    console.error('mycalls error', e);
    return ctx.reply('Could not load your calls right now.');
  }
}

// ---- Leaderboard ----------------------------------------------------------
async function handleLeaderboard(ctx) {
  try {
    // Compute best multiple per user
    const top = await Call.aggregate([
      {
        $addFields: {
          // try peakMultiple first, else compute from peakPrice/entryPrice, else last/entry
          bestMultiple: {
            $ifNull: [
              '$peakMultiple',
              {
                $cond: [
                  { $and: [{ $gt: ['$peakPrice', 0] }, { $gt: ['$entryPrice', 0] }] },
                  { $divide: ['$peakPrice', '$entryPrice'] },
                  {
                    $cond: [
                      { $and: [{ $gt: ['$lastPrice', 0] }, { $gt: ['$entryPrice', 0] }] },
                      { $divide: ['$lastPrice', '$entryPrice'] },
                      null,
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: '$tgId',
          handle: { $last: '$handle' },
          best: { $max: '$bestMultiple' },
          calls: { $sum: 1 },
        },
      },
      { $sort: { best: -1 } },
      { $limit: 10 },
    ]);

    if (!top.length) {
      return ctx.reply('No leaderboard data yet.');
    }

    const medals = ['🥇', '🥈', '🥉'];

    const lines = ['🏆 Top Callers (best X)', ''];
    top.forEach((u, i) => {
      const tag = u.handle ? '@' + u.handle : u._id;
      const icon = medals[i] || `${i + 1}.`;
      const bx = u.best ? `${u.best.toFixed(2)}×` : '—';
      lines.push(`${icon} ${tag} — Best: ${bx} • Calls: ${u.calls}`);
    });

    return ctx.reply(lines.join('\n'), { disable_web_page_preview: true });
  } catch (e) {
    console.error('leaderboard error', e);
    return ctx.reply('Could not load leaderboard right now.');
  }
}

// ---- Global error ---------------------------------------------------------
bot.catch((err, ctx) => {
  console.error('Unhandled error while processing', ctx.update, err);
});

// ---- Launch ---------------------------------------------------------------
bot.launch().then(() => {
  console.log('🤖 mooncall bot ready');
});

// Graceful stop (Render/PM2)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
