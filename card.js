// card.js
// Channel "New Call" card, inline keyboards, and alert text helpers.

const { Markup } = require('telegraf');
const { usd } = require('./lib/price');

// Parse env list like: "📊 Axiom|https://t.me/axiom_app_bot,🐴 Trojan|https://..."
function parseTradeBots(envVar) {
  return String(envVar || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [label, url] = s.split('|').map(x => x.trim());
      return { label: label || 'Bot', url: url || 'https://t.me' };
    });
}

function safeDexLink(name, url) {
  const dexName = name || 'DEX';
  if (!url) return dexName;
  // Keep it simple & safe in HTML mode
  return `<a href="${url}">${dexName}</a>`;
}

/**
 * Inline keyboard below a channel post.
 * First row: Chart · Trade · Boost
 * Next rows: bots from env (2 per row).
 */
function tradeKeyboards(chain, chartUrl, tradeUrl) {
  const bots =
    chain === 'SOL'
      ? parseTradeBots(process.env.TRADE_BOTS_SOL)
      : parseTradeBots(process.env.TRADE_BOTS_BSC);

  const boostUrl =
    process.env.BOOST_URL || process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';

  const rows = [
    [
      Markup.button.url('📈 Chart', chartUrl || 'https://dexscreener.com'),
      Markup.button.url('🌕 Trade', tradeUrl || chartUrl || 'https://dexscreener.com'),
      Markup.button.url('🚀 Boost', boostUrl),
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
 * Channel caption EXACTLY like the sample:
 *  - New Call by @user
 *  - NAME (DEX.LINK) ($TICKER)
 *  - plain CA/mint (copyable by long-press)
 *  - #CHAIN (DexName) | 🕓 age
 *  - Stats
 *  - UTC time line
 *  - Make a call here 👉 @bot
 */
function channelCardText({
  user,
  name,            // token name (optional)
  tkr,             // ticker without $, e.g. BDTCH
  chain,           // SOL / BSC
  mintOrCa,        // raw CA/mint
  stats,           // { mc, lp, vol24h }
  ageHours,        // number
  dexName,         // e.g. PIGEON.TRADE
  dexUrl,          // link for the DEX name
  botUsername,     // e.g. mooncal_bot (no @)
}) {
  const age = ageHours != null ? `${ageHours}h old` : '—';
  const dexLabel = dexName || 'dex';
  const dexDisplay = safeDexLink(dexLabel, dexUrl);
  const tickerText = tkr ? `($${tkr})` : '';
  const tokenTitle = `${name || (tkr ? `$${tkr}` : 'Token')} ${tickerText}`.trim();

  const utcNow = new Date().toUTCString();

  return (
    `New Call by @${user}\n\n` +
    `${tokenTitle.replace(/\s+\(\$[^)]+\)$/, '')} (${dexDisplay}) ${tickerText}\n\n` +
    `${mintOrCa}\n\n` +
    `#${chain} (${dexLabel}) | 🕓 ${age}\n\n` +
    `📊 <b>Stats</b>\n` +
    `• MC: ${usd(stats.mc)}\n` +
    `• LP: ${stats.lp != null ? usd(stats.lp) : '—'}\n` +
    `• 24h Vol: ${usd(stats.vol24h)}\n\n` +
    `${utcNow}\n\n` +
    `Make a call here 👉 @${botUsername}`
  );
}

module.exports = {
  tradeKeyboards,
  channelCardText,
};
