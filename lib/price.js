// lib/price.js
const fetch = (...a) => import('node-fetch').then(({default: f}) => f(...a));

function usd(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  if (v >= 1_000_000_000) return `$${(v/1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v/1_000).toFixed(2)}K`;
  return `$${v.toFixed(0)}`;
}

function shortAddr(s, head=4, tail=4) {
  if (!s || s.length < head + tail + 3) return s || '';
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function isSolMint(s='') {
  // 32–44 base58 characters (rough guard)
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s));
}
function isBsc(s='') {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s));
}

// A single function you already use; ensure it returns image + chartUrl.
async function getTokenInfo(mintOrCa) {
  // Use Dexscreener pair search; pick best pair
  const url = `https://api.dexscreener.com/latest/dex/search?q=${mintOrCa}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const pair = (json?.pairs || [])[0];
  if (!pair) return null;

  const chainId = pair.chainId?.toUpperCase() || 'SOL';
  const ticker =
    pair.baseToken?.symbol ||
    pair.quoteToken?.symbol ||
    pair.info?.symbol ||
    null;

  // Market cap heuristic: sometimes in pair info, sometimes in fdv
  const mc = Number(pair.fdv || pair.marketCap || 0) || null;
  const lp = Number(pair.liquidity?.usd || 0) || null;
  const vol24h = Number(pair.volume?.h24 || 0) || null;

  // Age in hours (from pair data if present)
  let ageHours = null;
  if (pair.pairCreatedAt) {
    const ms = Date.now() - Number(pair.pairCreatedAt);
    ageHours = Math.max(0, Math.round(ms / 36e5));
  }

  // Logos come in different fields
  const image =
    pair.info?.imageUrl ||
    pair.baseToken?.logo ||
    pair.quoteToken?.logo ||
    null;

  const chartUrl = pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;

  return {
    chain: chainId === 'BSC' ? 'BSC' : 'SOL',
    ticker,
    mc,
    lp,
    vol24h,
    ageHours,
    dex: pair.dexId || 'Dex',
    image,
    chartUrl,
  };
}

module.exports = { getTokenInfo, isSolMint, isBsc, usd, shortAddr };
