// model/user.model.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    tgId: { type: String, unique: true, index: true },
    username: String,

    premium: {
      active: { type: Boolean, default: false },
      // if null => no expiry (lifetime)
      expiresAt: { type: Date, default: null },
      // last memo/tx note we recorded
      memo: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', UserSchema);
