// lib/solana.js
// Lightweight SPL Mint inspection for Freeze/Mint authority (Solana)

const { Connection, PublicKey } = require('@solana/web3.js');
const { unpackMint } = require('@solana/spl-token');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?$/;
const stripPump = (m) => String(m || '').replace(/pump$/i, '');

async function getMintSafety(mintRaw) {
  try {
    const mintStr = stripPump(mintRaw);
    if (!SOL_RE.test(mintStr)) return { freezeAuthorityRenounced: undefined, mintAuthorityRenounced: undefined };
    const pk = new PublicKey(mintStr);
    const info = await conn.getAccountInfo(pk);
    if (!info) return { freezeAuthorityRenounced: undefined, mintAuthorityRenounced: undefined };

    const mint = unpackMint(pk, info);
    // Renounced = NULL on-chain
    const mintAuthNone = !mint.mintAuthority || mint.mintAuthority.equals(PublicKey.default);
    const freezeAuthNone = !mint.freezeAuthority || mint.freezeAuthority.equals(PublicKey.default);

    return {
      freezeAuthorityRenounced: freezeAuthNone,
      mintAuthorityRenounced: mintAuthNone,
    };
  } catch (e) {
    // On any RPC/layout error, keep fields unknown
    return { freezeAuthorityRenounced: undefined, mintAuthorityRenounced: undefined };
  }
}

module.exports = { getMintSafety, stripPump };
