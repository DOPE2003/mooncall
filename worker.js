// worker.js
require("dotenv").config();
const { Telegram } = require("telegraf");
require("./model/db");
const Call = require("./model/call.model");
const { getPrice } = require("./price");

const tg = new Telegram(process.env.BOT_TOKEN);
const CH_ID = process.env.ALERTS_CHANNEL_ID;

const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 5);
const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);
const MILES = (process.env.MILESTONES || "2,4,6,10")
  .split(",").map(s => Number(s.trim())).filter(n => !Number.isNaN(n) && n > 1)
  .sort((a,b) => a - b);

function shortMint(m) { if (!m) return "unknown"; return m.startsWith("0x") ? m.slice(0,4)+"…"+m.slice(-4) : m.slice(0,4)+"…"+m.slice(-4); }
function symbolOrFallback(call) { return (call.symbol || "").trim(); }
function chainFromMint(call, ca) { return call.chain || (ca?.startsWith("0x") ? "bsc" : "sol"); }
function fmtMoney(n){ if(n==null||Number.isNaN(n))return "—"; const a=Math.abs(n); if(a>=1e9)return `$${(n/1e9).toFixed(1)}B`; if(a>=1e6)return `$${(n/1e6).toFixed(1)}M`; if(a>=1e3)return `$${(n/1e3).toFixed(1)}K`; return `$${n.toFixed(0)}`; }
function fmtSince(start, now=new Date()){ const ms=Math.max(0, now - new Date(start)); const m=Math.floor(ms/60000); const h=Math.floor(m/60); const mm=m%60; if(h>=24){const d=Math.floor(h/24); const hh=h%24; return `${d}d ${hh}h`;} return `${h}h:${String(mm).padStart(2,"0")}m`; }

function parseTradeBots(chain){
  const line = chain === "bsc" ? process.env.TRADE_BOTS_BSC : process.env.TRADE_BOTS_SOL;
  const out=[]; if(!line) return out;
  for(const part of line.split(",")){ const [label,link]=part.split("|").map(s=>s?.trim()); if(label&&link){ const url = link.startsWith("@")?`https://t.me/${link.slice(1)}`:link; out.push({text:label,url}); } }
  return out;
}
function buildKeyboard(call, ca){
  const chain = chainFromMint(call, ca);
  const chart = { text: "📈 Chart", url: chain==="bsc" ? `https://dexscreener.com/bsc/${ca}` : `https://dexscreener.com/solana/${ca}` };
  const trade = { text: "🌕 Trade", url: chain==="bsc" ? `https://pancakeswap.finance/?outputCurrency=${ca}` : `https://jup.ag/swap/USDC-${ca}` };
  const bots = parseTradeBots(chain);
  const rows = [[chart, trade]];
  for (let i=0;i<bots.length;i+=2) rows.push(bots.slice(i,i+2));
  return { inline_keyboard: rows };
}

async function sendSub10xAlert(call, milestoneX, nowMc, ca){
  const sym = symbolOrFallback(call);
  const since = fmtSince(call.createdAt);
  const entryMc = call.entryMc ?? null;
  const msg =
`${"🚀".repeat(Math.min(milestoneX, 30))} ${sym ? `$${sym}` : shortMint(ca)} hit ${milestoneX.toFixed(2)}× since call!

Called at MC: ${fmtMoney(entryMc)} by @${call.userHandle || "unknown"}
Now MC: ${fmtMoney(nowMc)}
(since ${since})`;
  await tg.sendMessage(CH_ID, msg, { disable_web_page_preview:true, reply_markup: buildKeyboard(call, ca) });
}

async function send10xPlusAlert(call, intX, nowMc, ca){
  const sym = symbolOrFallback(call);
  const head = sym ? `🌕 $${sym}` : `🌕 ${shortMint(ca)}`;
  const since = fmtSince(call.createdAt);
  const entryMc = call.entryMc ?? null;
  const by = call.userHandle ? ` by @${call.userHandle}` : "";
  const msg = `${head} ${intX}x | ⚡️From ${fmtMoney(entryMc)} 🚀 ${fmtMoney(nowMc)} within ${since}${by}`;
  await tg.sendMessage(CH_ID, msg, { disable_web_page_preview:true, reply_markup: buildKeyboard(call, ca) });
}

async function tick() {
  const cutoff = new Date(Date.now() - BASE_DAYS * 24 * 60 * 60 * 1000);
  const list = await Call.find({ createdAt: { $gt: cutoff }, trackingDisabled: { $ne: true } }).lean();

  for (const c of list) {
    // tolerate legacy field names
    const ca = c.tokenMint || c.mint || c.ca || c.token || c.address;
    try {
      if (!c.entryPrice) continue;          // skip if entry missing (see backfill below)
      if (!ca) { console.warn("skip: missing CA on doc", c._id?.toString()); continue; }

      const chain = chainFromMint(c, ca);
      const { price, mc } = await getPrice(ca, chain);
      if (!price) continue;

      const nowX = price / c.entryPrice;
      const updates = {
        lastPrice: price,
        lastMc: mc ?? c.lastMc ?? null,
        peakPrice: Math.max(c.peakPrice || 0, price),
        peakMc: mc != null ? Math.max(c.peakMc || 0, mc) : (c.peakMc ?? null),
      };

      if (nowX < 10) {
        for (const m of MILES) {
          if (nowX >= m) {
            const key = `hit_${m}x`;
            if (!c.milestonesHit || !c.milestonesHit[key]) {
              await sendSub10xAlert(c, m, mc, ca);
              updates.milestonesHit = Object.assign({}, c.milestonesHit, { [key]: true });
            }
          }
        }
      }

      if (nowX >= 10) {
        const intX = Math.floor(nowX);
        const lastInt = c.lastIntXNotified || 0;
        if (intX > Math.max(lastInt, 9)) {
          await send10xPlusAlert(c, intX, mc, ca);
          updates.lastIntXNotified = intX;
        }
      }

      await Call.updateOne({ _id: c._id }, { $set: updates });
    } catch (e) {
      console.error("tick error", ca || "unknown-ca", e.message);
    }
  }
}

console.log("📡 Worker running…");
setInterval(tick, CHECK_MIN * 60 * 1000);
tick();
