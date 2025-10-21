// card.js
// Formats the channel "New Call" card + inline keyboard with trade bots.
const { Markup } = require('telegraf');
const { usd } = require('./lib/price');

const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';

/** Parse comma-separated "Label|URL" items from env */
const parseTradeBots = (envVar) => {
  // Example: "📊 Axiom|https://t.me/axiom_app_bot,🐴 Trojan|https://t.me/TrojanWhisperBot"
  return String(envVar || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [label, url] = s.split('|').map((x) => x.trim());
      return { label, url };
    });
};

/**
 * Build the channel message body
 * @param {object} p
 * @param {string} p.user       - caller username (no @)
 * @param {string} p.tkr        - ticker symbol w/o $ (e.g. "CRK")
 * @param {string} p.chain      - "SOL" | "BSC"
 * @param {string} p.mintOrCa   - mint (SOL) or 0x CA (BSC)
 * @param {object} p.stats      - { mc, lp, vol24h }
 * @param {number} p.ageHours   - token age in hours
 * @param {string} p.dex        - "PumpFun" | "PancakeSwap" | etc.
 */
function channelCardText({ user, tkr, chain, mintOrCa, stats, ageHours, dex }) {
  const age = Number.isFinite(ageHours) ? `${Math.floor(ageHours)}h old` : '—';
  const ticker = tkr ? `$${tkr}` : 'Token';
  const dexName = dex || 'DEX';

  return (
    `New Call by @${user}\n\n` +
    `${ticker} (${chain})\n\n` +
    // Show the full address in monospace so it’s easy to copy
    `<code>${mintOrCa}</code>\n\n` +
    `#${chain} (${dexName}) | 🕓 ${age}\n\n` +
    `📊 <b>Stats</b>\n` +
    `• MC: ${usd(stats.mc)}\n` +
    `• LP: ${usd(stats.lp)}\n` +
    `• 24h Vol: ${usd(stats.vol24h)}\n\n` +
    `${new Date().toUTCString()}\n\n` +
    (BOT_USERNAME ? `Make a call here 👉 @${BOT_USERNAME}` : '')
  );
}

/**
 * Build inline keyboard with Chart + configured trade bots
 * (kept simple and compatible with your current mooncall.js)
 */
function tradeKeyboards(chain) {
  const bots =
    chain === 'SOL'
      ? parseTradeBots(process.env.TRADE_BOTS_SOL)
      : parseTradeBots(process.env.TRADE_BOTS_BSC);

  // Generic chart home (still useful). If you later want token-specific
  // links, pass the address into this function and build a per-chain URL.
  const chartBtn = Markup.button.url('📈 Chart', 'https://dexscreener.com');
  const tradeBtn = Markup.button.url('🌕 Trade', 'https://t.me'); // generic; real trade bots follow

  const rows = [[chartBtn, tradeBtn]];

  // Then the configured bots, 2 per row
  for (let i = 0; i < bots.length; i += 2) {
    const a = bots[i];
    const b = bots[i + 1];
    const row = [Markup.button.url(a.label, a.url)];
    if (b) row.push(Markup.button.url(b.label, b.url));
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

module.exports = { channelCardText, tradeKeyboards };
