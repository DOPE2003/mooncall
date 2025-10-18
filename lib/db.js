// lib/db.js
const mongoose = require("mongoose");

let cached = global.__mongo_cached;
if (!cached) cached = global.__mongo_cached = { conn: null, promise: null };

module.exports = async function dbConnect () {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    mongoose.set("strictQuery", true);
    cached.promise = mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 })
      .then(m => {
        const c = mongoose.connection;
        c.on("error", e => console.error("Mongo error:", e.message));
        c.on("disconnected", () => console.error("Mongo disconnected"));
        return m;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
};
