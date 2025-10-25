// card.js
// Channel "New Call" card + inline keyboards (with richer stats).
const { Markup } = require('telegraf');
const { usd } = require('./lib/price');

// ---------- helpers ----------
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
const boolIcon = v => (v === true ? '✅' : v === false ? '❌' : '—');

function normCurveProgress(val) {
  if (!Number.isFinite(val)) return null;
  // Accept 0..1 or 0..100
  return val <= 1 ? Math.max(0, Math.min(100, val * 100)) : Math.max(0, Math.min(100, val));
}
function progressBar(pct, slots = 26) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * slots);
  const empty = slots - filled;
  // Bright, readable bar
  return '█'.repeat(filled) + '░'.repeat(empty);
}

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

/**
 * Inline keyboard under a channel post:
 *  - Row 1: Chart + Boost
 *  - Next rows: trade bots from env per chain
 */
function tradeKeyboards(chain, chartUrl) {
  const bots =
    String(chain || '').toUpperCase() === 'BSC'
      ? parseTradeBots(process.env.TRADE_BOTS_BSC)
      : parseTradeBots(process.env.TRADE_BOTS_SOL);

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
 * Channel caption (HTML). CA is inline in a <code>…</code> span for easy copy.
 * Expects these fields (undefined-safe):
 *  - user, totals{totalCalls,totalX,avgX}
 *  - name, tkr, chain, mintOrCa
 *  - stats{mc,lp,vol24h}
 *  - createdOnName, createdOnUrl
 *  - curveProgress (0..1 or 0..100)
 *  - dexPaid (boolean)
 *  - bubblemapUrl, burnPct, freezeAuth (bool), mintAuth (bool)
 *  - websiteUrl, twitterUrl, chartUrl
 *  - botUsername
 */
function channelCardText(payload) {
  const {
    user,
    totals = {},
    name,
    tkr,
    chain,
    mintOrCa,
    stats = {},
    createdOnName,
    createdOnUrl,
    curveProgress,
    dexPaid,
    bubblemapUrl,
    burnPct,
    freezeAuth,
    mintAuth,
    websiteUrl,
    twitterUrl,
    chartUrl,
    botUsername,
  } = payload || {};

  const ticker = tkr ? `($${esc(tkr)})` : '';
  const titleName = name ? `${esc(name)} ` : '';
  const chainUp = String(chain || '').toUpperCase();

  const totalCalls = Number(totals.totalCalls || 0);
  const totalX = Number(totals.totalX || 0);
  const avgX = totalCalls ? (totals.avgX || totalX / totalCalls) : 0;

  const curvePct = normCurveProgress(curveProgress);
  const curveLine = Number.isFinite(curvePct)
    ? `\n📊 <b>Bonding Curve Progression:</b> ${curvePct.toFixed(2)}%\n` +
      `${progressBar(curvePct)}`
    : '';

  const dexLine = `\n🦅 <b>DexS Paid?:</b> ${boolIcon(dexPaid)}`;

  // Bubblemap section
  const bubbleHdr = bubblemapUrl
    ? `\n\n🫧 <a href="${esc(bubblemapUrl)}">Bubblemap</a>`
    : `\n\n🫧 Bubblemap`;

  const burnShown =
    Number.isFinite(burnPct) ? `${Number(burnPct).toFixed(2)}% ${boolIcon(burnPct >= 99.9)}` : '—';
  const freezeShown = boolIcon(freezeAuth);
  const mintShown = boolIcon(mintAuth);

  const website = websiteUrl ? `<a href="${esc(websiteUrl)}">Website</a>` : '';
  const twitter = twitterUrl ? `<a href="${esc(twitterUrl)}">Twitter</a>` : '';
  const linksLine =
    website || twitter ? `\n\n${[website, twitter].filter(Boolean).join(' | ')}` : '';

  // Optional search helpers
  const searchTicker =
    tkr && chartUrl ? `<a href="${esc(chartUrl)}">🔍$${esc(tkr)}</a>` : null;
  const searchCa = chartUrl ? `<a href="${esc(chartUrl)}">🔍CA</a>` : null;
  const searchLine =
    searchTicker || searchCa ? `\n\n${[searchTicker, ' - ', searchCa].filter(Boolean).join('')}` : '';

  return (
    `Call by @${esc(user)}\n` +
    `Total Calls: <b>${totalCalls}</b>\n` +
    `Total X: <b>${(totalX || 0).toFixed(1)}X</b>\n` +
    `Average X per call:  <b>${(avgX || 0).toFixed(1)}X</b>\n\n` +

    `🪙 ${titleName}${ticker}\n` +
    `└<code>${esc(mintOrCa)}</code>\n\n` +

    `🏦 <b>Market Cap:</b> ${usd(stats.mc)}\n` +
    (createdOnUrl
      ? `🛠 <b>Created On:</b> <a href="${esc(createdOnUrl)}">${esc(createdOnName || 'DEX')}</a>`
      : `🛠 <b>Created On:</b> ${esc(createdOnName || 'DEX')}`) +

    curveLine +
    dexLine +

    bubbleHdr +
    `\n🔥 <b>Liquidity Burned:</b> ${burnShown}\n` +
    `❄️ <b>Freeze Authority:</b> ${freezeShown}\n` +
    `➕ <b>Mint Authority:</b> ${mintShown}` +

    linksLine +
    searchLine +

    `\n\nMake a call here 👉 @${esc(botUsername)}`
  );
}

module.exports = { channelCardText, tradeKeyboards };
