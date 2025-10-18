// model/settings.model.js
const { Schema, model, models } = require("mongoose");

const SettingsSchema = new Schema({
  _id: { type: String, default: "global" },
  milestones: { type: [Number], default: [2,4,6,10] },
  checkIntervalMinutes: { type: Number, default: 60 },
  paused: { type: Boolean, default: false }
}, { _id: false });

module.exports = models.Settings || model("Settings", SettingsSchema);
