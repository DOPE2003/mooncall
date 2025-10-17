// price.js
const axios = require("axios");

/**
 * Returns a USD price for a token on SOL or BSC.
 * Strategy:
 *  - SOL: try Jupiter lite -> fallback to Dexscreener
 *  - BSC: Dexscreener
 */
async function getPrice(chain, addr) {
  // SOL: Jupiter lite
  if (chain === "sol") {
    try {
      const url = (process.env.JUPITER_PRICE_URL || "https://lite-api.jup.ag/price/v3?ids=") + encodeURIComponent(addr);
      const { data } = await axios.get(url, { timeout: 8000 });
      const p = data?.data?.[addr]?.price;
      if (typeof p === "number" && isFinite(p) && p > 0) return p;
    } catch (_) {}
  }

  // Fallback (and for BSC): Dexscreener
  try {
    const url = "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(addr);
    const { data } = await axios.get(url, { timeout: 12000 });
    const pairs = data?.pairs || [];
    if (!pairs.length) throw new Error("no pairs");
    pairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
    const p = pairs[0];
    const px = Number(p?.priceUsd ?? p?.priceUSD ?? NaN);
    if (isFinite(px) && px > 0) return px;
  } catch (_) {}

  throw new Error("price unavailable");
}

module.exports = { getPrice };
