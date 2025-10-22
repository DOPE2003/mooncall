// model/call.model.js
const mongoose = require('mongoose');

const CallerSchema = new mongoose.Schema(
  {
    tgId: { type: String, required: true },
    username: { type: String }, // @handle if available
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

    // Milestones we already alerted for (e.g., [2,3,10,11,...])
    multipliersHit: { type: [Number], default: [] },

    // Message id of the original channel post (if any)
    postedMessageId: { type: Number },

    // Who called it
    caller: { type: CallerSchema, required: true },
  },
  { timestamps: true }
);

// Helpful compound index for lookups & dedupe checks
CallSchema.index({ ca: 1, chain: 1, createdAt: -1 });

module.exports = mongoose.model('Call', CallSchema);
