// index.js
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
require("./model/db");
const { initiateMooncallBot } = require("./mooncall");

const app = express();
app.use(cors({ origin: "*" }));
app.get("/", (_req, res) => res.json({ ok: true, name: "mooncall" }));

const PORT = process.env.PORT || 3600;
app.listen(PORT, () => console.log(`MOONCALL server on :${PORT}`));
initiateMooncallBot();
