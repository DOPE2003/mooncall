// api/call.js (Node runtime)
const axios = require("axios");

// Use your existing modules; these were already in your repo
const dbConnect = require("../lib/db");
const callModel = require("../model/call.model");
const { getPrice } = require("../price");
const { buildCallCard } = require("../card");

const SOL_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BSC_HEX40 = /^0x[a-fA-F0-9]{40}$/;

function parseAdmins() {
  return (process.env.ADMIN_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
function milestones() {
  return (process.env.MILESTONES || "2,4,6,10")
    .split(",").map(n => parseFloat(n.trim()))
    .filter(Number.isFinite).sort((a,b)=>a-b);
}
async function postToChannel(text, keyboard, photoUrl) {
  const chat = process.env.ALERTS_CHANNEL_ID;
  if (!chat) throw new Error("ALERTS_CHANNEL_ID missing");
  const urlBase = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
  if (photoUrl) {
    await axios.post(`${urlBase}/sendPhoto`, {
      chat_id: chat,
      photo: photoUrl,
      caption: text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard?.reply_markup || undefined,
    }, { timeout: 10000 });
  } else {
    await axios.post(`${urlBase}/sendMessage`, {
      chat_id: chat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard?.reply_markup || undefined,
    }, { timeout: 10000 });
  }
}

module.exports = async (req, res) => {
  try {
    // Protect this endpoint
    if ((process.env.INTERNAL_API_SECRET || "") !== (req.headers["x-internal"] || "")) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { tgId, username, address } = req.body || {};
    if (!tgId || !address) return res.status(400).json({ ok: false, error: "bad payload" });

    let chain = null;
    if (SOL_BASE58.test(address)) chain = "sol";
    else if (BSC_HEX40.test(address)) chain = "bsc";
    else return res.status(400).json({ ok: false, error: "invalid address" });

    await dbConnect();

    // 24h soft limit unless admin
    const isAdmin = parseAdmins().includes(String(tgId));
    if (!isAdmin) {
      const cut = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await callModel.findOne({ telegramId: String(tgId), createdAt: { $gt: cut } });
      if (recent) return res.status(200).json({ ok: false, error: "You already made a call in the last 24h." });
    }

    // price + card
    const handle = username ? `@${username}` : null;
    const [price, card] = await Promise.all([
      getPrice(chain, address).catch(() => null),
      buildCallCard({ chain, addr: address, handle }),
    ]);

    const entryPrice = price ?? 0;
    const entryMc = card?.meta?.marketCap ?? null;

    // store
    const ladder = milestones();
    const FIRST_MS = ladder.find(m => m > 1) ?? 2;
    const CHECK_MIN = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
    const BASE_DAYS = Number(process.env.BASE_TRACK_DAYS || 7);

    const now = Date.now();
    await callModel.create({
      telegramId: String(tgId),
      userId: String(tgId),
      callerHandle: handle || null,
      chain,
      mintAddress: address,
      thesis: "",
      entryPrice: entryPrice,
      lastPrice: entryPrice || null,
      peakPrice: entryPrice || null,
      entryMc: entryMc,
      nextMilestone: FIRST_MS,
      status: "active",
      nextCheckAt: new Date(now + CHECK_MIN * 60_000),
      expiresAt: new Date(now + BASE_DAYS * 86_400_000),
    });

    // post to channel
    try {
      await postToChannel(card.text, card.keyboard, card.photoUrl);
    } catch (e) {
      console.error("Channel post failed:", e.message);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("api/call error:", e);
    return res.status(200).json({ ok: false, error: e.message || "internal error" });
  }
};
