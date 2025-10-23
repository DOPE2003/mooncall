// model/premium.model.js
const mongoose = require('mongoose');

const PremiumSchema = new mongoose.Schema(
  {
    tgId: { type: String, index: true, unique: true },
    username: String,

    // premium flags
    permanent: { type: Boolean, default: false }, // lifetime premium
    callsPerDay: { type: Number, default: 4 },

    // manual verification flow
    pending: { type: Boolean, default: false },
    txSig: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PremiumUser', PremiumSchema);
