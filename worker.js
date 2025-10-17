// worker.js
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mongoose = require("mongoose");
const callModel = require("./model/call.model");
const Settings = require("./model/settings.model");
const { getPrice } = require("./price");
const { postToChannel } = require("./mooncall");

mongoose.set("strictQuery", true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const fmtX = (x) => `${x.toFixed(2)}×`;
const pct = (p) => `${(p * 100).toFixed(1)}%`;

async function connectWithRetry() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing in .env");
  for (;;) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      const c = mongoose.connection;
      console.log(`✅ Mongo connected: ${c.host}/${c.name}`);
      c.on("error", (e) => console.error("❌ Mongo connection error:", e.message));
      c.on("disconnected", () => console.error("⚠️  Mongo disconnected"));
      return;
    } catch (e) {
      console.error("❌ Mongo connect failed:", e.message);
      console.log("⏳ retrying in 5s…");
      await sleep(5000);
    }
  }
}

async function readSettings() {
  const s = await Settings.findById("global").lean().exec();
  const envMilestones = (process.env.MILESTONES || "2,4,6,10")
    .split(",")
    .map((v) => parseFloat(v.trim()))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    milestones: s?.milestones?.length ? s.milestones : envMilestones,
    intervalMin: Number(s?.checkIntervalMinutes || process.env.CHECK_INTERVAL_MINUTES || 60),
    paused: !!s?.paused,
  };
}

async function tick() {
  const cfg = await readSettings();
  if (cfg.paused) return;

  const due = await callModel
    .find({ status: "active", nextCheckAt: { $lte: new Date() } })
    .limit(100);

  if (due.length) console.log(`🔎 processing ${due.length} call(s)…`);

  for (const c of due) {
    const entry = c.entryPrice || 0;
    const price = await getPrice(c.chain, c.mintAddress).catch(() => null);
    const nowD = new Date();

    let peak = c.peakPrice ?? price ?? null;
    if (price != null && (peak == null || price > peak)) peak = price;

    const next = new Date(now() + cfg.intervalMin * 60_000);
    const updates = {
      lastPrice: price ?? c.lastPrice ?? null,
      peakPrice: peak ?? c.peakPrice ?? null,
      nextCheckAt: next,
    };

    if (entry > 0 && price != null) {
      const mult = price / entry;
      const needed = c.nextMilestone || cfg.milestones.find((m) => m > 1) || 2;
      if (mult >= needed) {
        const nextNeeded = cfg.milestones.find((m) => m > needed) || null;
        updates.nextMilestone = nextNeeded;
        const msg =
          `🚀 <b>${c.mintAddress.slice(0, 4)}…${c.mintAddress.slice(-4)}</b> hit <b>${fmtX(needed)}</b> since call!\n\n` +
          `Entry: ${entry}\n` +
          `Now: ${price}  (Peak: ${peak ?? price})\n` +
          (nextNeeded ? `Next milestone: ${fmtX(nextNeeded)}` : `ATH reached so far.`);
        try { await postToChannel(msg); } catch {}
      }

      const dumpThresh = parseFloat(process.env.DUMP_ALERT_DRAWDOWN || "0.0");
      if (dumpThresh > 0 && peak && price < peak) {
        const dd = (peak - price) / peak;
        if (dd >= dumpThresh && !c._dumpAlerted) {
          updates._dumpAlerted = true;
          const msg =
            `⚠️ <b>${c.mintAddress.slice(0, 4)}…${c.mintAddress.slice(-4)}</b> down ${pct(dd)} from peak.\n\n` +
            `Peak: ${peak}  →  Now: ${price}  (Entry: ${entry || "?"})`;
          try { await postToChannel(msg); } catch {}
        }
      }
    }

    if (c.expiresAt && c.expiresAt <= nowD) {
      updates.status = "ended";
      const e = entry || 0;
      const last = price ?? c.lastPrice ?? e;
      const peakF = peak ?? e;
      const peakX = e > 0 ? peakF / e : 1;
      const lastX = e > 0 ? last / e : 1;

      const msg =
        `🧾 Tracking ended for <b>${c.mintAddress.slice(0, 4)}…${c.mintAddress.slice(-4)}</b>\n\n` +
        `Entry: ${e}\n` +
        `Peak: ${peakF} (${fmtX(peakX)})\n` +
        `Final: ${last} (${fmtX(lastX)})\n` +
        `Caller: ${c.callerHandle || "tg:" + c.telegramId}`;
      try { await postToChannel(msg); } catch {}
    }

    await callModel.updateOne({ _id: c._id }, { $set: updates }).exec();
  }
}

async function main() {
  await connectWithRetry();
  console.log("📡 Worker running…");
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error("tick error:", e.message);
    }
    await sleep(15_000);
  }
}

main();
