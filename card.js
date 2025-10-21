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
  name,
  tkr,
  chain,
  mintOrCa,
  stats,
  ageHours,
  dexName,
  dexUrl,
  botUsername,
}) {
  const age = Number.isFinite(ageHours) ? `${ageHours}h old` : '—';
  const titleName = name ? `${name} ` : '';
  const ticker = tkr ? `($${tkr})` : '';
  const dexPart = dexUrl
    ? `(<a href="${dexUrl}">${dexName || 'DEX'}</a>)`
    : `(${dexName || 'DEX'})`;

  return (
    `New Call by @${user}\n\n` +
    `${titleName}${ticker} (${chain})\n\n` +
    `<code>${mintOrCa}</code>\n\n` +            // <= copyable in place
    `#${chain} ${dexPart} | 🕓 ${age}\n\n` +
    `📊 <b>Stats</b>\n` +
    `• MC: ${usd(stats.mc)}\n` +
    `• LP: ${stats.lp != null ? usd(stats.lp) : '—'}\n` +
    `• 24h Vol: ${usd(stats.vol24h)}\n\n` +
    `${new Date().toUTCString()}\n\n` +
    `Make a call here 👉 @${botUsername}`
  );
}

module.exports = { channelCardText, tradeKeyboards };
