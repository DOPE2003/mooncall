// leaderboard.js
const callModel = require("./model/call.model");

function fmt(n) { return n.toFixed(2); }

async function getLeaderboard(limit = 10) {
  const calls = await callModel.find({}).lean();
  const map = new Map();
  for (const c of calls) {
    const key = c.telegramId || c.userId || "unknown";
    if (!map.has(key)) map.set(key, { handle: c.callerHandle || null, total: 0, bestX: 1, sumX: 0, n: 0 });
    const r = map.get(key);
    r.total += 1;
    const e = c.entryPrice || 0;
    const cur = c.lastPrice ?? c.entryPrice ?? 0;
    if (e > 0 && cur > 0) {
      const x = cur / e;
      r.bestX = Math.max(r.bestX, x);
      r.sumX += x;
      r.n += 1;
    }
  }
  const rows = [...map.entries()].map(([id, r]) => ({
    id,
    handle: r.handle,
    totalCalls: r.total,
    bestX: r.bestX,
    avgX: r.n ? r.sumX / r.n : 1,
  }));
  rows.sort((a, b) => b.bestX - a.bestX || b.avgX - a.avgX || b.totalCalls - a.totalCalls);
  return rows.slice(0, limit);
}

function formatLeaderboard(rows) {
  if (!rows.length) return "No callers yet.";
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ["🏅 <b>Top Callers</b>", ""];
  rows.forEach((r, i) => {
    const tag = i < 3 ? medals[i] : `${i + 1}.`;
    const who = r.handle ? r.handle : `tg:${r.id}`;
    lines.push(
      `${tag} ${who} — Best: ${fmt(r.bestX)}× | Avg: ${fmt(r.avgX)}× | Calls: ${r.totalCalls}`
    );
  });
  return lines.join("\n");
}

module.exports = { getLeaderboard, formatLeaderboard };
