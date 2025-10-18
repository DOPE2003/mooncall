// model/call.model.js
const { Schema, model, models } = require("mongoose");

const CallSchema = new Schema({
  telegramId: { type: String, index: true },
  userId: { type: String },
  callerHandle: { type: String },

  chain: { type: String, enum: ["sol","bsc"], required: true },
  mintAddress: { type: String, required: true, index: true },

  thesis: { type: String, default: "" },

  entryPrice: { type: Number, default: 0 },
  lastPrice: { type: Number, default: null },
  peakPrice: { type: Number, default: null },
  peakMultiple: { type: Number, default: null },

  entryMc: { type: Number, default: null },

  // milestone flags like hit2x/hit4x/...
  hit2x: { type: Boolean, default: false },
  hit3x: { type: Boolean, default: false },
  hit4x: { type: Boolean, default: false },
  hit5x: { type: Boolean, default: false },
  hit6x: { type: Boolean, default: false },
  hit8x: { type: Boolean, default: false },
  hit10x: { type: Boolean, default: false },

  dumpAlerted: { type: Boolean, default: false },

  nextMilestone: { type: Number, default: 2 },

  status: { type: String, enum:["active","expired"], default: "active", index: true },
  nextCheckAt: { type: Date, default: () => new Date(Date.now()+60*60*1000), index: true },
  expiresAt: { type: Date },

}, { timestamps: true });

module.exports = models.Call || model("Call", CallSchema);
