/**
 * Post-exploit wrap-nav client spec. Shared by the 402 extra.acquire.steps,
 * /prompt.txt help, storefront copy, and /v1/pay/build metadata so those
 * surfaces cannot drift back to the pre-2026-08-18 5-account shape.
 *
 * On 2026-08-18 FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE was rewritten
 * after a drain (829,559 TOKEN, unbacked Wrap). The program now CPIs the
 * deposit. A 5-account Wrap dies with 0x6a NotEnoughAccounts at
 * need(accounts, 9)? (~109 CU).
 */

export const WRAP_NAV_PROGRAM = "FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const WRAP_IX_DATA = "[1] ++ u64 amount LE ++ [bump]";

/** Exact 9-account Wrap layout. Account 4 vs 8 are not interchangeable. */
export const WRAP_ACCOUNT_LINES = [
  "0 [writable] escrow (authority PDA ATA for UNDERLYING)",
  "1 [writable] wrapped mint",
  "2 [writable] recipient wrapped ATA",
  "3 [] authority PDA [\"mint_authority\", wrapped_mint]",
  "4 [] wrapped token program (= wrapped_mint.owner)",
  "5 [writable] depositor UNDERLYING token account",
  "6 [signer] depositor",
  "7 [] unwrapped mint",
  "8 [] unwrapped token program (= escrow.owner)",
] as const;

export const WRAP_STEP_NOTE =
  "data = [1] ++ u64 amount LE ++ [bump]. NINE accounts: 0 escrow (writable), " +
  "1 wrapped mint (writable), 2 recipient wrapped ATA (writable), " +
  "3 authority PDA [\"mint_authority\", wrapped_mint], " +
  "4 wrapped token program (= wrapped_mint.owner), " +
  "5 depositor UNDERLYING token account (writable), 6 depositor signer, " +
  "7 unwrapped mint, 8 unwrapped token program (= escrow.owner). " +
  "Account 4 vs 8 are not interchangeable. No separate TransferChecked — " +
  "the program CPIs the deposit. A 5-account Wrap dies with NotEnoughAccounts " +
  "(0x6a) at need(accounts, 9)? (~109 CU).";

export const UNWRAP_STEP_NOTE =
  "Unwrap is also 9 accounts; account 8 is the unwrapped token program. " +
  "Prepend an idempotent create of the underlying ATA.";

export type WrapAcquireUnderlying = {
  address: string;
  symbol: string;
  decimals: number;
  tokenProgram: string;
};

export type WrapAcquireStep = {
  program: string;
  instruction: "Wrap";
  note: string;
};

export type WrapAcquire = {
  method: "spl-token-wrap";
  program: string;
  underlying?: WrapAcquireUnderlying;
  escrow?: string;
  mintAuthority?: string;
  authorityBump?: number;
  steps: WrapAcquireStep[];
  unwrap: { accounts: 9; account8: string; note: string };
  warning?: string;
  source?: string;
};

export function splTokenWrapAcquire(partial: {
  underlying?: WrapAcquireUnderlying;
  escrow?: string;
  mintAuthority?: string;
  authorityBump?: number;
  warning?: string;
} = {}): WrapAcquire {
  return {
    method: "spl-token-wrap",
    program: WRAP_NAV_PROGRAM,
    ...partial,
    steps: [{
      program: WRAP_NAV_PROGRAM,
      instruction: "Wrap",
      note: WRAP_STEP_NOTE,
    }],
    unwrap: {
      accounts: 9,
      account8: "unwrapped token program",
      note: UNWRAP_STEP_NOTE,
    },
    source: "https://github.com/staccDOTsol/token-wrap-",
  };
}

/** yUSDCx — USDC (legacy SPL) → Token-2022 wrap. Escrow owner is Tokenkeg. */
export const YUSDCX_MINT = "6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv";
export const YUSDCX_ACQUIRE = splTokenWrapAcquire({
  escrow: "2qLm8aCvn6gQVUFeQ7EC5J62Y95gFzc3vReHzD5d5Gj2",
  mintAuthority: "EBGYMEEEPKu7szPUbnbp2h63azY9Sj9GR4MA2Ms6Quoi",
  underlying: {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM,
  },
});

/**
 * Post-drain TOKEN wrap. Replaces Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9
 * (escrow 7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q), drained 2026-08-18.
 */
export const WTOKENX2_MINT = "FXYkwMtfKpA174rp8ixVeiGs5TYGaBsYRrHE3KrR449B";
export const WTOKENX2_ACQUIRE = splTokenWrapAcquire({
  escrow: "2ZFYUDiYbtJ8czCPnd6Wjbeo1Yg1LLJ9JkGPMeuZkKyh",
  mintAuthority: "2SFdjJoRyWfXvXghAjahDgmaZPrAr5WqqCr8KquAtZVM",
  authorityBump: 254,
  underlying: {
    address: "EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump",
    symbol: "TOKEN",
    decimals: 6,
    tokenProgram: TOKEN_2022_PROGRAM,
  },
  warning:
    "Replaces Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9, drained 2026-08-18 " +
    "(829,559 TOKEN) by Wrap instructions that minted shares with no deposit. " +
    "Program fixed at slot 440219442.",
});

export const WLEOSX_MINT = "3FViQRMqtG6dUDFxZyyVvpM9xTHsKdX7uqZ5jvL8NZ35";
export const WLEOSX_ACQUIRE = splTokenWrapAcquire({
  escrow: "62kjFPGb2RnPXfShFdeYuvyN72hg5EC4N8UVkuN1RiMc",
  mintAuthority: "3Fj3FCty8DJZTrEdW5dYLgEfbVNATDixj9gVWWxuvz8J",
  authorityBump: 255,
  underlying: {
    address: "5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e",
    symbol: "LEOS",
    decimals: 9,
    tokenProgram: TOKEN_PROGRAM,
  },
});

/** Pre-exploit TOKEN wrap — still 9-account if anyone wraps into it; unbacked. */
export const WTOKENX_DRAINED_MINT = "Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9";
export const WTOKENX_DRAINED_ACQUIRE = splTokenWrapAcquire({
  escrow: "7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q",
  mintAuthority: "AqdXyPzN6s5KH8KpdnKJmhUipyDUxxGxbJ5Qk1YKghXT",
  authorityBump: 255,
  underlying: {
    address: "EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump",
    symbol: "TOKEN",
    decimals: 6,
    tokenProgram: TOKEN_2022_PROGRAM,
  },
  warning:
    "Drained 2026-08-18 (829,559 TOKEN, unbacked Wrap). Prefer " +
    `${WTOKENX2_MINT} (wTOKENx2). A 5-account Wrap still dies 0x6a.`,
});

const BY_MINT: Record<string, WrapAcquire> = {
  [YUSDCX_MINT]: YUSDCX_ACQUIRE,
  [WTOKENX2_MINT]: WTOKENX2_ACQUIRE,
  [WLEOSX_MINT]: WLEOSX_ACQUIRE,
  [WTOKENX_DRAINED_MINT]: WTOKENX_DRAINED_ACQUIRE,
};

/** Recipe for a 402 extra.acquire, or a steps-only fallback for unknown twins. */
export function acquireForMint(mint: string, symbol?: string): WrapAcquire | undefined {
  if (BY_MINT[mint]) return BY_MINT[mint];
  if (symbol && /^(yUSDCx|wTOKENx2?|wLEOSx)$/.test(symbol)) return splTokenWrapAcquire();
  return undefined;
}

export function isStaleTransferThenWrapSteps(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => {
    const ix = (s as { instruction?: string }).instruction;
    return ix === "TransferChecked";
  });
}

export function solanaWrap402Help(underlyingNames: string, facilitator: string): string {
  return (
    `Pay in ${underlyingNames}. Solana wrap of raw USDC/TOKEN/LEOS is a single ` +
    `9-account Wrap on ${WRAP_NAV_PROGRAM} (data = ${WRAP_IX_DATA}); the program ` +
    `CPIs the deposit — do not send a separate TransferChecked or a 5-account Wrap, ` +
    `that dies NotEnoughAccounts (0x6a) at need(accounts, 9)?. extra.acquire.steps ` +
    `is the recipe. Don't hold any yet? ${facilitator}/start. Each accepts[] row ` +
    `carries extra.decimals — maxAmountRequired is already in that asset's raw ` +
    `units, do not rescale it.`
  );
}

/** Imperative wrap HOWTO for /prompt.txt and the storefront clanker dump. */
export function wrapClientInstructions(): string {
  return `ON SOLANA, raw TOKEN (EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump) and raw USDC will not settle. Wrap first with ONE Wrap instruction on ${WRAP_NAV_PROGRAM} — the program CPIs the deposit itself (rewritten 2026-08-18 after an unbacked Wrap drained 829,559 TOKEN).

data = ${WRAP_IX_DATA}
9 accounts:
${WRAP_ACCOUNT_LINES.join("\n")}
No separate TransferChecked. Account 4 vs 8 are not interchangeable. A 5-account Wrap dies with NotEnoughAccounts (0x6a) at need(accounts, 9)? (~109 CU).

- USDC → yUSDCx ${YUSDCX_MINT} escrow ${YUSDCX_ACQUIRE.escrow}
- TOKEN → wTOKENx2 ${WTOKENX2_MINT} escrow ${WTOKENX2_ACQUIRE.escrow}
  (replaces drained Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9 / escrow 7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q)
Unwrap: 9 accounts, account 8 = unwrapped token program; prepend underlying ATA idempotent create.

Both wraps are Token-2022 with a 20bps transfer tax. Yield is that tax.`;
}
