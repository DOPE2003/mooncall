// Minimal Telegram webhook handler for Vercel (Node serverless)
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing');

let bot;
function getBot() {
  if (!bot) {
    bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 9_000 }); // keep quick
    // --- BASIC HANDLERS (keep light) ---
    bot.start(ctx => ctx.reply('Mooncall is online ✅'));
    bot.hears(/.*/, ctx => ctx.reply('Use the /call command in the main bot.'));

    // IMPORTANT: do not do heavy work here; cron will do PnL checks
  }
  return bot;
}

// Export Vercel serverless function
module.exports = async (req, res) => {
  // Telegram sends POST with JSON
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, hint: 'POST updates here' });
  }

  try {
    const b = getBot();
    // Let telegraf handle the update and reply immediately
    await b.handleUpdate(req.body);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook error:', e);
    // Always return 200 to satisfy Telegram (avoid repeated retries)
    return res.status(200).json({ ok: true, note: 'handled with error' });
  }
};
