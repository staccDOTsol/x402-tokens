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
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { TransactionInstruction } from "@solana/web3.js";
import {
  WRAP_NAV_PROGRAM,
  WRAP_STEP_NOTE,
} from "./wrapspec.js";

export type AcceptRow = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  extra?: { feePayer?: string; decimals?: number; facilitator?: string; symbol?: string };
};

/** A caller-facing failure (bad input, not enough funds) rather than a bug. */
export class PayBuildError extends Error {
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
    readonly code: string = "insufficient_underlying",
  ) {
    super(message);
    this.name = "PayBuildError";
  }
}

const DEFAULT_FACILITATOR = "https://x402.accrue.fund";
const MINIMUM_LIQUIDITY = 1000n;

const mintCache = new Map<string, { programId: PublicKey; decimals: number; mintAuthority: PublicKey | null }>();

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
  const out = { programId, decimals: parsed.decimals, mintAuthority: parsed.mintAuthority };
  mintCache.set(mintStr, out);
  return out;
}

export type WrapPool = {
  programId: PublicKey; wrapped: PublicKey; wrappedProgram: PublicKey;
  underlying: PublicKey; underlyingProgram: PublicKey; underlyingDecimals: number;
  underlyingSymbol: string; escrow: PublicKey; authority: PublicKey; bump: number;
};

/**
 * Underlying deposit needed so floor(deposit * supply / reserves) covers
 * `sharesNeeded`. Ported verbatim from openzoo-shim lib/wrap.js — the margin
 * absorbs NAV drift between this read and the landing slot (donations and
 * burns only ever move shares-per-asset DOWN, so rounding short means the
 * wrap mints less than the payment needs and the whole tx fails).
 */
function depositForShares(sharesNeeded: bigint, reserves: bigint, supply: bigint): bigint {
  if (supply === 0n || reserves === 0n) return sharesNeeded + MINIMUM_LIQUIDITY;
  const exact = (sharesNeeded * reserves + supply - 1n) / supply;   // ceil
  return exact + exact / 200n + 2n;                                 // +0.5% + 2 raw
}

/**
 * ATA-ensure + 9-account Wrap. Matches desktop openzoo lib/wrap.js after the
 * 2026-08-18 rewrite of FrSERTNCP…: the program CPIs the deposit, so there is
 * no separate TransferChecked. A 5-account Wrap dies 0x6a at need(accounts, 9)?.
 *
 * Ignore any facilitator /supported acquire.steps that still list
 * TransferChecked-then-Wrap — that directory is stale. Account 4 (wrapped
 * token program) vs 8 (unwrapped token program) are not interchangeable.
 *
 * `rentPayer` is the 402's feePayer, not the user — which is why a user needs
 * the token but no SOL.
 */
export function buildWrapInstructions(
  pool: WrapPool, owner: PublicKey, rentPayer: PublicKey, depositRaw: bigint,
): TransactionInstruction[] {
  const userWrapped = getAssociatedTokenAddressSync(pool.wrapped, owner, false, pool.wrappedProgram);
  const userUnderlying = getAssociatedTokenAddressSync(pool.underlying, owner, false, pool.underlyingProgram);
  const data = Buffer.alloc(10);
  data[0] = 1;                                   // tag 1 = Wrap
  data.writeBigUInt64LE(depositRaw, 1);
  data[9] = pool.bump;
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      rentPayer, userWrapped, owner, pool.wrapped, pool.wrappedProgram,
    ),
    new TransactionInstruction({
      programId: pool.programId,
      keys: [
        { pubkey: pool.escrow, isSigner: false, isWritable: true },
        { pubkey: pool.wrapped, isSigner: false, isWritable: true },
        { pubkey: userWrapped, isSigner: false, isWritable: true },
        { pubkey: pool.authority, isSigner: false, isWritable: false },
        { pubkey: pool.wrappedProgram, isSigner: false, isWritable: false },
        { pubkey: userUnderlying, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
        { pubkey: pool.underlying, isSigner: false, isWritable: false },
        { pubkey: pool.underlyingProgram, isSigner: false, isWritable: false },
      ],
      data,
    }),
  ];
}

let acquireCache: { at: number; kinds: Record<string, unknown>[] } | null = null;

async function acquireDirectory(facilitator: string): Promise<Record<string, unknown>[]> {
  if (acquireCache && Date.now() - acquireCache.at < 300_000) return acquireCache.kinds;
  const res = await fetch(`${facilitator}/supported`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`facilitator /supported -> ${res.status}`);
  const body = await res.json() as { kinds?: Record<string, unknown>[] };
  const kinds = body.kinds ?? [];
  acquireCache = { at: Date.now(), kinds };
  return kinds;
}

/**
 * Decide whether this payer needs a conversion, and for how much.
 *
 * WHY THIS EXISTS AT ALL: the Solana rails settle in NAV-wrapped twins
 * (yUSDCx / wTOKENx / wLEOSx) but users only ever hold the plain underlying.
 * Without this, the built transaction was ComputeBudget + a transfer of a
 * token the payer has none of, so every browser top-up died at simulation no
 * matter how much USDC the wallet held. MEASURED against production.
 *
 * Returns null when no wrap is needed — the payer already holds enough of the
 * twin, or the asset has no acquire path (EVM rows, or an unwrapped mint).
 */
async function planWrap(
  conn: Connection, facilitator: string, accept: AcceptRow,
  wrappedProgram: PublicKey, wrappedMintAuthority: PublicKey | null,
  payer: PublicKey, amount: bigint,
): Promise<{ pool: WrapPool; depositRaw: bigint; shortfall: bigint; heldWrapped: bigint; reserves: bigint; supply: bigint } | null> {
  // How much of the twin the payer already has. A wrap is an extra fee and an
  // extra failure mode; skip it when it buys nothing.
  const twinAta = getAssociatedTokenAddressSync(
    new PublicKey(accept.asset), payer, false, wrappedProgram);
  const held = await conn.getTokenAccountBalance(twinAta)
    .then((r) => BigInt(r.value.amount)).catch(() => 0n);
  if (held >= amount) return null;
  const shortfall = amount - held;

  let kinds: Record<string, unknown>[];
  try { kinds = await acquireDirectory(facilitator); }
  catch { return null; }   // directory down: build the plain transfer, as before

  const row = kinds.find((k) => {
    const x = (k as { extra?: { asset?: string } }).extra;
    return x?.asset === accept.asset;
  }) as { extra?: Record<string, any> } | undefined;
  const acq = row?.extra?.acquire;
  if (!acq || acq.method !== "spl-token-wrap") return null;
  // Directory steps are hints for humans. Some /supported rows still list
  // TransferChecked-then-Wrap (pre-exploit). Never honor that shape — the
  // deployed program is 9-account and CPIs the deposit. This builder always
  // emits ATA + 9-account Wrap regardless of acq.steps.

  const programId = new PublicKey(acq.program);
  const wrapped = new PublicKey(accept.asset);

  // The bump is OPTIONAL in the directory — yUSDCx publishes none. Derive it,
  // then ASSERT the derived authority equals the published one: a mismatched
  // authority builds a transaction that can only fail, and failing here with a
  // clear reason beats failing on chain with a truncated log.
  let authority: PublicKey;
  let bump: number;
  if (typeof acq.authorityBump === "number") {
    authority = new PublicKey(acq.mintAuthority);
    bump = acq.authorityBump;
  } else {
    const [pda, derived] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), wrapped.toBuffer()], programId);
    if (acq.mintAuthority && pda.toBase58() !== String(acq.mintAuthority)) {
      throw new PayBuildError("wrap authority mismatch", {
        derived: pda.toBase58(), published: String(acq.mintAuthority),
      }, "wrap_authority_mismatch");
    }
    authority = pda;
    bump = derived;
  }
  // Belt and braces: the mint's OWN authority must be the one we are about to
  // name, or the Wrap instruction cannot mint.
  if (wrappedMintAuthority && !wrappedMintAuthority.equals(authority)) {
    throw new PayBuildError("wrap authority is not the mint authority", {
      mintAuthority: wrappedMintAuthority.toBase58(), wrapAuthority: authority.toBase58(),
    }, "wrap_authority_mismatch");
  }

  const escrow = new PublicKey(acq.escrow);
  const underlying = new PublicKey(acq.underlying.address);
  const underlyingProgram = new PublicKey(acq.underlying.tokenProgram);
  // Decimals come from the DIRECTORY, never assumed: wLEOSx is nine, not six,
  // because a twin takes its underlying's decimals. Guessing 6 mis-scales
  // every transfer_checked on that rail.
  const underlyingDecimals = Number(acq.underlying.decimals);

  const [reserves, supply] = await Promise.all([
    conn.getTokenAccountBalance(escrow).then((r) => BigInt(r.value.amount)).catch(() => 0n),
    conn.getTokenSupply(wrapped).then((r) => BigInt(r.value.amount)),
  ]);
  const depositRaw = depositForShares(shortfall, reserves, supply);

  // PRE-FLIGHT. With no underlying the 9-account Wrap's CPI deposit fails
  // (often as InvalidAccountData in a truncated log, which used to read like
  // "MintTo failed"). Say the actual problem instead.
  const userUnderlying = getAssociatedTokenAddressSync(
    underlying, payer, false, underlyingProgram);
  const have = await conn.getTokenAccountBalance(userUnderlying)
    .then((r) => BigInt(r.value.amount)).catch(() => 0n);
  if (have < depositRaw) {
    const need = Number(depositRaw) / 10 ** underlyingDecimals;
    const has = Number(have) / 10 ** underlyingDecimals;
    throw new PayBuildError(
      `not enough ${acq.underlying.symbol}: need ${need.toFixed(underlyingDecimals)}, wallet holds ${has.toFixed(underlyingDecimals)}`,
      { underlying: underlying.toBase58(), symbol: acq.underlying.symbol,
        neededRaw: depositRaw.toString(), heldRaw: have.toString(), decimals: underlyingDecimals },
    );
  }

  return {
    pool: {
      programId, wrapped, wrappedProgram, underlying, underlyingProgram,
      underlyingDecimals, underlyingSymbol: String(acq.underlying.symbol ?? ""),
      escrow, authority, bump,
    },
    depositRaw,
    shortfall,
    heldWrapped: held,
    reserves,
    supply,
  };
}

export async function buildUnsignedPayment(
  rpcUrl: string,
  accept: AcceptRow,
  payerBase58: string,
  facilitatorUrl?: string,
): Promise<{ transaction: string; envelope: Record<string, unknown>; wrap?: Record<string, unknown> }> {
  if (!accept?.asset || !accept?.payTo || !accept?.maxAmountRequired) {
    throw new Error("accept row must carry asset, payTo and maxAmountRequired");
  }
  const feePayerStr = accept.extra?.feePayer;
  if (!feePayerStr) throw new Error("accept row is missing extra.feePayer");

  const payer = new PublicKey(payerBase58);           // throws on a bad key
  const conn = new Connection(rpcUrl, "confirmed");
  const { programId, decimals, mintAuthority } = await mintInfo(conn, accept.asset);

  const mint = new PublicKey(accept.asset);
  const payTo = new PublicKey(accept.payTo);
  const feePayer = new PublicKey(feePayerStr);
  const amount = BigInt(accept.maxAmountRequired);

  // allowOwnerOffCurve=true on the destination: payTo is frequently a PDA.
  const source = getAssociatedTokenAddressSync(mint, payer, false, programId);
  const dest = getAssociatedTokenAddressSync(mint, payTo, true, programId);

  const facilitator = (facilitatorUrl ?? accept.extra?.facilitator ?? DEFAULT_FACILITATOR).replace(/\/$/, "");
  const plan = await planWrap(conn, facilitator, accept, programId, mintAuthority, payer, amount);

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
  // Acquire before spending: ATA + 9-account Wrap (program CPIs the deposit)
  // — then the payment TransferChecked of the wrapped mint.
  if (plan) {
    for (const ix of buildWrapInstructions(plan.pool, payer, feePayer, plan.depositRaw)) tx.add(ix);
  }
  tx.add(createTransferCheckedInstruction(
    source, mint, dest, payer, amount, decimals, [], programId,
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
    // What the extra instructions are doing, so a client can show the user
    // "converting 0.05 USDC" instead of an unexplained third signature prompt.
    ...(plan
      ? {
        wrap: {
          method: "spl-token-wrap",
          program: plan.pool.programId.toBase58() || WRAP_NAV_PROGRAM,
          accounts: 9,
          instruction: "Wrap",
          note: WRAP_STEP_NOTE,
          underlying: plan.pool.underlying.toBase58(),
          underlyingSymbol: plan.pool.underlyingSymbol,
          underlyingDecimals: plan.pool.underlyingDecimals,
          underlyingTokenProgram: plan.pool.underlyingProgram.toBase58(),
          escrow: plan.pool.escrow.toBase58(),
          authority: plan.pool.authority.toBase58(),
          authorityBump: plan.pool.bump,
          depositRaw: plan.depositRaw.toString(),
          sharesNeededRaw: plan.shortfall.toString(),
          alreadyHeldRaw: plan.heldWrapped.toString(),
          navReserves: plan.reserves.toString(),
          navSupply: plan.supply.toString(),
        },
      }
      : {}),
  };
}
