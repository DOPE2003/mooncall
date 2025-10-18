// api/telegram.local.js
require("dotenv").config();
const { bot } = require("../mooncall");

(async () => {
  const me = await bot.telegram.getMe().catch(()=>null);
  console.log("Local dev polling as:", me?.username || "unknown");
  bot.launch();
})();
