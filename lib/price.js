// lib/price.js
// Data helpers + robust Dexscreener lookups with fallback.

const DS = 'https://api.dexscreener.com/latest/dex';

// ----- tiny utils ------------------------------------------------------------
function prettyUSD(n) {
  if (n == null || isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  let div = 1, suf = '';
  if (abs >= 1e9) { div = 1e9; suf = 'B'; }
  else if (abs >= 1e6) { div = 1e6; suf = 'M'; }
  else if (abs >= 1e3) { div = 1e3; suf = 'K'; }
  return '$' + (v / div).toLocaleString(undefined, { maximumFractionDigits: 2 }) + suf;
}

function shortAddr(a) {
  if (!a) return '—';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

const SOL_MINT_RX = /^[1-9A-HJ-NP-Za-km-z]{25,64}$/;  // relaxed base58
const BSC_RX      = /^0x[a-fA-F0-9]{40}$/;

function isSolMint(s) { return SOL_MINT_RX.test(String(s).trim()); }
function isBsc(s)     { return BSC_RX.test(String(s).trim()); }

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// ----- core: get token info --------------------------------------------------
// Returns null if nothing found. When found, fields:
// { chain, mc, lp, vol24h, chartUrl, ageHours, ticker, dex, imageUrl }
async function getTokenInfo(addr) {
  addr = String(addr).trim();
  let pair;

  // 1) Direct token lookup
  try {
    const data = await getJSON(`${DS}/tokens/${addr}`);
    pair = data?.pairs?.[0];
  } catch (_) {}

  // 2) Fallback: fulltext search and pick best match
  if (!pair) {
    try {
      const data = await getJSON(`${DS}/search?q=${addr}`);
      const pairs = data?.pairs || [];
      pair =
        pairs.find(p => p.baseToken?.address?.toLowerCase() === addr.toLowerCase()) ||
        pairs[0];
    } catch (_) {}
  }
  if (!pair) return null;

  const chainId = (pair.chainId || '').toLowerCase();
  const chain = chainId === 'solana' ? 'SOL' : chainId.toUpperCase();
  const mc = pair.fdv ?? pair.marketCap ?? null;
  const lp = pair.liquidity?.usd ?? null;
  const vol24h = pair.volume?.h24 ?? pair.volume24h ?? null;

  const chartUrl =
    pair.url ||
    (pair.pairAddress ? `https://dexscreener.com/${chainId}/${pair.pairAddress}` : undefined);

  const ticker = pair.baseToken?.symbol || null;
  const dex = pair.dexId || 'dex';

  // Dexscreener sometimes has images under .info or .baseToken.logo
  const imageUrl = pair.info?.imageUrl || pair.baseToken?.logo || null;

  return { chain, mc, lp, vol24h, chartUrl, ageHours: undefined, ticker, dex, imageUrl };
}

module.exports = {
  getTokenInfo,
  isSolMint,
  isBsc,
  usd: prettyUSD,
  shortAddr
};
