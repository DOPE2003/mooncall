// model/premium.model.js
const mongoose = require('mongoose'); // ✅ use mongoose; lib/db sets up the connection

const PremiumSchema = new mongoose.Schema(
  {
    tgId: { type: String, index: true, unique: true, required: true },
    username: String,

    // permanent premium plan (4 calls/day)
    callsPerDay: { type: Number, default: 4 },
    permanent: { type: Boolean, default: true },

    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('PremiumUser', PremiumSchema);
