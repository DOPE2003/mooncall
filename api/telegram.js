// api/telegram.js
const { bot, ensureDb } = require("../mooncall");

// Fast-ACK webhook that processes the update after responding.
// This avoids Vercel timeouts/cold-start lag.
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, hint: "POST updates here" });
    }

    // Reply immediately so Telegram stops waiting.
    res.status(200).json({ ok: true });

    // Do the real work after the ACK:
    const update = req.body;
    // make sure DB is available (no-op if already connected)
    await ensureDb();

    // handle the update without blocking the response
    setImmediate(() => {
      bot.handleUpdate(update).catch((e) => console.error("handleUpdate:", e));
    });
  } catch (e) {
    // If anything blew up before we replied:
    try { res.status(200).json({ ok: true }); } catch (_) {}
    console.error("telegram endpoint:", e);
  }
};
