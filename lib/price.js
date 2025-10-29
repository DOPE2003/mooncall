// lib/price.js
// Unified token info for Mooncall cards + helpers (Dexscreener + Pump.fun + on-chain SPL mint)

const { getMintSafety, stripPump } = require('./solana');

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

const pickBestPair = (pairs=[], wantChain /* 'solana'|'bsc' */) => {
  if (!pairs.length) return null;
  const onChain = wantChain ? pairs.filter(p => p?.chainId === wantChain) : pairs;
  return (onChain.length ? onChain : pairs)
    .slice()
    .sort((a,b)=> (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0))[0];
};

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'accept':'application/json', 'user-agent': UA } });
  if (!r.ok) return null;
  return r.json().catch(()=>null);
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
    const r = await fetch(`https://pump.fun/coin/${encodeURIComponent(mint)}`, {
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

  // Heuristic: show 100% burn only once curve is complete (post-migration usually burns LP)
  const burnPct = Number.isFinite(curve) && curve >= 100 ? 100 : undefined;

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
    liquidityBurnedPct: burnPct,
    freezeAuthority: undefined, // filled by on-chain check below
    mintAuthority: undefined,   // filled by on-chain check below
    twitter: j.twitter || j.twitter_url || undefined,
    // For the “DexS Prepaid?” line Solbix shows ❌ while still on curve.
    dexPaid: false,
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

      const base = {
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
        dexPaid: undefined, // unknown for DS (Solbix also leaves it blank/neutral when listed)
      };

      // On-chain SPL mint safety (Solana only)
      if (base.chain === 'SOL') {
        const safety = await getMintSafety(token);
        base.freezeAuthority = safety.freezeAuthorityRenounced;
        base.mintAuthority   = safety.mintAuthorityRenounced;
      }

      return base;
    }
  } catch { /* try search next */ }

  // 2) Dexscreener search endpoint (sometimes tokens endpoint is empty)
  try {
    const pairs = await dsSearch(token);
    if (pairs?.length) {
      const want = isSol ? 'solana' : (isEvm ? 'bsc' : undefined);
      const exact = pairs.filter(p =>
        (p?.baseToken?.address?.toLowerCase?.() || '') === token.toLowerCase()
      );
      const candidates = exact.length ? exact : pairs;
      const p = pickBestPair(candidates, want) || candidates[0];

      const mc = Number(p?.marketCap ?? p?.fdv);
      const vol24h = Number(p?.volume?.h24);
      const lp = Number(p?.liquidity?.usd);

      const base = {
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
        dexPaid: undefined,
      };

      if (base.chain === 'SOL') {
        const safety = await getMintSafety(token);
        base.freezeAuthority = safety.freezeAuthorityRenounced;
        base.mintAuthority   = safety.mintAuthorityRenounced;
      }

      return base;
    }
  } catch { /* proceed to Pump.fun if SOL */ }

  // 3) Pump.fun fallback for SOL fresh mints
  if (isSol) {
    const pf = await fromPumpfun(token);
    if (pf) {
      // Add on-chain safety flags here too
      const safety = await getMintSafety(token);
      pf.freezeAuthority = safety.freezeAuthorityRenounced;
      pf.mintAuthority   = safety.mintAuthorityRenounced;
      return pf;
    }
  }

  // 4) give up
  return null;
}

module.exports = { getTokenInfo, isSolMint, isBsc, usd };
