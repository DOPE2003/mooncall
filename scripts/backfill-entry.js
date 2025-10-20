// scripts/backfill-entry.js
require("dotenv").config();
require("../model/db");
const Call = require("../model/call.model");
const { getPrice } = require("../price");

(async () => {
  const q = { $or: [{ entryPrice: { $exists: false } }, { entryPrice: null }, { entryPrice: 0 }] };
  const list = await Call.find(q).limit(2000);
  console.log("backfilling", list.length, "calls…");
  for (const c of list) {
    const ca = c.tokenMint || c.mint || c.ca || c.token || c.address;
    if (!ca) continue;
    const chain = c.chain || (ca.startsWith("0x") ? "bsc" : "sol");
    try {
      const { price, mc } = await getPrice(ca, chain);
      if (!price) continue;
      c.entryPrice = price;
      if (mc != null && !c.entryMc) c.entryMc = mc;
      await c.save();
      console.log("ok", ca);
    } catch (e) {
      console.log("skip", ca, e.message);
    }
  }
  console.log("done");
  process.exit(0);
})();
