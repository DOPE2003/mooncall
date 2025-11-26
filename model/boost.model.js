// model/boost.model.js
const mongoose = require('mongoose');

const BoostSchema = new mongoose.Schema(
  {
    ca: { type: String, required: true },
    chain: { type: String, required: true },

    requester: {
      tgId: { type: String, required: true },
      username: { type: String },
    },

    // Payment info
    paid: { type: Boolean, default: false },
    freeByAdmin: { type: Boolean, default: false },
    txSig: { type: String },

    // Status:
    //  - await_payment: user still has to pay / send tx sig
    //  - active: bot is posting every hour
    //  - finished / cancelled: no more posts
    status: {
      type: String,
      enum: ['await_payment', 'active', 'finished', 'cancelled'],
      default: 'await_payment',
    },

    postsRemaining: { type: Number, default: 0 },
    nextPostAt: { type: Date },
    lastPostAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

BoostSchema.index({ status: 1, nextPostAt: 1 });

module.exports = mongoose.model('Boost', BoostSchema);
