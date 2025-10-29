// card.js
// Rich channel card + inline keyboards.
const { Markup } = require('telegraf');
const { usd } = require('./lib/price');

// HTML esc (safe for parse_mode:'HTML')
const esc = (s = '') =>
  String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');

const boolIcon = (v) => (v === true ? '✅' : v === false ? '❌' : '—');
const pct = (n) => (Number.isFinite(n) ? `${(+n).toFixed(0)}%` : '—');

function progressBar(pctNum) {
  if (!Number.isFinite(pctNum)) return null;
  const p = Math.max(0, Math.min(100, Number(pctNum)));
  const total = 22;
  const filled = Math.round((p / 100) * total);
  return `${'▮'.repeat(filled)}${'▯'.repeat(total - filled)} ${p.toFixed(1)}%`;
}

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
 * Inline keyboard under a channel post
 *  - Row 1: Chart + Boost
 *  - Next rows: trade bots from env per chain
 */
function tradeKeyboards(chain, chartUrl) {
  const bots =
    String(chain).toUpperCase() === 'SOL'
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
 * Rich channel caption (copyable CA “└ <code>CA</code>”)
 */
function channelCardText({
  // caller
  user,
  totals, // { totalCalls, totalX, avgX }
  // token
  name,
  tkr,
  chain,
  mintOrCa,
  // market
  stats, // { mc, lp, vol24h, priceUsd? }
  // meta
  createdOnName,     // e.g. "PumpFun" / "Raydium" / "DEX"
  createdOnUrl,
  dexPaid,           // boolean/undefined (promoted/paid listing on DexScreener)
  curveProgress,     // number 0..100 (optional; when Pump.fun)
  bubblemapUrl,      // optional (EVM only)
  burnPct,           // number percent (0-100) or undefined
  freezeAuth,        // boolean/undefined
  mintAuth,          // boolean/undefined
  twitterUrl,        // optional
  botUsername,       // required
}) {
  const titleName = name ? esc(name) : 'Token';
  const ticker = tkr ? esc(tkr) : '';
  const ch = String(chain || '').toUpperCase();

  const createdOn =
    createdOnUrl
      ? `<a href="${createdOnUrl}">${esc(createdOnName || 'DEX')}</a>`
      : esc(createdOnName || 'DEX');

  const totalsBlock =
`👤 Call by <b>@${esc(user)}</b>
📊 Total Calls: <b>${totals?.totalCalls ?? 0}</b>
📈 Total X: <b>${Number.isFinite(totals?.totalX) ? `${totals.totalX.toFixed(2)}×` : '—'}</b>
📐 Average X/call:  <b>${Number.isFinite(totals?.avgX) ? `${totals.avgX.toFixed(2)}×` : '—'}</b>`;

  const priceLine = Number.isFinite(stats?.priceUsd)
    ? `💲 Price: <b>${usd(stats.priceUsd).replace('$','')} USD</b>\n`
    : '';

  const mcLine   = `🏦 Market Cap: <b>${usd(stats?.mc)}</b>`;
  const lpLine   = `💧 LP: <b>${usd(stats?.lp)}</b>`;
  const volLine  = `📈 24h Vol: <b>${usd(stats?.vol24h)}</b>`;

  // Bonding curve line:
  const curveLine = (() => {
    const isPump = /pumpfun/i.test(String(createdOnName || '')) || /pump$/i.test(String(mintOrCa || ''));
    if (!isPump && !Number.isFinite(curveProgress)) return '';
    if (!Number.isFinite(curveProgress)) {
      // hint while fallback fetch runs (no auto-refresh here; worker/bot would need to edit the message)
      return `📊 Bonding Curve Progression: ⏳ fetching…\n`;
    }
    const bar = progressBar(curveProgress);
    return `📊 Bonding Curve Progression: ${bar || '—'}\n`;
  })();

  // Dexscreener “paid/promoted” status — make it visually explicit
  const dexStatus = (dexPaid === true)
    ? '🟢 <b>Promoted (Paid)</b>'
    : (dexPaid === false ? '⚪ Not Promoted' : '—');

  const bubbleLine = bubblemapUrl
    ? `🫧 <a href="${bubblemapUrl}">Bubblemap</a>`
    : `🫧 Bubblemap`;

  const twitterLine = twitterUrl ? `<a href="${twitterUrl}">Twitter</a>` : 'Twitter';

  return (
`${totalsBlock}

🪙 <b>${titleName}${ticker ? ` ($${ticker})` : ''}</b> • <b>${ch}</b>
└<code>${esc(mintOrCa)}</code>

${priceLine}${mcLine}
${lpLine}
${volLine}
🛠 Created On: <b>${createdOn}</b>
${curveLine}🦅 Dexscreener Status: ${dexStatus}

${bubbleLine}
🔥 Liquidity Burned: <b>${pct(burnPct)}</b> ${boolIcon(burnPct === 100)}
❄️ Freeze Authority: ${boolIcon(freezeAuth)}
➕ Mint Authority: ${boolIcon(mintAuth)}

${twitterLine}

🔍 ${ticker ? `$${ticker}` : ''} • 🔍 CA

Make a call here 👉 @${esc(botUsername)}`
  );
}

module.exports = { channelCardText, tradeKeyboards };
