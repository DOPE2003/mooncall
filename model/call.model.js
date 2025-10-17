// model/call.model.js
const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    telegramId: String,
    userId: String,
    callerHandle: String,

    chain: { type: String, enum: ["sol", "bsc"] },
    mintAddress: String,
    thesis: { type: String, default: "" },

    entryPrice: { type: Number, default: 0 },
    lastPrice: { type: Number, default: null },
    peakPrice: { type: Number, default: null },

    // market cap when called (used in /mycalls)
    entryMc: { type: Number, default: null },

    nextMilestone: { type: Number, default: 2 },
    status: { type: String, enum: ["active", "ended"], default: "active" },
    nextCheckAt: { type: Date, default: () => new Date(Date.now() + 60 * 60 * 1000) },
    expiresAt: { type: Date, default: null },

    _dumpAlerted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);
