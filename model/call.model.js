const mongoose = require('mongoose');

const CallerSchema = new mongoose.Schema(
  {
    tgId: { type: String, required: true },
    username: { type: String }, // @handle if available
  },
  { _id: false }
);

// Optional snapshot of stats at the exact time of the call.
// This lets you show consistent historical numbers (MC/LP/vol, dex name, etc.)
// even if APIs change later.
const EntrySnapshotSchema = new mongoose.Schema(
  {
    mc: { type: Number, min: 0 },          // market cap USD
    lp: { type: Number, min: 0 },          // liquidity USD
    vol24h: { type: Number, min: 0 },      // 24h volume USD
    priceUsd: { type: Number, min: 0 },

    dex: { type: String },                 // e.g., "raydium" / "pumpfun" / "pancakeswap"
    dexName: { type: String },
    chartUrl: { type: String },
    pairUrl: { type: String },
    tradeUrl: { type: String },

    // Pump.fun (SOL) bonding curve % at call time (0..100)
    curveProgress: { type: Number, min: 0, max: 100 },

    // Token safety/metadata flags as known at call time
    liquidityBurnedPct: { type: Number, min: 0, max: 100 },
    freezeAuthority: { type: Boolean },
    mintAuthority: { type: Boolean },
    dexPaid: { type: Boolean },            // paid “DexS” listing or not
    twitter: { type: String },
    imageUrl: { type: String },
  },
  { _id: false }
);

const CallSchema = new mongoose.Schema(
  {
    // Contract address / mint. (We normalize per-chain in the bot before saving.)
    ca: { type: String, required: true, index: true },

    // Chain enum, always kept uppercase by the setter so 'sol'/'bsc' never break validation.
    chain: {
      type: String,
      enum: ['SOL', 'BSC'],
      required: true,
      set: (v) => (v ? String(v).toUpperCase() : v),
      index: true,
    },

    ticker: { type: String },

    // Market-cap values (USD). entryMc is when the call was posted.
    entryMc: { type: Number, required: true, min: 0 },
    peakMc: { type: Number, default: 0, min: 0 },
    lastMc: { type: Number, default: 0, min: 0 },

    // Snapshot of data at call time (optional but recommended)
    entry: { type: EntrySnapshotSchema, default: undefined },

    // Milestones we already alerted for (e.g., [2,3,10,11,...])
    multipliersHit: { type: [Number], default: [] },

    // Message id of the original channel post (if any)
    postedMessageId: { type: Number },

    // Who called it
    caller: { type: CallerSchema, required: true },

    // ---- Anti-MEV / curation flags (optional) ----
    // Exclude this call from leaderboard calculations (manual or auto)
    excludeFromLeaders: { type: Boolean, default: false, index: true },
    // Lightweight reason(s) or tags like ["mev_spike","illiquid","flash_pump"]
    flags: { type: [String], default: [] },
    // Numeric score from your detector (0..100). Higher = more suspicious.
    suspiciousScore: { type: Number, min: 0, max: 100, default: 0 },
    // Freeform reason string (easier to show in admin tools)
    suspiciousReason: { type: String },
  },
  { timestamps: true }
);

// Helpful compound index for lookups & dedupe checks
CallSchema.index({ ca: 1, chain: 1, createdAt: -1 });

module.exports = mongoose.model('Call', CallSchema);
