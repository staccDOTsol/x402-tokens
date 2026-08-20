/**
 * /v1/pay/build wrap ixs must be the post-exploit 9-account Wrap.
 * A 5-account Wrap + TransferChecked deposit dies 0x6a on the rewritten program.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { buildWrapInstructions, type WrapPool } from "./paybuild.js";
import { WRAP_NAV_PROGRAM } from "./wrapspec.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

const owner = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");
const rentPayer = owner;
const wrapped = new PublicKey("6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv");
const underlying = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const escrow = new PublicKey("2qLm8aCvn6gQVUFeQ7EC5J62Y95gFzc3vReHzD5d5Gj2");
const authority = new PublicKey("EBGYMEEEPKu7szPUbnbp2h63azY9Sj9GR4MA2Ms6Quoi");

const pool: WrapPool = {
  programId: new PublicKey(WRAP_NAV_PROGRAM),
  wrapped,
  wrappedProgram: TOKEN_2022_PROGRAM_ID,
  underlying,
  underlyingProgram: TOKEN_PROGRAM_ID,
  underlyingDecimals: 6,
  underlyingSymbol: "USDC",
  escrow,
  authority,
  bump: 255,
};

const ixs = buildWrapInstructions(pool, owner, rentPayer, 1000n);
ok(ixs.length === 2, "ATA + Wrap, no separate TransferChecked");
ok(ixs[1].programId.equals(pool.programId), "second ix is wrap-nav");
ok(ixs[1].keys.length === 9, "Wrap has 9 accounts");
ok(ixs[1].data[0] === 1, "tag 1 = Wrap");
ok(ixs[1].data.readBigUInt64LE(1) === 1000n, "amount u64 LE");
ok(ixs[1].data[9] === 255, "bump trails the amount");
ok(ixs[1].data.length === 10, "data is 10 bytes");

const userWrapped = getAssociatedTokenAddressSync(wrapped, owner, false, TOKEN_2022_PROGRAM_ID);
const userUnderlying = getAssociatedTokenAddressSync(underlying, owner, false, TOKEN_PROGRAM_ID);
ok(ixs[1].keys[0].pubkey.equals(escrow) && ixs[1].keys[0].isWritable, "0 escrow writable");
ok(ixs[1].keys[1].pubkey.equals(wrapped) && ixs[1].keys[1].isWritable, "1 wrapped mint writable");
ok(ixs[1].keys[2].pubkey.equals(userWrapped) && ixs[1].keys[2].isWritable, "2 recipient ATA writable");
ok(ixs[1].keys[3].pubkey.equals(authority) && !ixs[1].keys[3].isWritable, "3 authority PDA");
ok(ixs[1].keys[4].pubkey.equals(TOKEN_2022_PROGRAM_ID), "4 wrapped token program");
ok(ixs[1].keys[5].pubkey.equals(userUnderlying) && ixs[1].keys[5].isWritable, "5 depositor underlying writable");
ok(ixs[1].keys[6].pubkey.equals(owner) && ixs[1].keys[6].isSigner, "6 depositor signer");
ok(ixs[1].keys[7].pubkey.equals(underlying), "7 unwrapped mint");
ok(ixs[1].keys[8].pubkey.equals(TOKEN_PROGRAM_ID), "8 unwrapped token program");
ok(!ixs[1].keys[4].pubkey.equals(ixs[1].keys[8].pubkey), "account 4 vs 8 not interchangeable");

const TOKEN_PROGRAM_IDS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
ok(!ixs.some((ix) => TOKEN_PROGRAM_IDS.has(ix.programId.toBase58())), "no standalone token-program TransferChecked");

console.log("paybuild wrap ok");
