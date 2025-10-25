// lib/price.js
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
function cleanAddress(raw='') {
  let s = String(raw || '').trim();
  s = s.replace(/^https?:\/\/(www\.)?dexscreener\.com\/(solana|bsc|eth|ethereum)\//i, '');
  s = s.replace(/^https?:\/\/(www\.)?pump\.fun\/coin\//i, '');
  s = s.replace(/^solana:/i, '');
  s = s.split(/\s+/)[0];
  s = s.replace(/pump$/i, ''); // drop trailing "pump"
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
      'user-agent': 'Mozilla/5.0 (Mooncall Bot)',
    }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j?.pairs) && j.pairs.length ? j.pairs : null;
}
function pickBestPair(pairs, wantChain) {
  if (!pairs?.length) return null;
  const target = String(wantChain || '').toLowerCase() === 'bsc' ? 'bsc' : 'solana';
  const filtered = pairs.filter(p => (p.chainId || '').toLowerCase() === target);
  const list = (filtered.length ? filtered : pairs)
    .slice()
    .sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
  return list[0] || null;
}
function pairToInfo(pair, forcedChain) {
  const base = pair.baseToken || {};
  const chainId = (pair.chainId || '').toLowerCase();
  const chain = forcedChain || (chainId === 'bsc' ? 'BSC' : 'SOL');
  return {
    chain,
    name: base.name || '',
    ticker: (base.symbol || '').replace(/[^\w]/g, '').slice(0, 12),
    mc: pair.marketCap ?? pair.fdv ?? null,
    lp: pair?.liquidity?.usd ?? null,
    vol24h: pair?.volume?.h24 ?? null,
    chartUrl: pair.url || `https://dexscreener.com/${chainId}/${pair.pairAddress}`,
    tradeUrl: pair.url,
    pairUrl: pair.url,
    dex: pair.dexId || 'DEX',
    ageHours: pair.createdAt ? Math.max(0, (Date.now() - Number(pair.createdAt)) / 36e5) : undefined,
    imageUrl: null,
    dexPaid: undefined,
    // Pump.fun-specific fields left undefined here:
    bondingProgressPct: undefined,
    createdOnName: undefined,
    createdOnUrl: undefined,
    burnPct: undefined,
    freezeAuthority: undefined,
    mintAuthority: undefined,
    twitter: undefined,
    bubblemapUrl: undefined,
  };
}

// ---------- Pump.fun fallback for SOL ----------
async function fetchPumpFunCoin(mint) {
  // Public frontend API. Fields are not guaranteed; read defensively.
  const url = `https://frontend-api.pump.fun/coins/${mint}`;
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();

  // Try a bunch of likely keys
  const mc =
    j.market_cap ?? j.marketCap ?? j.usd_market_cap ?? j.usdMarketCap ?? null;

  // progress could be 0..1 or 0..100 – accept either
  let prog = j.bonding_curve_progress ?? j.bondingCurveProgress ?? j.curve_progress ?? j.progress;
  if (prog != null) {
    prog = Number(prog);
    if (isFinite(prog) && prog <= 1) prog = prog * 100;
  }

  const burn =
    j.liquidity_burned ?? j.liquidityBurned ?? j.burned ?? null;
  const freeze =
    j.freeze_authority ?? j.freezeAuthority ?? null;
  const mintAuth =
    j.mint_authority ?? j.mintAuthority ?? null;

  return {
    mc: isFinite(mc) ? Number(mc) : null,
    bondingProgressPct: isFinite(prog) ? Math.max(0, Math.min(100, prog)) : null,
    createdOnName: 'PumpFun',
    createdOnUrl: `https://pump.fun/coin/${mint}`,
    burnPct: burn === true ? 100 : (isFinite(burn) ? Number(burn) : null),
    freezeAuthority: freeze === true,
    mintAuthority: mintAuth === true,
    twitter: j.twitter ?? j.twitter_url ?? null,
  };
}

// ---------- public API ----------
async function getTokenInfo(rawInput) {
  const addr = cleanAddress(rawInput);
  const chain = detectChain(addr);

  // 1) Dexscreener first
  try {
    const pairs = await fetchDexscreenerPairsByToken(addr);
    if (pairs?.length) {
      const pair = pickBestPair(pairs, chain);
      if (pair) return pairToInfo(pair, chain);
    }
  } catch (e) {
    console.warn('Dexscreener fetch failed:', e.message);
  }

  // 2) Pump.fun fallback for SOL (gives MC + bonding curve + links)
  let pump = null;
  if (chain === 'SOL') {
    try { pump = await fetchPumpFunCoin(addr); } catch {}
  }

  const chartUrl =
    chain === 'SOL'
      ? `https://dexscreener.com/solana/${encodeURIComponent(addr)}`
      : `https://dexscreener.com/bsc/${encodeURIComponent(addr)}`;

  return {
    chain,
    name: '',
    ticker: '',
    mc: pump?.mc ?? null,
    lp: null,
    vol24h: null,
    chartUrl,
    tradeUrl: chartUrl,
    pairUrl: chartUrl,
    dex: chain === 'SOL' ? 'PumpFun' : 'DEX',
    ageHours: undefined,
    imageUrl: null,
    dexPaid: undefined,

    bondingProgressPct: pump?.bondingProgressPct ?? null,
    createdOnName: pump?.createdOnName ?? (chain === 'SOL' ? 'PumpFun' : 'DEX'),
    createdOnUrl: pump?.createdOnUrl ?? null,
    burnPct: pump?.burnPct ?? null,
    freezeAuthority: pump?.freezeAuthority ?? undefined,
    mintAuthority: pump?.mintAuthority ?? undefined,
    twitter: pump?.twitter ?? null,

    // Bubblemap only for EVM
    bubblemapUrl: chain === 'BSC' ? `https://app.bubblemaps.io/token/bsc/${addr}` : null,
  };
}

module.exports = {
  usd,
  getTokenInfo,
  isSolMint,
  isBsc,
  cleanAddress,
  detectChain,
};
