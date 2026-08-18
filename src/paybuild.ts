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
 *
 * AND it acquires the asset it is about to spend. The Solana rails settle in
 * NAV-wrapped Token-2022 twins (yUSDCx / wTOKENx / wLEOSx); a human wallet only
 * ever holds the plain underlying (USDC / TOKEN / LEOS). A payment transfer of
 * the twin from a wallet that holds none has no source balance and dies at
 * simulation no matter how funded the payer is. So when the quoted mint is a
 * wrap-nav twin we prepend the conversion for exactly the shortfall — driven
 * off the facilitator's own published `extra.acquire` recipe, never off a
 * hardcoded table, so a newly listed rail works with zero code changes here.
 */
import {
  Connection, ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";

export type AcceptRow = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  extra?: { feePayer?: string; decimals?: number; facilitator?: string };
};

/**
 * A build failure the CALLER can fix — not enough underlying, an asset whose
 * acquire recipe we cannot read. Carries a machine-readable code plus the
 * numbers, so a client can render "you need 0.42 USDC" without regex on prose.
 */
export class PayBuildError extends Error {
  code: string;
  detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "PayBuildError";
    this.code = code;
    this.detail = detail;
  }
}

/** The wrap-nav program behind every twin the rails quote today. */
const WRAP_PROGRAM_ID = new PublicKey("FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE");
const AUTHORITY_SEED = Buffer.from("mint_authority");
/** Locked forever on the first wrap of a pool; see the program's genesis path. */
const MINIMUM_LIQUIDITY = 1000n;
const DEFAULT_FACILITATOR = "https://x402.accrue.fund";

const mintCache = new Map<string, { programId: PublicKey; decimals: number; mintAuthority: string | null }>();

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
  const out = { programId, decimals: parsed.decimals, mintAuthority: parsed.mintAuthority?.toBase58() ?? null };
  mintCache.set(mintStr, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * The acquire directory: how a payer gets the asset the 402 quotes.
 * ------------------------------------------------------------------ */

type AcquireBlock = {
  method?: string;
  program?: string;
  underlying?: { address?: string; symbol?: string; decimals?: number; tokenProgram?: string };
  escrow?: string;
  mintAuthority?: string;
  authorityBump?: number;
};

type SupportedRow = { network?: string; extra?: { asset?: string; symbol?: string; acquire?: AcquireBlock } };

const directoryCache = new Map<string, { at: number; kinds: SupportedRow[] }>();
const DIRECTORY_TTL_MS = 300_000;

/**
 * `GET <facilitator>/supported`, cached. This is the whole point: escrows,
 * mint authorities, bumps, underlying token programs and underlying decimals
 * all live there, published by the same service that settles the payment.
 * Hardcoding any of them is how this breaks the next time a rail is added.
 */
async function supportedKinds(facilitator: string): Promise<SupportedRow[] | null> {
  const hit = directoryCache.get(facilitator);
  if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.kinds;
  try {
    const r = await fetch(`${facilitator}/supported`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json() as { kinds?: SupportedRow[] };
    if (!Array.isArray(body?.kinds)) throw new Error("no kinds[]");
    directoryCache.set(facilitator, { at: Date.now(), kinds: body.kinds });
    return body.kinds;
  } catch {
    return hit?.kinds ?? null;   // a stale recipe beats no recipe
  }
}

/** The spl-token-wrap recipe for `asset`, or null when it needs no acquiring. */
async function acquireFor(facilitator: string, asset: string): Promise<AcquireBlock | null> {
  const kinds = await supportedKinds(facilitator);
  if (!kinds) return null;
  const row = kinds.find(
    (k) => String(k?.network ?? "").startsWith("solana:") && k?.extra?.asset === asset,
  );
  const acq = row?.extra?.acquire;
  if (!acq || acq.method !== "spl-token-wrap") return null;
  if (!acq.underlying?.address || !acq.escrow || !acq.mintAuthority) return null;
  return acq;
}

type Pool = {
  wrapped: PublicKey;
  wrappedProgram: PublicKey;
  programId: PublicKey;
  authority: PublicKey;
  bump: number;
  escrow: PublicKey;
  underlying: PublicKey;
  underlyingProgram: PublicKey;
  underlyingDecimals: number;
  underlyingSymbol: string;
};

/**
 * Turn a published recipe into a pool we are willing to sign against.
 *
 * The bump is DERIVED, not trusted: yUSDCx publishes no `authorityBump` at all
 * (its canonical bump is 253, not the 255 the other rails happen to have), and
 * a wrong bump makes the program reject the mint with a signer-seeds mismatch.
 * We then assert the derived authority equals BOTH the published mintAuthority
 * and the twin's real on-chain mint authority — three-way agreement or we
 * refuse to build, because the failure mode of getting this wrong is a
 * plausible-looking transaction that burns the user's time at simulation.
 */
async function resolvePool(
  conn: Connection,
  asset: string,
  acq: AcquireBlock,
  wrappedProgram: PublicKey,
  onchainMintAuthority: string | null,
): Promise<Pool> {
  const wrapped = new PublicKey(asset);
  const programId = new PublicKey(acq.program ?? WRAP_PROGRAM_ID);
  const published = new PublicKey(acq.mintAuthority!);
  const [derived, derivedBump] = PublicKey.findProgramAddressSync(
    [AUTHORITY_SEED, wrapped.toBuffer()], programId,
  );
  if (!derived.equals(published)) {
    throw new PayBuildError(
      "acquire_authority_mismatch",
      `refusing to build: PDA('mint_authority', ${asset}) derives ${derived.toBase58()} but ${acq.mintAuthority} is published as the mint authority`,
      { derived: derived.toBase58(), published: acq.mintAuthority, program: programId.toBase58() },
    );
  }
  if (onchainMintAuthority && onchainMintAuthority !== derived.toBase58()) {
    throw new PayBuildError(
      "acquire_authority_mismatch",
      `refusing to build: ${asset} is minted by ${onchainMintAuthority}, not by the wrap authority ${derived.toBase58()}`,
      { onchain: onchainMintAuthority, derived: derived.toBase58() },
    );
  }
  if (acq.authorityBump != null && acq.authorityBump !== derivedBump) {
    throw new PayBuildError(
      "acquire_bump_mismatch",
      `refusing to build: published authorityBump ${acq.authorityBump} disagrees with the derived canonical bump ${derivedBump}`,
      { published: acq.authorityBump, derived: derivedBump },
    );
  }

  const underlying = new PublicKey(acq.underlying!.address!);
  // Underlying decimals and token program come from the directory but are
  // CONFIRMED against the mint account: transfer_checked rejects a mismatched
  // decimals, and legacy-SPL vs Token-2022 is a per-rail split (USDC and LEOS
  // are Tokenkeg, TOKEN is Token-2022) that silently breaks ATA derivation.
  const u = await mintInfo(conn, underlying.toBase58());
  const declaredProgram = acq.underlying!.tokenProgram;
  if (declaredProgram && declaredProgram !== u.programId.toBase58()) {
    throw new PayBuildError(
      "acquire_program_mismatch",
      `refusing to build: ${acq.underlying!.symbol ?? underlying.toBase58()} is owned by ${u.programId.toBase58()}, not the published ${declaredProgram}`,
      { onchain: u.programId.toBase58(), published: declaredProgram },
    );
  }

  return {
    wrapped,
    wrappedProgram,
    programId,
    authority: derived,
    bump: derivedBump,
    escrow: new PublicKey(acq.escrow!),
    underlying,
    underlyingProgram: u.programId,
    underlyingDecimals: u.decimals,
    underlyingSymbol: acq.underlying!.symbol ?? underlying.toBase58().slice(0, 4),
  };
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

/** Raw balance of a token account, 0 when it does not exist yet. */
async function tokenBalance(conn: Connection, account: PublicKey): Promise<bigint> {
  try {
    const r = await conn.getTokenAccountBalance(account);
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Underlying deposit such that floor(deposit * supply / reserves) covers
 * `sharesNeeded`. Ported from openzoo-shim lib/wrap.js: NAV can only move
 * against the depositor between the read and the landing slot, so a small
 * margin is what keeps a payment from being one raw unit short.
 */
export function depositForShares(sharesNeeded: bigint, reserves: bigint, supply: bigint): bigint {
  if (supply === 0n || reserves === 0n) return sharesNeeded + MINIMUM_LIQUIDITY;
  const exact = (sharesNeeded * reserves + supply - 1n) / supply;   // ceil
  return exact + exact / 200n + 2n;                                 // +0.5% + 2 raw units
}

/**
 * The conversion, in the mainnet-proven order used by openzoo-shim
 * lib/wrap.js and by the browser client's `wrapInstructions`:
 *
 *   [0] create the payer's wrapped ATA (idempotent — no-op when it exists)
 *   [1] Wrap                 — mints shares
 *   [2] TransferChecked      — moves the underlying into escrow
 *
 * This is deliberately the REVERSE of the order the `steps` array lists, and
 * the steps' own note says why: the program "prices the deposit off the escrow
 * balance BEFORE it lands". Shares are floor(amount * supply / reserves) with
 * `reserves` read at ix execution, so the escrow must still hold PRE-deposit
 * reserves when the wrap runs. Put the transfer first and the deposit is
 * counted twice — the payer is short-changed on shares and the payment
 * transfer can come up under-funded. `steps` describes the economic sequence;
 * the instruction sequence is this one. Both reference clients ship it and it
 * is what mainnet simulation accepts.
 *
 * `rentPayer` funds the ATA — the 402's feePayer, which is why a payer needs
 * the token and not SOL.
 */
function buildWrapInstructions(
  pool: Pool, owner: PublicKey, rentPayer: PublicKey, depositRaw: bigint,
): TransactionInstruction[] {
  const userWrapped = getAssociatedTokenAddressSync(pool.wrapped, owner, false, pool.wrappedProgram);
  const userUnderlying = getAssociatedTokenAddressSync(pool.underlying, owner, false, pool.underlyingProgram);
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
      ],
      data: Buffer.concat([Buffer.from([1]), u64le(depositRaw), Buffer.from([pool.bump])]),
    }),
    createTransferCheckedInstruction(
      userUnderlying, pool.underlying, pool.escrow, owner,
      depositRaw, pool.underlyingDecimals, [], pool.underlyingProgram,
    ),
  ];
}

/** Human amount for an error message: 1234567 @ 6dp -> "1.234567". */
function fmt(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

export type WrapPlan = {
  pool: Pool;
  depositRaw: bigint;
  shortfall: bigint;
  heldWrapped: bigint;
  reserves: bigint;
  supply: bigint;
};

/**
 * Decide whether this payment needs a conversion, and for how much.
 *
 * Returns null when there is nothing to do: the asset is not a wrapped twin,
 * or the payer already holds enough of it (never wrap more than the payment
 * needs — a wrap is a real deposit of the user's money).
 */
async function planWrap(
  conn: Connection,
  facilitator: string,
  accept: AcceptRow,
  wrappedProgram: PublicKey,
  onchainMintAuthority: string | null,
  payer: PublicKey,
  amount: bigint,
): Promise<WrapPlan | null> {
  const acq = await acquireFor(facilitator, accept.asset);
  if (!acq) {
    // No recipe. Fine for a plain-underlying row (the USDC one) — but if this
    // mint IS a wrap-nav twin we would be building the exact broken transfer
    // this route used to emit, so say so instead of shipping it.
    const [pda] = PublicKey.findProgramAddressSync(
      [AUTHORITY_SEED, new PublicKey(accept.asset).toBuffer()], WRAP_PROGRAM_ID,
    );
    if (onchainMintAuthority && onchainMintAuthority === pda.toBase58()) {
      throw new PayBuildError(
        "acquire_recipe_unavailable",
        `${accept.asset} is a wrap-nav twin but ${facilitator}/supported published no acquire recipe for it — refusing to build a transfer of an asset the payer cannot hold`,
        { asset: accept.asset, facilitator },
      );
    }
    return null;
  }

  const pool = await resolvePool(conn, accept.asset, acq, wrappedProgram, onchainMintAuthority);
  const userWrapped = getAssociatedTokenAddressSync(pool.wrapped, payer, false, pool.wrappedProgram);
  const heldWrapped = await tokenBalance(conn, userWrapped);
  if (heldWrapped >= amount) return null;         // already holds enough — no wrap

  const shortfall = amount - heldWrapped;
  const [reserves, supply] = await Promise.all([
    tokenBalance(conn, pool.escrow),
    conn.getTokenSupply(pool.wrapped).then((r) => BigInt(r.value.amount)),
  ]);
  const depositRaw = depositForShares(shortfall, reserves, supply);

  // PRE-FLIGHT. Without this the tx is built, signed, submitted, and dies at
  // InstructionError[2, InvalidAccountData] — the underlying TransferChecked
  // hitting a source ATA that does not exist. That error reads like a mint
  // problem and has cost real debugging hours. Answer it here, in English.
  const userUnderlying = getAssociatedTokenAddressSync(pool.underlying, payer, false, pool.underlyingProgram);
  const heldUnderlying = await tokenBalance(conn, userUnderlying);
  if (heldUnderlying < depositRaw) {
    const sym = pool.underlyingSymbol;
    throw new PayBuildError(
      "insufficient_underlying",
      `this payment needs ${fmt(depositRaw, pool.underlyingDecimals)} ${sym} to convert, and ${payer.toBase58()} holds ${fmt(heldUnderlying, pool.underlyingDecimals)} ${sym}`,
      {
        need: depositRaw.toString(),
        have: heldUnderlying.toString(),
        short: (depositRaw - heldUnderlying).toString(),
        symbol: sym,
        decimals: pool.underlyingDecimals,
        mint: pool.underlying.toBase58(),
        tokenProgram: pool.underlyingProgram.toBase58(),
      },
    );
  }

  return { pool, depositRaw, shortfall, heldWrapped, reserves, supply };
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

  // The payer holds the UNDERLYING, not the twin the 402 quotes. Work out
  // whether this payment needs a conversion before we build anything.
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
  // Acquire before spending: ATA, wrap, deposit — then the payment itself.
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
    // "converting 0.05 USDC" instead of an unexplained extra hop.
    ...(plan
      ? {
        wrap: {
          method: "spl-token-wrap",
          program: plan.pool.programId.toBase58(),
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
