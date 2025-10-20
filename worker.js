// worker.js
require("dotenv").config();
require("./model/db");

const Call = require("./model/call.model");
const { getPriceAndMc } = require("./price");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CH_ID = process.env.ALERTS_CHANNEL_ID;

const MILESTONES = (process.env.MILESTONES || "2,4,6,10")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => x > 1)
  .sort((a, b) => a - b);

const CHECK_MS = Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES || 5)) * 60 * 1000;

const fmtUSD = (n) =>
  n === null || n === undefined
    ? "—"
    : "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

const ago = (d) => {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return (h ? `${h}h:` : "") + `${mm}m`;
};

async function postToChannel(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CH_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("sendMessage failed:", res.status, t);
  }
}

function rockets(mult) {
  const n = Math.min(Math.max(Math.floor(mult), 2) * 2, 30);
  return "🚀".repeat(n);
}

function formatOver10x(call, nowMc) {
  const x = call.entryMcUsd > 0 ? nowMc / call.entryMcUsd : 0;
  const intX = Math.floor(x);
  const name = call.ticker ? `$${call.ticker}` : call.ca.slice(0, 4) + "…" + call.ca.slice(-4);
  return [
    `🌕 <b>${name} ${intX}x</b> | ⚡️From ${fmtUSD(call.entryMcUsd)} 🚀 ${fmtUSD(nowMc)} within ${ago(call.createdAt)}`,
    call.handle ? `by @${call.handle}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMilestone(call, nowMc, multiple, nextMs) {
  const name = call.ticker ? `$${call.ticker}` : call.ca.slice(0, 4) + "…" + call.ca.slice(-4);
  return [
    `${rockets(multiple)} <b>${name}</b> hit <b>${multiple.toFixed(2)}×</b> since call!`,
    "",
    `Called at MC: ${fmtUSD(call.entryMcUsd)}${call.handle ? ` by @${call.handle}` : ""}`,
    `Now MC: ${fmtUSD(nowMc)}`,
    nextMs ? `Next milestone: ${nextMs.toFixed(2)}×` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function tick() {
  const calls = await Call.find({ entryMcUsd: { $gt: 0 } })
    .sort({ createdAt: -1 })
    .limit(500);

  for (const call of calls) {
    if (!call.ca) {
      console.log("skip: missing CA on doc", call._id.toString());
      continue;
    }

    const info = await getPriceAndMc(call.ca, call.chain);
    if (!info.priceUsd || !info.mcUsd) {
      // unseen tokens may briefly be missing on aggregators
      // console.log("skip: price unavailable", call.ca);
      continue;
    }

    const nowMc = info.mcUsd;
    const entryMc = call.entryMcUsd || 0;
    if (!entryMc) continue;

    // Update current/peak/ticker
    call.lastPriceUsd = info.priceUsd;
    call.lastMcUsd = nowMc;
    if (!call.peakMcUsd || nowMc > call.peakMcUsd) call.peakMcUsd = nowMc;
    if (!call.ticker && info.ticker) call.ticker = info.ticker;
    await call.save();

    const curX = nowMc / entryMc;

    // 1) normal ladder (e.g., 2/4/6/10)
    for (const m of MILESTONES) {
      const key = `x${m}`;
      if (curX >= m && !call.milestonesHit[key]) {
        call.milestonesHit[key] = true;
        await call.save();
        const next = MILESTONES.find((z) => z > m);
        await postToChannel(formatMilestone(call, nowMc, curX, next));
      }
    }

    // 2) after 10x: integer-only alerts 10x, 11x, 12x, ...
    if (curX >= 10) {
      const intNow = Math.floor(curX);
      for (let x = 10; x <= intNow; x++) {
        const key = `int_${x}`;
        if (!call.milestonesHit[key]) {
          call.milestonesHit[key] = true;
          await call.save();
          await postToChannel(formatOver10x(call, nowMc));
        }
      }
    }
  }
}

console.log("📡 Worker running…");
tick().catch(console.error);
setInterval(() => tick().catch(console.error), CHECK_MS);
