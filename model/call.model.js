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

    curveProgress: { type: Number, min: 0, max: 100 },

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
    ca: { type: String, required: true, index: true },

    chain: {
      type: String,
      enum: ['SOL', 'BSC'],
      required: true,
      set: (v) => (v ? String(v).toUpperCase() : v),
      index: true,
    },

    ticker: { type: String },

    entryMc: { type: Number, required: true, min: 0 },
    peakMc:  { type: Number, default: 0, min: 0 },
    lastMc:  { type: Number, default: 0, min: 0 },

    // 🔒 prevents worker from re-inflating peak after admin trims
    peakLocked: { type: Boolean, default: false, index: true },

    // Snapshot of data at call time
    entry: { type: EntrySnapshotSchema, default: undefined },

    multipliersHit: { type: [Number], default: [] },

    postedMessageId: { type: Number },

    caller: { type: CallerSchema, required: true },

    // ---- curation flags ----
    // Use this exact name — all bot code reads/writes it.
    excludedFromLeaderboard: { type: Boolean, default: false, index: true },

    // Back-compat alias (old field name). Keep so old data isn't lost.
    // NOTE: alias is for getters/setters on docs; queries/updates should use excludedFromLeaderboard.
    excludeFromLeaders: { type: Boolean, select: false },

    flags: { type: [String], default: [] },
    suspiciousScore: { type: Number, min: 0, max: 100, default: 0 },
    suspiciousReason: { type: String },
  },
  { timestamps: true }
);

// Helpful compound index for lookups & dedupe checks
CallSchema.index({ ca: 1, chain: 1, createdAt: -1 });

module.exports = mongoose.model('Call', CallSchema);
