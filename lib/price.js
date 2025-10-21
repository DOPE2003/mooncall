// lib/price.js
const fetch = require('node-fetch');

const USD = (n) => {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${Number(n).toFixed(2)}`;
};

const shortAddr = (s) => (s && s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s || '—');

const isSolMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
const isBsc = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || '');

async function getTokenInfo(addr) {
  // Dexscreener token endpoint – works for both SOL mints & EVM CAs
  const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const pair = Array.isArray(data.pairs) && data.pairs.length ? data.pairs[0] : null;
  if (!pair) return null;

  // chain / symbol
  const chain = (pair.chainId || '').toUpperCase(); // 'solana', 'bsc' → SOL/BSC mapping below
  const chainMap = { SOLANA: 'SOL', BSC: 'BSC' };
  const chainLabel = chainMap[chain] || (chain || '—');

  // image & chart
  const imageUrl =
    pair?.info?.imageUrl ||
    pair?.info?.image ||
    pair?.baseToken?.logoURI ||
    null;
  const chartUrl = pair?.url || null;

  // pricing stats (best-effort)
  const mc = pair?.fdv || pair?.marketCap || null;
  const lp = pair?.liquidity?.usd ?? null;
  const vol24h = pair?.volume?.h24 ?? null;

  // token/ticker/name (prefer baseToken)
  const ticker =
    pair?.baseToken?.symbol ||
    pair?.info?.symbol ||
    pair?.info?.name ||
    null;

  // age → “hours old”
  let ageHours = null;
  if (pair?.pairCreatedAt) {
    const ms = Date.now() - Number(pair.pairCreatedAt);
    ageHours = Math.max(0, Math.floor(ms / 3600000));
  }

  // dex name
  const dex = pair?.dexId || 'dex';

  return {
    ticker,
    chain: chainLabel,
    imageUrl,
    chartUrl,
    mc,
    lp,
    vol24h,
    ageHours,
    dex,
  };
}

module.exports = {
  getTokenInfo,
  isSolMint,
  isBsc,
  usd: USD,
  shortAddr,
};
