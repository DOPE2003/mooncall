// leaderboard.js
const Call = require("./model/call.model");

async function getLeaderboard(limit = 10) {
  // avg X = average(last/entry), best X = max(last/entry)
  const rows = await Call.aggregate([
    { $match: { entryPrice: { $gt: 0 } } },
    {
      $project: {
        telegramId: 1, callerHandle: 1,
        x: {
          $cond: [
            {$gt:["$lastPrice", 0]},
            {$divide:["$lastPrice", "$entryPrice"]},
            1
          ]
        }
      }
    },
    {
      $group: {
        _id: "$telegramId",
        handle: { $first: "$callerHandle" },
        total: { $sum: 1 },
        avgX: { $avg: "$x" },
        bestX: { $max: "$x" }
      }
    },
    { $sort: { avgX: -1, bestX: -1, total: -1 } },
    { $limit: limit }
  ]);
  return rows;
}

function formatLeaderboard(rows) {
  if (!rows.length) return "No callers yet.";
  const lines = ["🏅Top Callers\n"];
  rows.forEach((r, i) => {
    const who = r.handle ? r.handle : r._id;
    lines.push(
      `${i+1}. ${who} — Avg ${r.avgX.toFixed(2)}× • Best ${r.bestX.toFixed(2)}× • ${r.total} calls`
    );
  });
  return lines.join("\n");
}

module.exports = { getLeaderboard, formatLeaderboard };
