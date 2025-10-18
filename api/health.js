const mongoose = require("mongoose");

const SessionSchema = new mongoose.Schema(
  {
    userId: { type: String, index: true, unique: true },
    step: { type: String, default: "idle" },
    data: { type: Object, default: {} },
    updatedAt: { type: Date, default: Date.now, index: true },
  },
  { minimize: false }
);

// TTL: auto-clean after 1 hour of inactivity
SessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 3600 });

module.exports =
  mongoose.models.Session || mongoose.model("Session", SessionSchema);
