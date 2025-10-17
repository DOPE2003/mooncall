// lib/db.js
const mongoose = require("mongoose");

let cached = global._mongoose;
if (!cached) cached = global._mongoose = { conn: null, promise: null };

module.exports = async function dbConnect() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    const uri = process.env.MONGO_URI;
    cached.promise = mongoose.connect(uri, {
      dbName: process.env.MONGO_DB || "mooncall",
    }).then(m => m.connection);
  }
  cached.conn = await cached.promise;
  return cached.conn;
};
