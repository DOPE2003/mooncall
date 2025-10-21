// model/call.model.js
const mongoose = require('mongoose');

const CallSchema = new mongoose.Schema(
  {
    ca: { type: String, index: true, trim: true },          // SOL mint or BSC CA
    chain: { type: String, enum: ['SOL', 'BSC'], index: true },
    ticker: { type: String, trim: true },
    entryMc: { type: Number, default: null },                // market cap at call time
    peakMc: { type: Number, default: null },                 // highest seen mc
    lastMc: { type: Number, default: null },                 // most recent mc
    multipliersHit: { type: [Number], default: [] },         // [2,4,6,10, ...]
    postedMessageId: { type: Number },                       // channel post id (for View link)
    caller: {
      tgId: { type: String, index: true },                   // store tgId as string
      username: { type: String, trim: true },
    },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Call', CallSchema);
