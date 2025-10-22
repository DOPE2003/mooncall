const mongoose = require('mongoose');

const CallSchema = new mongoose.Schema(
  {
    ca: { type: String, required: true, index: true },
    // Always store in upper-case so it matches the enum
    chain: {
      type: String,
      enum: ['SOL', 'BSC'],
      required: true,
      set: v => (v ? String(v).toUpperCase() : v),
    },
    ticker: String,
    entryMc: { type: Number, default: 0 },
    peakMc: { type: Number, default: 0 },
    lastMc: { type: Number, default: 0 },
    multipliersHit: { type: [Number], default: [] },
    postedMessageId: Number,
    caller: {
      tgId: String,
      username: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Call', CallSchema);
