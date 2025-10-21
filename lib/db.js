// lib/db.js
const mongoose = require('mongoose');

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('❌ MONGO_URI missing in .env');
  process.exit(1);
}

mongoose.set('strictQuery', true);

mongoose
  .connect(uri, { autoIndex: true })
  .then(() => console.log('✅ Mongo connected'))
  .catch((e) => {
    console.error('❌ Mongo connection error:', e.message);
    process.exit(1);
  });

module.exports = mongoose;
