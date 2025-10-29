// lib/price.js
// Unified token info for Mooncall cards + helpers

// ----------------- fetch polyfill (Node <18) -----------------
const doFetch =
  typeof fetch !== 'undefined'
    ? fetch
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ----------------- small utils -----------------
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?$/;
const BSC_RE = /^0x[a-fA-F0-9]{40}$/;

const UA = 'Mozilla/5.0 (MooncallBot; +https://t.me)';

const usd = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$—';
  if (v >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
  if (v >= 1e9 ) return `$${(v/1e9 ).toFixed(2)}B`;
  if (v >= 1e6 ) return `$${(v/1e6 ).toFixed(2)}M`;
  if (v >= 1e3 ) return `$${(v/1e3 ).toFixed(2)}K`;
  return `$${v.toLocaleString(undefined,{maximumFractionDigits:2})}`;
};
const isSolMint = (s='') => SOL_RE.test(String(s).trim());
const isBsc     = (s='') => BSC_RE.test(String(s).trim());
const stripPump = (m) => String(m || '').replace(/pump$/i, '');

const pickBestPair = (pairs=[], wantChain /* 'solana'|'bsc' */) => {
  if (!pairs.length) return null;
  const onChain = wantChain ? pairs.filter(p => p?.chainId === wantChain) : pairs;
  return (onChain.length ? onChain : pairs)
    .slice()
    .sort((a,b)=> (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0))[0];
};

async function getJSON(url) {
  try {
    const r = await doFetch(url, { headers: { 'accept':'application/json', 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

// ----------------- Dexscreener -----------------
async function dsByToken(token) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`;
  const j = await getJSON(url);
  return Array.isArray(j?.pairs) ? j.pairs : null;
}
async function dsSearch(q) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
  const j = await getJSON(url);
  return Array.isArray(j?.pairs) ? j.pairs : null;
}

// ----------------- Pump.fun fallback (SOL) ----
async function pfJSON(mint) {
  return getJSON(`https://pump.fun/api/data/${encodeURIComponent(mint)}`);
}
async function pfCurveFromHTML(mint) {
  try {
    const r = await doFetch(`https://pump.fun/coin/${encodeURIComponent(mint)}`, {
      headers: { 'accept':'text/html', 'user-agent': UA }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/"bonding(?:_curve_|Curve)progress"\s*:\s*([0-9.]+)/i)
        || html.match(/"bondingCurveProgress"\s*:\s*([0-9.]+)/);
    if (!m) return null;
    let pct = Number(m[1]);
    if (Number.isFinite(pct) && pct <= 1) pct *= 100;
    return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  } catch { return null; }
}
async function fromPumpfun(mintRaw) {
  const mint = stripPump(mintRaw);
  const j = await pfJSON(mint);
  if (!j) return null;

  let curve = j.bonding_curve_progress ?? j.bondingCurveProgress ?? j.curveProgress ?? null;
  if (!Number.isFinite(curve)) curve = await pfCurveFromHTML(mint);
  if (Number.isFinite(curve) && curve <= 1) curve *= 100;

  const mc = Number(j.market_cap ?? j.marketCap ?? j.usd_market_cap ?? j.usdMarketCap);
  const lp = Number(j.liquidity_usd ?? j.liquidityUsd);
  const vol24h = Number(j.volume_24h_usd ?? j.volume24hUsd ?? j.volume24h);

  return {
    chain: 'SOL',
    name: j.name || j.tokenName || 'Token',
    ticker: j.symbol || j.ticker || '',
    mc: Number.isFinite(mc) ? mc : null,
    lp: Number.isFinite(lp) ? lp : null,
    vol24h: Number.isFinite(vol24h) ? vol24h : null,
    priceUsd: Number(j.price_usd ?? j.priceUsd) || null,
    imageUrl: j.image || j.imageUrl || undefined,
    chartUrl: `https://dexscreener.com/solana/${encodeURIComponent(mint)}`,
    tradeUrl: `https://pump.fun/coin/${encodeURIComponent(mint)}`,
    dex: 'PumpFun',
    dexName: 'PumpFun',
    curveProgress: Number.isFinite(curve) ? curve : null,
    // flags unknown → show "—" on card
    liquidityBurnedPct: undefined,
    freezeAuthority: undefined,
    mintAuthority: undefined,
    twitter: j.twitter || j.twitter_url || undefined,
  };
}

// ----------------- Public API -----------------
async function getTokenInfo(idRaw) {
  const raw = String(idRaw || '').trim();
  const isSol = isSolMint(raw);
  const isEvm = isBsc(raw);
  const token = isSol ? stripPump(raw) : (isEvm ? raw.toLowerCase() : raw);

  // 1) Dexscreener tokens endpoint
  try {
    const pairs = await dsByToken(token);
    if (pairs?.length) {
      const want = isSol ? 'solana' : (isEvm ? 'bsc' : undefined);
      const p = pickBestPair(pairs, want) || pairs[0];

      const mc = Number(p?.marketCap ?? p?.fdv);
      const vol24h = Number(p?.volume?.h24);
      const lp = Number(p?.liquidity?.usd);

      return {
        chain: (p?.chainId || '').toUpperCase() === 'SOLANA' ? 'SOL'
             : (p?.chainId || '').toUpperCase() === 'BSC'    ? 'BSC'
             : (p?.chainId || '').toUpperCase(),
        name: p?.baseToken?.name || p?.info?.name || 'Token',
        ticker: p?.baseToken?.symbol || p?.info?.symbol || '',
        mc: Number.isFinite(mc) ? mc : null,
        lp: Number.isFinite(lp) ? lp : null,
        vol24h: Number.isFinite(vol24h) ? vol24h : null,
        priceUsd: Number(p?.priceUsd) || null,
        chartUrl: p?.url || null,
        pairUrl: p?.url || null,
        tradeUrl: p?.url || null,
        dex: p?.dexId || 'DEX',
        dexName: p?.dexId || 'DEX',
        imageUrl: p?.info?.imageUrl || undefined,
        twitter: p?.info?.twitter || undefined,
        // placeholders
        liquidityBurnedPct: undefined,
        freezeAuthority: undefined,
        mintAuthority: undefined,
        bubblemapUrl: undefined,
        curveProgress: undefined,
      };
    }
  } catch { /* fall through */ }

  // 2) Dexscreener search endpoint
  try {
    const pairs = await dsSearch(token);
    if (pairs?.length) {
      const want = isSol ? 'solana' : (isEvm ? 'bsc' : undefined);
      // Prefer exact baseToken address match when present
      const exact = pairs.filter(p => {
        const addr = p?.baseToken?.address;
        return addr && String(addr).toLowerCase() === String(token).toLowerCase();
      });
      const candidates = exact.length ? exact : pairs;
      const p = pickBestPair(candidates, want) || candidates[0];

      const mc = Number(p?.marketCap ?? p?.fdv);
      const vol24h = Number(p?.volume?.h24);
      const lp = Number(p?.liquidity?.usd);

      return {
        chain: (p?.chainId || '').toUpperCase() === 'SOLANA' ? 'SOL'
             : (p?.chainId || '').toUpperCase() === 'BSC'    ? 'BSC'
             : (p?.chainId || '').toUpperCase(),
        name: p?.baseToken?.name || p?.info?.name || 'Token',
        ticker: p?.baseToken?.symbol || p?.info?.symbol || '',
        mc: Number.isFinite(mc) ? mc : null,
        lp: Number.isFinite(lp) ? lp : null,
        vol24h: Number.isFinite(vol24h) ? vol24h : null,
        priceUsd: Number(p?.priceUsd) || null,
        chartUrl: p?.url || null,
        pairUrl: p?.url || null,
        tradeUrl: p?.url || null,
        dex: p?.dexId || 'DEX',
        dexName: p?.dexId || 'DEX',
        imageUrl: p?.info?.imageUrl || undefined,
        twitter: p?.info?.twitter || undefined,
        liquidityBurnedPct: undefined,
        freezeAuthority: undefined,
        mintAuthority: undefined,
        bubblemapUrl: undefined,
        curveProgress: undefined,
      };
    }
  } catch { /* proceed to Pump.fun if SOL */ }

  // 3) Pump.fun fallback for SOL fresh mints
  if (isSol) {
    try {
      const pf = await fromPumpfun(token);
      if (pf) return pf;
    } catch { /* ignore */ }
  }

  // 4) give up
  return null;
}

module.exports = { getTokenInfo, isSolMint, isBsc, usd };
