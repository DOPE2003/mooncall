// model/call.model.js
const mongoose = require("../model/db");

const CallSchema = new mongoose.Schema(
  {
    // who
    tgId: { type: String, index: true, required: true },
    handle: { type: String },

    // what
    ca: { type: String, required: true, index: true }, // contract / mint
    chain: { type: String, enum: ["sol", "bsc"], required: true },
    ticker: { type: String, default: "" },

    // prices / MC (USD)
    entryPriceUsd: { type: Number, default: 0 },
    entryMcUsd: { type: Number, default: 0 },

    lastPriceUsd: { type: Number, default: 0 },
    lastMcUsd: { type: Number, default: 0 },

    peakMcUsd: { type: Number, default: 0 },

    // milestones (flags); keys: 'x2','x4',... and 'int_10','int_11',... after 10x
    milestonesHit: { type: Object, default: {} },

    // housekeeping
    startedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);
