// lib/db.js
const mongoose = require("mongoose");

let connectPromise = null;
let connected = false;

module.exports = async function dbConnect() {
  if (connected && mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connectPromise) {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI missing");
    mongoose.set("strictQuery", true);
    connectPromise = mongoose
      .connect(uri, { serverSelectionTimeoutMS: 8000 })
      .then((m) => {
        connected = true;
        return m.connection;
      })
      .catch((e) => {
        connectPromise = null; // allow retry next time
        throw e;
      });
  }
  return connectPromise;
};
