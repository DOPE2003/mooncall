const mongoose = require('mongoose');

const CallerSchema = new mongoose.Schema(
  {
    tgId: { type: String, required: true },
    username: { type: String }, // @handle if available
  },
  { _id: false }
);

const EntrySnapshotSchema = new mongoose.Schema(
  {
    mc: { type: Number, min: 0 },
    lp: { type: Number, min: 0 },
    vol24h: { type: Number, min: 0 },
    priceUsd: { type: Number, min: 0 },

    dex: { type: String },
    dexName: { type: String },
    chartUrl: { type: String },
    pairUrl: { type: String },
    tradeUrl: { type: String },

    // Pump.fun curve progress (0..100)
    curveProgress: { type: Number, min: 0, max: 100 },

    // Safety/metadata at call time
    liquidityBurnedPct: { type: Number, min: 0, max: 100 },
    freezeAuthority: { type: Boolean },
    mintAuthority: { type: Boolean },
    dexPaid: { type: Boolean },
    twitter: { type: String },
    imageUrl: { type: String },
  },
  { _id: false }
);

const CallSchema = new mongoose.Schema(
  {
    // Contract address / mint
    ca: { type: String, required: true, index: true },

    // Chain enum (uppercased by setter)
    chain: {
      type: String,
      enum: ['SOL', 'BSC'],
      required: true,
      set: (v) => (v ? String(v).toUpperCase() : v),
      index: true,
    },

    ticker: { type: String },

    // MC tracking
    entryMc: { type: Number, required: true, min: 0 },
    peakMc:  { type: Number, default: 0, min: 0 },
    lastMc:  { type: Number, default: 0, min: 0 },

    // 🔒 prevent worker from re-inflating after admin trims
    peakLocked: { type: Boolean, default: false, index: true },

    // Snapshot of data at call time
    entry: { type: EntrySnapshotSchema, default: undefined },

    // Milestones hit (e.g. [2,3,10])
    multipliersHit: { type: [Number], default: [] },

    // Channel message id for original post
    postedMessageId: { type: Number, index: true },

    // Who called it
    caller: { type: CallerSchema, required: true },

    // ---- curation flags ----
    // Canonical flag used everywhere now
    excludedFromLeaderboard: { type: Boolean, default: false, index: true },

    // Legacy flag kept for back-compat (hidden by default)
    // NOTE: queries should use excludedFromLeaderboard; we still OR this in pipelines.
    excludeFromLeaders: { type: Boolean, select: false },

    // Optional tagging
    flags: { type: [String], default: [] },
    suspiciousScore: { type: Number, min: 0, max: 100, default: 0 },
    suspiciousReason: { type: String },
  },
  { timestamps: true }
);

// Helpful indexes
CallSchema.index({ ca: 1, chain: 1, createdAt: -1 });  // fast dedupe/recent lookups
CallSchema.index({ 'caller.tgId': 1, createdAt: -1 }); // /mycalls & leaderboards

module.exports = mongoose.model('Call', CallSchema);
