// lib/price.js
const axios = require("axios");

// SOL: Jupiter
async function getSolPrice(mint) {
  const url = (process.env.JUPITER_PRICE_URL || "https://lite-api.jup.ag/price/v3?ids=") + encodeURIComponent(mint);
  const { data } = await axios.get(url, { timeout: 8000 });
  const first = Object.values(data?.data || {})[0];
  return typeof first?.price === "number" ? first.price : null;
}

// BSC: Dexscreener by token address
async function getBscPrice(token) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  const mkt = data?.pairs?.[0];
  const price = mkt?.priceUsd ? Number(mkt.priceUsd) : null;
  const fdv   = mkt?.fdv ?? null; // use if you want MC
  const liq   = mkt?.liquidity?.usd ?? null;
  return { price, fdv, liq };
}

module.exports = { getSolPrice, getBscPrice };
