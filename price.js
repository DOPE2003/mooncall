// price.js
const axios = require("axios");

/**
 * Try Dexscreener first for both SOL & BSC.
 * For SOL, fall back to Jupiter if no pairs are returned.
 * Returns: { price: number, mc?: number|null }
 */
async function getPrice(tokenAddress, chain) {
  if (!tokenAddress) throw new Error("missing tokenAddress");

  // 1) Dexscreener
  const dexPair = await fromDexscreener(tokenAddress, chain).catch(() => null);
  if (dexPair && isFiniteNum(dexPair.price)) {
    return { price: dexPair.price, mc: dexPair.mc ?? null };
  }

  // 2) Jupiter fallback (SOL only)
  if ((chain || "").toLowerCase() === "sol") {
    const j = await fromJupiter(tokenAddress).catch(() => null);
    if (j && isFiniteNum(j.price)) return { price: j.price, mc: null };
  }

  throw new Error("price unavailable");
}

function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

async function fromDexscreener(addr, chain) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  if (!pairs.length) return null;

  const want = (chain || "").toLowerCase() === "bsc" ? "bsc" : "solana";
  const filtered = pairs.filter(p => (p?.chainId || "").toLowerCase() === want);
  if (!filtered.length) return null;

  // choose the deepest pool
  filtered.sort((a, b) => (num(b?.liquidity?.usd) - num(a?.liquidity?.usd)));
  const p = filtered[0];

  const price = num(p?.priceUsd);
  // dex returns marketCap for some nets; fdv is more common
  const mc = isFiniteNum(num(p?.marketCap)) ? num(p?.marketCap)
          : isFiniteNum(num(p?.fdv))       ? num(p?.fdv)
          : null;

  if (!isFiniteNum(price)) return null;
  return { price, mc };
}

async function fromJupiter(mint) {
  // Prefer lite v3, fall back to v4
  const v3 = process.env.JUPITER_PRICE_URL || "https://lite-api.jup.ag/price/v3?ids=";
  try {
    const { data } = await axios.get(v3 + encodeURIComponent(mint), { timeout: 8000 });
    const d = data?.data?.[mint];
    const price = num(d?.price ?? d?.priceUsd);
    if (isFiniteNum(price)) return { price };
  } catch {}

  try {
    const { data } = await axios.get(`https://price.jup.ag/v4/price?ids=${encodeURIComponent(mint)}`, { timeout: 8000 });
    const first = Object.values(data?.data || {})[0];
    const price = num(first?.price);
    if (isFiniteNum(price)) return { price };
  } catch {}

  return null;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

module.exports = { getPrice };
