// lib/price.js
// Lightweight helpers to fetch token info from Dexscreener and format values.

const DS_BASE = 'https://api.dexscreener.com/latest/dex';

// ---------- formatting ----------
function usd(n) {
  if (n == null || !isFinite(n)) return '$—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)         return `$${(n / 1_000).toFixed(2)}K`;
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// ---------- address utils ----------
function stripSolscanTx(urlOrSig='') {
  return String(urlOrSig).replace(/^https?:\/\/(www\.)?solscan\.io\/tx\//i, '').trim();
}
function cleanAddress(raw='') {
  let s = String(raw).trim();
  // remove frequent wrappers
  s = s.replace(/^https?:\/\/(www\.)?dexscreener\.com\/(solana|bsc|eth|ethereum)\//i, '');
  s = s.replace(/^https?:\/\/(www\.)?pump\.fun\/coin\//i, '');
  s = s.replace(/^solana:/i, '');
  // cut after first space
  s = s.split(/\s+/)[0];
  // drop pump suffix if present
  s = s.replace(/pump$/i, '');
  return s.trim();
}
function isBsc(addr) { return /^0x[a-fA-F0-9]{40}$/.test(addr); }
function isSolMint(addr) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr); }
function detectChain(addr) { return isBsc(addr) ? 'BSC' : 'SOL'; }

// ---------- dex fetch ----------
async function fetchDexscreenerPairsByToken(addr) {
  const url = `${DS_BASE}/tokens/${addr}`;
  const r = await fetch(url, {
    headers: {
      'accept': 'application/json',
      // a UA avoids sporadic 403s on some hosts
      'user-agent': 'Mozilla/5.0 (Mooncall Bot; +dexscreener integration)',
    }
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !Array.isArray(j.pairs) || j.pairs.length === 0) return null;
  return j.pairs;
}

function pickBestPair(pairs, wantChain) {
  if (!pairs || !pairs.length) return null;
  const target = String(wantChain || '').toLowerCase() === 'bsc' ? 'bsc' : 'solana';

  // prefer the chain we want, then sort by liquidity USD desc
  const filtered = pairs.filter(p => (p.chainId || '').toLowerCase() === target);
  const list = (filtered.length ? filtered : pairs)
    .slice()
    .sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));

  return list[0] || null;
}

function pairToInfo(pair, chainUpper) {
  const base = pair.baseToken || {};
  const quote = pair.quoteToken || {};
  const name = base.name || pair.info?.name || '';
  const ticker = (base.symbol || '').replace(/[^\w]/g, '').slice(0, 12);

  const chainId = (pair.chainId || '').toLowerCase(); // 'solana', 'bsc', etc.
  const chain = chainUpper || (chainId === 'bsc' ? 'BSC' : 'SOL');

  // prefer DexScreener metrics; fall back to FDV if marketCap missing
  const mc = pair.marketCap ?? pair.fdv ?? null;
  const lp = pair?.liquidity?.usd ?? null;
  const vol24h = pair?.volume?.h24 ?? null;

  // URLs
  const chartUrl = pair.url || `https://dexscreener.com/${chainId}/${pair.pairAddress}`;
  const tradeUrl = chartUrl;
  const pairUrl = chartUrl;

  // crude age in hours if createdAt present
  const ageHours = pair.createdAt ? Math.max(0, (Date.now() - Number(pair.createdAt)) / 36e5) : undefined;

  return {
    chain,
    name,
    ticker,
    mc,
    lp,
    vol24h,
    chartUrl,
    tradeUrl,
    pairUrl,
    dex: pair.dexId || pair.dex || 'DEX',
    ageHours,
    imageUrl: null,       // Dexscreener doesn't provide a logo here
    dexPaid: undefined,   // not available from Dexscreener
  };
}

// ---------- public API ----------
async function getTokenInfo(rawInput) {
  const addr = cleanAddress(rawInput);
  const chain = detectChain(addr);

  // Try Dexscreener token endpoint
  try {
    const pairs = await fetchDexscreenerPairsByToken(addr);
    if (pairs && pairs.length) {
      const pair = pickBestPair(pairs, chain);
      if (pair) return pairToInfo(pair, chain);
    }
  } catch (e) {
    // swallow and fall back
    console.warn('Dexscreener fetch failed:', e.message);
  }

  // Fallback: return minimal info so the bot can still post,
  // and the worker will start tracking once Dexscreener catches up.
  const chartUrl =
    chain === 'SOL'
      ? `https://dexscreener.com/solana/${encodeURIComponent(addr)}`
      : `https://dexscreener.com/bsc/${encodeURIComponent(addr)}`;

  return {
    chain,
    name: '',
    ticker: '',
    mc: null,         // unknown for now
    lp: null,
    vol24h: null,
    chartUrl,
    tradeUrl: chartUrl,
    pairUrl: chartUrl,
    dex: chain === 'SOL' ? 'PumpFun' : 'DEX',
    ageHours: undefined,
    imageUrl: null,
    dexPaid: undefined,
  };
}

module.exports = {
  usd,
  getTokenInfo,
  isSolMint,
  isBsc,
  stripSolscanTx,
  cleanAddress,
  detectChain,
};
