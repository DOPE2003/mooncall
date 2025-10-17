// model/settings.model.js
const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    milestones: { type: [Number], default: undefined },
    checkIntervalMinutes: { type: Number, default: undefined },
    paused: { type: Boolean, default: false },
  },
  { timestamps: true, _id: false }
);

module.exports = mongoose.model("Settings", SettingsSchema);
