// card.js
const axios = require("axios");
const { Markup } = require("telegraf");

const USD = (n) => (n && isFinite(n)) ? `$${Math.round(n).toLocaleString()}` : "—";
const ageStr = (ts) => {
  if (!ts) return null;
  const ms = Date.now() - ts;
  if (ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m old`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h old`;
  const d = Math.floor(h / 24);
  return `${d}d old`;
};
const isNew = (ts) => ts && (Date.now() - ts) < 24 * 60 * 60 * 1000;

function chainTag(chainId, fallback) {
  const s = (chainId || fallback || "").toLowerCase();
  return s.includes("bsc") ? "BSC" : "SOL";
}
function dexLabel(dexId) {
  if (!dexId) return "DEX";
  const d = dexId.toLowerCase();
  if (d.includes("pump")) return "PumpFun";
  if (d.includes("raydium")) return "Raydium";
  if (d.includes("orca")) return "Orca";
  if (d.includes("pancake")) return "PancakeSwap";
  return dexId.charAt(0).toUpperCase() + d.slice(1);
}

function parseBots(env) {
  return (env || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [label, url] = pair.split("|").map((x) => x.trim());
      if (!label || !url) return null;
      return Markup.button.url(label, url);
    })
    .filter(Boolean);
}

function linksFor(chain, addr, meta) {
  const dsChain = chain === "bsc" ? "bsc" : "solana";
  const chart = `https://dexscreener.com/${dsChain}/${meta?.pairAddress || addr}`;
  const trade =
    chain === "bsc"
      ? `https://pancakeswap.finance/swap?outputCurrency=${addr}`
      : `https://jup.ag/swap/SOL-${addr}`;
  return { chart, trade };
}

async function fetchTokenMeta(chain, addr) {
  const url = "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(addr);
  const { data } = await axios.get(url, { timeout: 12000 });
  const pairs = data?.pairs || [];
  if (!pairs.length) return null;

  pairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
  const p = pairs[0];

  const base = p.baseToken || {};
  const info = p.info || {};
  const socials = info.socials || {};
  const websites = info.websites || [];

  const vol24 =
    Number(p.volume?.h24 ?? p?.volume24h ?? p?.txns?.h24?.volumeUSD ?? NaN);

  return {
    name: base.name || null,
    symbol: base.symbol || null,
    chainId: p.chainId || (chain === "bsc" ? "bsc" : "solana"),
    pairAddress: p.pairAddress || null,
    dexId: p.dexId || null,
    marketCap: Number(p.marketCap ?? p.fdv ?? NaN),
    liquidityUsd: Number(p?.liquidity?.usd ?? NaN),
    pairCreatedAt: p.pairCreatedAt,
    vol24: vol24,
    imageUrl: info.imageUrl || null,
    twitter: socials.twitter || null,
    telegram: socials.telegram || null,
    website: (Array.isArray(websites) && websites.length ? websites[0] : null)
  };
}

function buildText({ handle, chain, addr, meta }) {
  const tag = chainTag(meta?.chainId, chain);
  const dex = dexLabel(meta?.dexId);

  const name = meta?.name || "Unknown";
  const symbol = meta?.symbol ? `$${meta.symbol}` : "";
  const age = ageStr(meta?.pairCreatedAt);
  const newTag = isNew(meta?.pairCreatedAt) ? " | 🆕 New" : "";
  const ageTag = age ? ` | ⏱️ ${age}` : "";

  const lines = [];
  lines.push(`New Call by ${handle || "unknown"}`, "");
  lines.push(`${name} (${symbol})`, "");
  lines.push(`<code>${addr}</code>`, "");
  lines.push(`#${tag} (${dex})${newTag}${ageTag}`, "");
  lines.push(`📊 Stats`);
  lines.push(`🏦 MC: ${USD(meta?.marketCap)}`);
  lines.push(`💧 LP: ${USD(meta?.liquidityUsd)}`);
  if (isFinite(meta?.vol24)) lines.push(`📈 24h Vol: ${USD(meta.vol24)}`);
  lines.push("");

  const socialBits = [];
  if (meta?.twitter)  socialBits.push(`🐦 <a href="${meta.twitter}">Twitter</a>`);
  if (meta?.website)  socialBits.push(`🌎 <a href="${meta.website}">Website</a>`);
  if (meta?.telegram) socialBits.push(`💬 <a href="${meta.telegram}">Telegram</a>`);
  if (socialBits.length) {
    lines.push(`🌐 <b>Socials</b>`);
    lines.push(socialBits.join(" | "), "");
  }

  lines.push(new Date().toUTCString(), "");
  const botUser = process.env.BOT_USERNAME ? `@${process.env.BOT_USERNAME}` : "your bot";
  lines.push(`Make a call here 👉 ${botUser}`);

  return lines.join("\n");
}

function makeKeyboard(chain, urls) {
  const rows = [];
  rows.push([
    Markup.button.url("📈 Chart", urls.chart),
    Markup.button.url("🪙 Trade", urls.trade),
    Markup.button.url("🚀 Boost", process.env.COMMUNITY_CHANNEL_URL || "https://t.me/")
  ]);

  const bots = chain === "bsc"
    ? parseBots(process.env.TRADE_BOTS_BSC)
    : parseBots(process.env.TRADE_BOTS_SOL);

  for (let i = 0; i < bots.length; i += 3) rows.push(bots.slice(i, i + 3));
  return Markup.inlineKeyboard(rows);
}

async function buildCallCard({ chain, addr, handle }) {
  const meta = await fetchTokenMeta(chain, addr).catch(() => null);
  const urls = linksFor(chain, addr, meta || {});
  const text = buildText({ handle, chain, addr, meta: meta || {} });
  const keyboard = makeKeyboard(chain, urls);
  const photoUrl =
    String(process.env.CALL_CARD_USE_IMAGE).toLowerCase() === "true" && meta?.imageUrl
      ? meta.imageUrl
      : null;
  return { text, keyboard, photoUrl, meta };
}

module.exports = { buildCallCard, fetchTokenMeta, USD };
