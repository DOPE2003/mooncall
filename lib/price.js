// lib/price.js
// Unified token info for Mooncall cards + helpers

// -------- helpers ------------------------------------------------------------
const SOL_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?$/;
const BSC_CA_RE     = /^0x[a-fA-F0-9]{40}$/;

const abbrevUsd = (n) => {
  if (!Number.isFinite(+n)) return '$—';
  const v = +n;
  if (v >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v/1e9 ).toFixed(2)}B`;
  if (v >= 1e6)  return `$${(v/1e6 ).toFixed(2)}M`;
  if (v >= 1e3)  return `$${(v/1e3 ).toFixed(2)}K`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

function isSolMint(s = '') { return SOL_BASE58_RE.test(String(s).trim()); }
function isBsc(s = '')     { return BSC_CA_RE.test(String(s).trim()); }
function usd(n)            { return abbrevUsd(n); }

// Prefer the pair with largest USD liquidity on requested chain
function pickBestPair(pairs = [], wantChain /* 'solana' | 'bsc' */) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const onChain = pairs.filter(p => p?.chainId === wantChain);
  const list = onChain.length ? onChain : pairs;
  return list
    .slice()
    .sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
}

// Normalize chain label into our upper-case style
const dsToUpper = (cid) => (cid || '').toUpperCase() === 'SOLANA' ? 'SOL'
  : (cid || '').toUpperCase() === 'BSC' ? 'BSC'
  : (cid || '').toUpperCase();

// Clean “…pump” suffix Phantom users paste
const stripPumpSuffix = (mint) => String(mint || '').replace(/pump$/i, '');

// -------- Dexscreener fetch --------------------------------------------------
async function fetchDexscreenerByToken(token) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`;
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !Array.isArray(j.pairs) || !j.pairs.length) return null;
  return j.pairs;
}

// -------- Pump.fun helpers (fresh mints) ------------------------------------
async function fetchPumpfunJSON(mint) {
  // Main JSON (undocumented but widely used)
  const url = `https://pump.fun/api/data/${encodeURIComponent(mint)}`;
  try {
    const r = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return j || null;
  } catch { return null; }
}

async function fetchPumpfunHTMLProgress(mint) {
  try {
    const r = await fetch(`https://pump.fun/coin/${encodeURIComponent(mint)}`, { headers: { accept: 'text/html' } });
    if (!r.ok) return null;
    const html = await r.text();
    // Try a couple of likely keys from their embedded state
    const m = html.match(/"bonding(?:_curve_|Curve)progress"\s*:\s*([0-9.]+)/i)
           || html.match(/"bondingCurveProgress"\s*:\s*([0-9.]+)/);
    if (!m) return null;
    let pct = Number(m[1]);
    if (Number.isFinite(pct) && pct <= 1) pct *= 100;
    return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  } catch { return null; }
}

// Synthesize a card-friendly object from Pump.fun
async function buildFromPumpfun(mintRaw) {
  const mint = stripPumpSuffix(mintRaw);
  const j = await fetchPumpfunJSON(mint);
  if (!j) return null;

  // Try a variety of field names Pump.fun has used
  const name   = j.name || j.tokenName || j.ticker || j.symbol || 'Token';
  const ticker = j.symbol || j.ticker || '';
  const image  = j.image || j.imageUrl || j.image_url || null;

  const mc = j.market_cap || j.marketCap || j.usd_market_cap || j.usdMarketCap || j.marketCapUsd || null;
  const priceUsd = j.price_usd || j.priceUsd || j.usd_price || null;
  const vol24h   = j.volume_24h_usd || j.volume24hUsd || j.volume24h || null;
  const lpUsd    = j.liquidity_usd || j.liquidityUsd || null;

  let curveProgress = j.bonding_curve_progress ?? j.bondingCurveProgress ?? j.curveProgress ?? null;
  if (!Number.isFinite(curveProgress)) {
    curveProgress = await fetchPumpfunHTMLProgress(mint);
  }
  if (Number.isFinite(curveProgress) && curveProgress <= 1) curveProgress *= 100;

  return {
    chain: 'SOL',
    name,
    ticker,
    imageUrl: image || undefined,
    mc: Number(mc) || null,
    lp: Number(lpUsd) || null,
    vol24h: Number(vol24h) || null,
    priceUsd: Number(priceUsd) || null,
    chartUrl: `https://dexscreener.com/solana/${encodeURIComponent(mint)}`,
    tradeUrl: `https://pump.fun/coin/${encodeURIComponent(mint)}`,
    dex: 'PumpFun',
    dexName: 'PumpFun',
    curveProgress: Number.isFinite(curveProgress) ? curveProgress : null,
    // Pump-specific safety flags are unknown here; leave undefined so card shows "—"
    liquidityBurnedPct: undefined,
    freezeAuthority: undefined,
    mintAuthority: undefined,
    twitter: j.twitter || j.twitter_url || undefined,
  };
}

// -------- Main unified fetch -------------------------------------------------
async function getTokenInfo(idRaw) {
  const id = String(idRaw || '').trim();
  const isSol = isSolMint(id);
  const isEvm = isBsc(id);

  // 1) Dexscreener (preferred)
  try {
    const pairs = await fetchDexscreenerByToken(stripPumpSuffix(id));
    if (pairs && pairs.length) {
      const best = pickBestPair(pairs, isSol ? 'solana' : (isEvm ? 'bsc' : null));
      const p = best || pairs[0];

      const info = {
        chain: dsToUpper(p?.chainId) || (isSol ? 'SOL' : isEvm ? 'BSC' : undefined),
        name: p?.baseToken?.name || p?.info?.name || 'Token',
        ticker: p?.baseToken?.symbol || p?.info?.symbol || '',
        mc: p?.marketCap || p?.fdv || null,
        lp: p?.liquidity?.usd || null,
        vol24h: p?.volume?.h24 || null,
        priceUsd: p?.priceUsd ? Number(p.priceUsd) : null,
        chartUrl: p?.url || null,
        pairUrl: p?.url || null,
        tradeUrl: p?.url || null,
        dex: p?.dexId || 'DEX',
        dexName: p?.dexId || 'DEX',
        dexPaid: undefined, // Dexscreener doesn’t expose “paid” status
        imageUrl: p?.info?.imageUrl || undefined,
        twitter: p?.info?.twitter || undefined,

        // Safety flags: Dexscreener doesn’t provide; keep undefined → "—"
        liquidityBurnedPct: undefined,
        freezeAuthority: undefined,
        mintAuthority: undefined,

        // Bubblemap URL is built elsewhere for EVM
        bubblemapUrl: undefined,
        curveProgress: undefined,
      };

      return info;
    }
  } catch (e) {
    // fall through to Pump.fun if SOL
    // console.warn('Dexscreener fetch failed:', e?.message);
  }

  // 2) Pump.fun fallback (SOL fresh mints)
  if (isSol) {
    const pf = await buildFromPumpfun(id);
    if (pf) return pf;
  }

  // 3) If nothing worked, return a minimal shell so callers can message nicely
  return null;
}

module.exports = {
  getTokenInfo,
  isSolMint,
  isBsc,
  usd,
};
