/**
 * Wrap USDC into yUSDCx on mainnet. First wrap locks 1000 raw as min liquidity.
 *
 *   YUSDCX_AMOUNT=100000 node scripts/wrap-yusdcx.mjs   # 0.1 USDC
 *
 * Post-exploit 9-account Wrap: the program CPIs the deposit. Do not send a
 * separate TransferChecked. Account 4 is Token-2022 (wrapped mint owner);
 * account 8 is Tokenkeg (USDC / escrow owner). They are not interchangeable.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount, getMint,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";

const PROGRAM = new PublicKey("FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const Y = new PublicKey("6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv");
const ESCROW = new PublicKey("2qLm8aCvn6gQVUFeQ7EC5J62Y95gFzc3vReHzD5d5Gj2");
const AMOUNT = BigInt(process.env.YUSDCX_AMOUNT ?? "100000"); // 0.1

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/jjj.json", "utf8")))
);
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const [authority, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority"), Y.toBuffer()], PROGRAM
);
const userUsdc = getAssociatedTokenAddressSync(USDC, payer.publicKey, false, TOKEN_PROGRAM_ID);
const userY = getAssociatedTokenAddressSync(Y, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

const ixWrap = (amount, bump) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: ESCROW, isSigner: false, isWritable: true },
    { pubkey: Y, isSigner: false, isWritable: true },
    { pubkey: userY, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: userUsdc, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: USDC, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([Buffer.from([1]), u64le(amount), Buffer.from([bump])]),
});
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

const usdc = await getAccount(conn, userUsdc, "confirmed", TOKEN_PROGRAM_ID);
console.log(`payer  ${payer.publicKey.toBase58()}`);
console.log(`USDC   ${Number(usdc.amount) / 1e6}`);
console.log(`wrap   ${Number(AMOUNT) / 1e6}  bump ${bump}`);
if (usdc.amount < AMOUNT) {
  console.error("not enough USDC");
  process.exit(1);
}

const tx = new Transaction();
try {
  await getAccount(conn, userY, "confirmed", TOKEN_2022_PROGRAM_ID);
} catch {
  tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, userY, payer.publicKey, Y, TOKEN_2022_PROGRAM_ID));
}
tx.add(ixWrap(AMOUNT, bump));
const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
const y = await getAccount(conn, userY, "confirmed", TOKEN_2022_PROGRAM_ID);
const supply = await getMint(conn, Y, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log(`sig    ${sig}`);
console.log(`yUSDCx ${Number(y.amount) / 1e6}  supply ${Number(supply.supply) / 1e6}`);
