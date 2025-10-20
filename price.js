// price.js
const axios = require("axios");

const JUP = process.env.JUPITER_PRICE_URL || "https://lite-api.jup.ag/price/v3?ids=";

const isSol = (x) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const isEvm = (x) => /^0x[a-fA-F0-9]{40}$/.test(x);

// Dexscreener gives priceUsd + fdv/marketCap + ticker for SOL & BSC
async function fromDexscreener(ca) {
  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
      { timeout: 8000 }
    );
    const p = data?.pairs?.[0];
    const price = Number(p?.priceUsd);
    const mc = Number(p?.fdv || p?.marketCap);
    const ticker = p?.baseToken?.symbol || "";
    return {
      priceUsd: Number.isFinite(price) ? price : null,
      mcUsd: Number.isFinite(mc) ? mc : null,
      ticker,
    };
  } catch {
    return { priceUsd: null, mcUsd: null, ticker: "" };
  }
}

// Jupiter fallback (SOL only)
async function fromJupiter(mint) {
  try {
    const { data } = await axios.get(JUP + encodeURIComponent(mint), {
      timeout: 8000,
    });
    const first = Object.values(data?.data || {})[0];
    const price = Number(first?.price);
    return { priceUsd: Number.isFinite(price) ? price : null };
  } catch {
    return { priceUsd: null };
  }
}

/**
 * getPriceAndMc(ca, chain?)
 * Returns { priceUsd, mcUsd, ticker }
 */
async function getPriceAndMc(ca, chain) {
  // 1) Dexscreener for both chains
  let d = await fromDexscreener(ca);

  // 2) Fallback: SOL price via Jupiter
  if (!d.priceUsd && (chain === "sol" || isSol(ca))) {
    const j = await fromJupiter(ca);
    d.priceUsd = d.priceUsd || j.priceUsd;
  }

  // 3) If still missing MC but we have a price, apply a safe heuristic
  if (!d.mcUsd && d.priceUsd) {
    // Many meme tokens start at ~1B supply on SOL. Heuristic is better than "—".
    d.mcUsd = Math.round(d.priceUsd * 1_000_000_000);
  }
  return d;
}

module.exports = { getPriceAndMc, isSol, isEvm };
