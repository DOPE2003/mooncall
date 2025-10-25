// card.js
// Channel "New Call" card + inline keyboards.
const { Markup } = require('telegraf');
const { usd } = require('./lib/price');

// Parse env list like: "📊 Axiom|https://t.me/axiom_app_bot,🐴 Trojan|https://..."
function parseTradeBots(envVar) {
  return String(envVar || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [label, url] = s.split('|').map((x) => x.trim());
      return { label: label || 'Bot', url: url || 'https://t.me' };
    });
}

/** Make a simple text progress bar (20 chars). */
function progressBar(pct) {
  if (pct == null || !isFinite(pct)) return null;
  const p = Math.max(0, Math.min(100, Number(pct)));
  const total = 20;
  const filled = Math.round((p / 100) * total);
  return `${'▮'.repeat(filled)}${'▯'.repeat(total - filled)} ${p.toFixed(1)}%`;
}

/**
 * Inline keyboard under a channel post:
 *  - Row 1: Chart + Boost
 *  - Next rows: trade bots from env per chain
 */
function tradeKeyboards(chain, chartUrl) {
  const bots =
    chain === 'SOL'
      ? parseTradeBots(process.env.TRADE_BOTS_SOL)
      : parseTradeBots(process.env.TRADE_BOTS_BSC);

  const boostUrl =
    process.env.BOOST_URL || process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';

  const rows = [
    [
      Markup.button.url('📈 Chart', chartUrl || 'https://dexscreener.com'),
      Markup.button.url('Boost ⚡', boostUrl),
    ],
  ];

  for (let i = 0; i < bots.length; i += 2) {
    const a = bots[i];
    const b = bots[i + 1];
    const row = [Markup.button.url(a.label, a.url)];
    if (b) row.push(Markup.button.url(b.label, b.url));
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Channel caption. CA is inline, in a code span so it’s easy to copy.
 */
function channelCardText({
  user,
  totals,                 // { totalCalls, totalX, avgX }
  name,
  tkr,
  chain,
  mintOrCa,
  stats,                  // { mc, lp, vol24h }
  createdOnName,          // e.g., 'PumpFun', 'Raydium', 'DEX'
  createdOnUrl,
  curveProgress,          // 0..100 (optional)
  dexPaid,                // boolean (optional)
  bubblemapUrl,           // url (optional)
  burnPct,                // number (optional)
  freezeAuth,             // boolean (optional)
  mintAuth,               // boolean (optional)
  websiteUrl,             // (optional)
  twitterUrl,             // (optional)
  chartUrl,               // (optional)
  botUsername,
}) {
  const titleName = name ? `${name} ` : '';
  const ticker = tkr ? `($${tkr})` : '';
  const totalsLine =
    totals
      ? `Total Calls: <b>${totals.totalCalls || 0}</b>\n` +
        `Total X: <b>${(totals.totalX || 0).toFixed(1)}X</b>\n` +
        `Average X per call:  <b>${(totals.avgX || 0).toFixed(1)}X</b>\n\n`
      : '';

  // Bonding curve shows if (1) we have a value OR (2) it looks like Pump.fun
  const looksPump = /pumpfun/i.test(String(createdOnName || '')) || /pump$/.test(mintOrCa);
  const curveLine = looksPump
    ? (() => {
        const bar = progressBar(curveProgress);
        if (bar) {
          return `📊 <b>Bonding Curve Progression</b>: ${bar}\n`;
        }
        return `📊 <b>Bonding Curve Progression</b>: —\n`;
      })()
    : '';

  const dexPaidLine =
    dexPaid === true ? '✅' : dexPaid === false ? '❌' : '—';

  const burnLine = typeof burnPct === 'number' ? `${burnPct.toFixed(0)}% ${burnPct >= 99 ? '✅' : ''}` : '—';
  const freezeLine = freezeAuth === true ? '✅' : freezeAuth === false ? '❌' : '—';
  const mintLine = mintAuth === true ? '✅' : mintAuth === false ? '❌' : '—';

  const links = [
    twitterUrl ? 'Twitter' : null,
    websiteUrl ? 'Website' : null,
  ].filter(Boolean).join(' | ');

  const linkLines = [
    websiteUrl ? `<a href="${websiteUrl}">Website</a>` : null,
    twitterUrl ? `<a href="${twitterUrl}">Twitter</a>` : null,
  ].filter(Boolean).join(' | ');

  const bottomSearch =
    (tkr ? `🔎 $${tkr}` : '🔎 Token') + ' - ' + '🔎 <code>CA</code>';

  return (
    `Call by @${user}\n` +
    totalsLine +
    `🌕 ${titleName}${ticker}\n` +
    `└<code>${mintOrCa}</code>\n\n` +
    `🏦 <b>Market Cap:</b> ${usd(stats.mc)}\n` +
    `🛠 <b>Created On:</b> ${createdOnUrl ? `<a href="${createdOnUrl}">${createdOnName || 'DEX'}</a>` : (createdOnName || 'DEX')}\n` +
    curveLine +
    `🦅 <b>DexS Paid?</b>: ${dexPaidLine}\n\n` +
    `🫧 <b>Bubblemap</b>${bubblemapUrl ? ` — <a href="${bubblemapUrl}">Open</a>` : ''}\n` +
    `🔥 <b>Liquidity Burned:</b> ${burnLine}\n` +
    `❄️ <b>Freeze Authority:</b> ${freezeLine}\n` +
    `➕ <b>Mint Authority:</b> ${mintLine}\n\n` +
    (linkLines ? `${linkLines}\n\n` : '') +
    `${tkr ? `🔎 $${tkr}` : '🔎 Token'} - 🔎 <code>CA</code>\n\n` +
    `Make a call here 👉 @${botUsername}`
  );
}

module.exports = { channelCardText, tradeKeyboards };
