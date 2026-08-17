/**
 * Build an UNSIGNED x402 payment transaction on the server.
 *
 * Why this exists: a browser or a phone can hold a wallet but cannot
 * reasonably build a Solana transaction. The 402 challenge carries the amount,
 * decimals, asset, payTo and feePayer — but NOT the recent blockhash, NOT the
 * token program id, and NOT the derived associated token accounts. Getting
 * those on-device means bundling @solana/web3.js + @solana/spl-token into a
 * webview and putting consensus-critical construction on the least testable
 * surface we own.
 *
 * So the gateway builds it and the client only signs. The payer's key never
 * comes near this process: we return an unsigned transaction, the wallet
 * partial-signs it (Mobile Wallet Adapter, Phantom, an in-page burner —
 * whatever the client has), and the facilitator completes it as feePayer.
 *
 * Mirrors openzoo-shim `lib/x402.js` buildPayment() exactly, including the
 * compute-budget nonce — see the comment on it below, it is load-bearing.
 */
import { Connection, ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackMint } from "@solana/spl-token";

export type AcceptRow = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  extra?: { feePayer?: string; decimals?: number };
};

const mintCache = new Map<string, { programId: PublicKey; decimals: number }>();

async function mintInfo(conn: Connection, mintStr: string) {
  const hit = mintCache.get(mintStr);
  if (hit) return hit;
  const mint = new PublicKey(mintStr);
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mintStr} not found on chain`);
  // The OWNER of the mint account is the token program — classic SPL or
  // Token-2022. Assuming either one breaks ATA derivation for the other, and
  // our Solana rails settle in Token-2022 twins.
  const programId = info.owner;
  const parsed = unpackMint(mint, info, programId);
  const out = { programId, decimals: parsed.decimals };
  mintCache.set(mintStr, out);
  return out;
}

export async function buildUnsignedPayment(
  rpcUrl: string,
  accept: AcceptRow,
  payerBase58: string,
): Promise<{ transaction: string; envelope: Record<string, unknown> }> {
  if (!accept?.asset || !accept?.payTo || !accept?.maxAmountRequired) {
    throw new Error("accept row must carry asset, payTo and maxAmountRequired");
  }
  const feePayerStr = accept.extra?.feePayer;
  if (!feePayerStr) throw new Error("accept row is missing extra.feePayer");

  const payer = new PublicKey(payerBase58);           // throws on a bad key
  const conn = new Connection(rpcUrl, "confirmed");
  const { programId, decimals } = await mintInfo(conn, accept.asset);

  const mint = new PublicKey(accept.asset);
  const payTo = new PublicKey(accept.payTo);
  const feePayer = new PublicKey(feePayerStr);

  // allowOwnerOffCurve=true on the destination: payTo is frequently a PDA.
  const source = getAssociatedTokenAddressSync(mint, payer, false, programId);
  const dest = getAssociatedTokenAddressSync(mint, payTo, true, programId);

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash });

  // UNIQUENESS, and it is load-bearing. Everything else here is a pure
  // function of (amount, accounts, decimals, blockhash), so two callers
  // quoting the same price inside one blockhash window build a BYTE-IDENTICAL
  // transaction — identical signature, so the second is a duplicate and the
  // facilitator rejects it as "Simulation failed ... Logs: []". MEASURED on
  // the desktop client: 8 failed_settle in a single window under 10 concurrent
  // workers, each costing a full retry.
  //
  // A random compute-unit LIMIT makes each message distinct at zero cost:
  // unlike setComputeUnitPrice it adds no priority fee, and over-estimating is
  // free because the limit only caps execution.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({
    units: 300_000 + Math.floor(Math.random() * 200_000),
  }));
  tx.add(createTransferCheckedInstruction(
    source, mint, dest, payer, BigInt(accept.maxAmountRequired), decimals, [], programId,
  ));

  // Unsigned on purpose: requireAllSignatures false leaves BOTH the payer and
  // the feePayer slots empty. The client fills the payer slot; the facilitator
  // fills its own.
  const transaction = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");

  return {
    transaction,
    // Ready to base64 and send as X-PAYMENT once `payload.transaction` is
    // replaced with the SIGNED tx — so a client never has to guess the shape.
    envelope: {
      x402Version: 1,
      scheme: accept.scheme ?? "exact",
      network: accept.network,
      payload: { transaction: "<replace with the signed transaction>" },
    },
  };
}
