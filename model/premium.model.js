// model/premium.model.js
const mongoose = require('mongoose');

const PremiumUserSchema = new mongoose.Schema(
  {
    tgId: { type: String, required: true, unique: true },

    // Lifetime premium flag
    permanent: { type: Boolean, default: false },

    // What premium means (we use 4 calls/day)
    callsPerDay: { type: Number, default: 4 },

    // User clicked “I Paid ✅” (waiting for signature or manual verification)
    pending: { type: Boolean, default: false },

    // Last signature provided by user (optional)
    lastPaymentTx: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PremiumUser', PremiumUserSchema);
