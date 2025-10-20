// model/call.model.js
const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    // who
    userTgId: { type: String, index: true },
    userHandle: { type: String }, // e.g. "crypto_enjoyer01"

    // token
    chain: { type: String, enum: ["sol", "bsc"], default: "sol" }, // infer at save time
    tokenMint: { type: String, index: true }, // SOL mint or BSC 0x
    symbol: { type: String },                 // $TICKER if you store it

    // prices / mc
    entryPrice: { type: Number }, // required for PnL math
    entryMc: { type: Number },    // optional (market cap at call time)

    lastPrice: { type: Number },
    lastMc: { type: Number },

    peakPrice: { type: Number },
    peakMc: { type: Number },

    // milestones and rules
    milestonesHit: { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { "hit_2x": true }
    lastIntXNotified: { type: Number, default: 0 }, // last ≥10x integer milestone sent
    trackingDisabled: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

module.exports = mongoose.models.Call || mongoose.model("Call", CallSchema);
