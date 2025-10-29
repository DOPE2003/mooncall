// lib/price.js
// Unified token info for Mooncall cards + helpers

// ----------------- small utils -----------------
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?$/;
const BSC_RE = /^0x[a-fA-F0-9]{40}$/;

const UA = 'Mozilla/5.0 (MooncallBot; +https://t.me/mooncall)';

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

// A fetch that also works on Node <18 (if node-fetch is installed)
async function nodeFetch(url, init) {
  if (globalThis.fetch) return globalThis.fetch(url, init);
  const { default: f } = await import('node-fetch'); // ESM; dynamic import
  return f(url, init);
}

async function getJSON(url) {
  try {
    const r = await nodeFetch(url, { headers: { 'accept':'application/json', 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.json().catch(()=>null);
  } catch { return null; }
}

async function getText(url) {
  try {
    const r = await nodeFetch(url, { headers: { 'accept':'text/html,*/*;q=0.8', 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

// ----------------- Dexscreener -----------------
async function dsByToken(token) {
  return (await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`))?.pairs || null;
}
async function dsSearch(q) {
  return (await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`))?.pairs || null;
}

// ----------------- Pump.fun (SOL) -------------
async function pfTryAll(mint) {
  // Try several current/legacy endpoints, first one that returns JSON wins.
  const candidates = [
    `https://frontend-api.pump.fun/coins/${mint}`,
    `https://pump.fun/api/coin/${mint}`,
    `https://pump.fun/api/coins/${mint}`,
    `https://pump.fun/api/data/${mint}`,
  ];
  for (const u of candidates) {
    const j = await getJSON(u);
    if (j && typeof j === 'object') return { json: j, src: u };
  }
  return null;
}

// Some pages embed the curve progress in HTML; extract it if we have to.
function extractCurveFromHTML(html) {
  if (!html) return null;
  const m = html.match(/"bonding(?:_curve_|Curve)progress"\s*:\s*([0-9.]+)/i)
          || html.match(/"bondingCurveProgress"\s*:\s*([0-9.]+)/);
  if (!m) return null;
  let pct = Number(m[1]);
  if (Number.isFinite(pct) && pct <= 1) pct *= 100;
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
}

function readNumber(...xs) {
  for (const x of xs) {
    const v = Number(x);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

async function fromPumpfun(mintRaw) {
  const mint = stripPump(mintRaw);

  const hit = await pfTryAll(mint);
  const j = hit?.json;
  if (!j) {
    // last-resort: scrape
    const html = await getText(`https://pump.fun/coin/${encodeURIComponent(mint)}`);
    const curve = extractCurveFromHTML(html);
    if (curve == null) return null;
    return {
      chain: 'SOL',
      name: 'Token',
      ticker: '',
      mc: null,
      lp: null,
      vol24h: null,
      priceUsd: null,
      imageUrl: undefined,
      chartUrl: `https://dexscreener.com/solana/${encodeURIComponent(mint)}`,
      tradeUrl: `https://pump.fun/coin/${encodeURIComponent(mint)}`,
      dex: 'PumpFun',
      dexName: 'PumpFun',
      curveProgress: curve,
      liquidityBurnedPct: undefined,
      freezeAuthority: undefined,
      mintAuthority: undefined,
      twitter: undefined,
    };
  }

  // Try a bunch of likely keys — Pump.fun changes them sometimes.
  const curve =
    readNumber(
      j.bonding_curve_progress, j.bondingCurveProgress, j.curveProgress,
      j.progress, j.bondingProgress, j.curve_progress,
      j?.bonding_curve_state?.progress
    );

  const mc = readNumber(j.market_cap, j.marketCap, j.usd_market_cap, j.usdMarketCap);
  const lp = readNumber(j.liquidity_usd, j.liquidityUsd);
  const vol24h = readNumber(j.volume_24h_usd, j.volume24hUsd, j.volume24h);
  const priceUsd = readNumber(j.price_usd, j.priceUsd);

  // Fallbacks for name/symbol
  const name = j.name || j.tokenName || j?.metadata?.name || 'Token';
  const ticker = j.symbol || j.ticker || j?.metadata?.symbol || '';

  return {
    chain: 'SOL',
    name,
    ticker,
    mc,
    lp,
    vol24h,
    priceUsd: priceUsd || null,
    imageUrl: j.image || j.imageUrl || j?.logo || undefined,
    chartUrl: `https://dexscreener.com/solana/${encodeURIComponent(mint)}`,
    tradeUrl: `https://pump.fun/coin/${encodeURIComponent(mint)}`,
    dex: 'PumpFun',
    dexName: 'PumpFun',
    curveProgress: Number.isFinite(curve) ? (curve <= 1 ? curve * 100 : curve) : null,
    // flags unknown → show "—" on card
    liquidityBurnedPct: undefined,
    freezeAuthority: undefined,
    mintAuthority: undefined,
    twitter: j.twitter || j.twitter_url || j?.links?.twitter || undefined,
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
        liquidityBurnedPct: undefined,
        freezeAuthority: undefined,
        mintAuthority: undefined,
        bubblemapUrl: undefined,
        curveProgress: undefined,
      };
    }
  } catch {}

  // 2) Dexscreener search endpoint
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
  } catch {}

  // 3) Pump.fun fallback for fresh SOL mints
  if (isSol) {
    const pf = await fromPumpfun(token);
    if (pf) return pf;
  }

  // 4) give up
  return null;
}

module.exports = { getTokenInfo, isSolMint, isBsc, usd };
