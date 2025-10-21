// lib/price.js
// Dexscreener-based fetcher for SOL mint or BSC 0x CA.
// Returns: { chain, ticker, mc, lp, vol24h, pairUrl, dex, ageHours }
const axios = require('axios');

const DS_TOKEN = (id) =>
  `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(id)}`;

const isSolMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
const isBsc = (s) => /^0x[a-fA-F0-9]{40}$/.test(s.trim());

function usd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1_000) return `$${n.toLocaleString()}`;
  if (n < 1_000_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${(n / 1_000_000_000).toFixed(2)}B`;
}

async function getTokenInfo(id) {
  const t0 = Date.now();
  const url = DS_TOKEN(id);
  const { data } = await axios.get(url, { timeout: 12_000 });
  if (!data || !Array.isArray(data.pairs) || data.pairs.length === 0) {
    return null;
  }
  // choose the pair with highest liquidityUsd
  const pairs = data.pairs
    .filter((p) => p && p.liquidity && p.liquidity.usd != null)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

  const p = pairs[0];
  const chainId = p.chainId; // 'solana' | 'bsc' | etc.
  const chain =
    chainId === 'solana'
      ? 'SOL'
      : chainId === 'bsc'
      ? 'BSC'
      : chainId?.toUpperCase() || '—';

  const ticker = p.baseToken?.symbol || p.quoteToken?.symbol || '—';
  const mc = p.fdv ? Number(p.fdv) : null; // Dexscreener FDV is closest proxy to MC
  const lp = p.liquidity?.usd != null ? Number(p.liquidity.usd) : null;
  const vol24h = p.volume?.h24 != null ? Number(p.volume.h24) : null;
  const dex = p.dexId || 'dex';
  const pairUrl = p.url || `https://dexscreener.com/${chainId}`;
  const ageHours = p.pairCreatedAt
    ? Math.max(0, Math.round((Date.now() - Number(p.pairCreatedAt)) / 36e5))
    : null;

  return {
    chain,
    ticker,
    mc,
    lp,
    vol24h,
    pairUrl,
    dex,
    ageHours,
    _raw: p,
    _ms: Date.now() - t0,
  };
}

module.exports = { getTokenInfo, usd, isSolMint, isBsc };
