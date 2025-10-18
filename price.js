// price.js
const axios = require("axios");

async function getSolPrice(mint) {
  const base = process.env.JUPITER_PRICE_URL || "https://lite-api.jup.ag/price/v3?ids=";
  const { data } = await axios.get(base + encodeURIComponent(mint), { timeout: 8000 });
  const p = data?.data?.[mint]?.price;
  return typeof p === "number" ? p : null;
}

async function getBscPrice(tokenAddress) {
  // Dexscreener token endpoint (find best-liquidity pair)
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  const pairs = data?.pairs || [];
  const best = pairs.sort((a,b) => (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0))[0];
  const price = Number(best?.priceUsd);
  return Number.isFinite(price) ? price : null;
}

async function getPrice(chain, addr) {
  if (chain === "sol") return getSolPrice(addr);
  if (chain === "bsc") return getBscPrice(addr);
  return null;
}

module.exports = { getSolPrice, getBscPrice, getPrice };
