// card.js
const axios = require("axios");

const USD = v =>
  v == null ? "—" :
  (Math.abs(v) >= 1 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(6)}`);

function tradeButtons(chain, addr) {
  const chartUrl = chain === "sol"
    ? `https://dexscreener.com/solana/${addr}`
    : `https://dexscreener.com/bsc/${addr}`;
  const botsLine = (chain === "sol" ? process.env.TRADE_BOTS_SOL : process.env.TRADE_BOTS_BSC) || "";
  const extra = botsLine.split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0,6) // up to 6 buttons
    .map(pair => {
      const [label, url] = pair.split("|");
      return [{ text: label || "Bot", url: url || chartUrl }];
    });

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📈 Chart", url: chartUrl }, { text: "🛒 Trade", url: chartUrl }],
        ...extra
      ]
    }
  };
}

async function fetchTokenMeta(chain, addr) {
  // Use Dexscreener for symbol + FDV + liquidity (works for SOL & BSC)
  const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
  const { data } = await axios.get(url, { timeout: 8000 }).catch(() => ({ data: null }));
  const p = data?.pairs?.[0];
  if (!p) return null;
  return {
    symbol: p?.baseToken?.symbol || "",
    name: p?.baseToken?.name || "",
    liquidityUsd: p?.liquidity?.usd ?? null,
    fdv: p?.fdv ?? null,
    dexsPair: p?.url || null
  };
}

async function buildCallCard({ chain, addr, handle }) {
  const meta = await fetchTokenMeta(chain, addr).catch(() => null);
  const name = meta?.name || "";
  const symbol = meta?.symbol || "";
  const mc = meta?.fdv ?? null;
  const lp = meta?.liquidityUsd ?? null;

  const lines = [
    `New Call by ${handle || "unknown"}`,
    "",
    `${name ? name+" " : ""}${symbol ? "($" + symbol + ")" : ""}`,
    "",
    `<code>${addr}</code>`,
    "",
    `${chain === "sol" ? "#SOL (PumpFun)" : "#BSC (PancakeSwap)"} | 🆕 New`,
    "",
    "📊 <b>Stats</b>",
    `💰 MC: ${USD(mc)}`,
    `💧 LP: ${USD(lp)}`,
    "",
    `Make a call here 👉 @${process.env.BOT_USERNAME || "your_bot"}`
  ].join("\n");

  const keyboard = tradeButtons(chain, addr);
  return { text: lines, keyboard, photoUrl: null, meta: { marketCap: mc } };
}

module.exports = { buildCallCard, fetchTokenMeta, USD };
