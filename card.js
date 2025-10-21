// card.js
// Channel "New Call" card, alert formatting, and inline keyboards.
const { Markup } = require('telegraf');
const { usd, shortAddr } = require('./lib/price');

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

function tradeKeyboards(chain, chartUrl) {
  const bots =
    chain === 'SOL'
      ? parseTradeBots(process.env.TRADE_BOTS_SOL)
      : parseTradeBots(process.env.TRADE_BOTS_BSC);

  const boostUrl = process.env.BOOST_URL || process.env.COMMUNITY_CHANNEL_URL || 'https://t.me';
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

// ==== New-call post (caption/text) ====
function channelCardText({ user, tkr, chain, mintOrCa, stats, ageHours, dex }) {
  const age = ageHours != null ? `${ageHours}h old` : '—';
  const caLine = `${mintOrCa}`; // copyable
  return (
    `New Call by @${user}\n\n` +
    `${tkr ? `$${tkr}` : 'Token'} (${chain})\n\n` +
    `${caLine}\n\n` +
    `#${chain} (${dex}) | 🕓 ${age}\n\n` +
    `📊 <b>Stats</b>\n` +
    `• MC when called: ${usd(stats.mc)}\n` +
    `• LP: ${usd(stats.lp)}\n` +
    `• 24h Vol: ${usd(stats.vol24h)}`
  );
}

// ==== PnL alerts (2×–8×) ====
function lowTierAlertText({ tkr, ca, xNow, entryMc, nowMc, byUser }) {
  // rockets: 2x → 4 rockets, 8x → 12 rockets (capped)
  const rockets = '🚀'.repeat(Math.min(12, Math.max(4, Math.round(xNow * 2))));
  const tag = tkr ? `$${tkr}` : shortAddr(ca);
  return (
    `${rockets} ${tag} soared by X${xNow.toFixed(2)} since was called!\n\n` +
    `📞 MC when called: ${usd(entryMc)}${byUser ? ` by @${byUser}` : ''}\n` +
    `🏆 MC now: ${usd(nowMc)}`
  );
}

// ==== PnL alerts (10×+) ====
function highTierAlertText({ tkr, entryMc, nowMc, xNow, duration }) {
  // 🌕 $CRK 11x | 💹From 66.1K ↗️ 300.6K within 2h:50m
  const tag = tkr ? `$${tkr}` : 'Token';
  const durLabel = duration || '—';
  return (
    `🌕 ${tag} ${xNow.toFixed(2)}x | 💹From ${usd(entryMc).replace('$', '')} ` +
    `↗️ ${usd(nowMc).replace('$', '')} within ${durLabel}`
  );
}

module.exports = {
  channelCardText,
  tradeKeyboards,
  lowTierAlertText,
  highTierAlertText,
};
