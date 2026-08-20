import type { Config } from "./config.js";
import type { Quote } from "./quote.js";
import { acquireForMint, solanaWrap402Help, type WrapAcquire } from "./wrapspec.js";

export interface Requirements {
  scheme: "exact";
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  extra: {
    facilitator: string;
    /** Solana only — the SVM fee payer. Omitted on eip155 rows, where the
     *  facilitator's own gas signer pays and a base58 key here is nonsense. */
    feePayer?: string;
    symbol: string;
    /**
     * Raw-unit exponent for `asset`. Always present so a client NEVER has to
     * assume: the rails span 6-decimal (Solana wraps, Base USDC, wUSDGx) and
     * 18-decimal assets, and assuming 6 on an 18-decimal token underpays by
     * 10^12. `maxAmountRequired` is already in raw units — this is for display
     * and for sanity-checking, not for rescaling it.
     */
    decimals: number;
    /** EIP-712 domain for eip155 rows: what the payer must sign
     *  `TransferWithAuthorization` against. Omitted on Solana rows. */
    name?: string;
    version?: string;
    billedUsd: number;
    tokenUsd: number;
    pricedAt: string;
    /** price API was unreachable; this line rode the last-known spot
     *  (pricedAt names when that spot was fetched). */
    priceStale?: boolean;
    /** how this price was formed. "volume"/"counterfactual" = a FRACTION of
     *  what buying this body direct would cost, never a markup on what we
     *  forward. "markup" survives only on the per-unit media lane. */
    pricing: "markup" | "counterfactual" | "volume";
    directUsd?: number;
    /** directUsd/billedUsd, always >= 1 on the text lane. */
    savesVsDirect?: number;
    /** billedUsd/directUsd — the fraction of direct actually charged. */
    rate?: number;
    savedPct?: number;
    savedUsd?: number;
    volume?: { spendUsd: number; rate: number; rateFloor: number; windowDays: number };
    markup?: number;
    /**
     * Solana wrap-nav rails only. Post-exploit 9-account Wrap recipe — the
     * program CPIs the deposit. A 5-account + TransferChecked shape dies 0x6a.
     */
    acquire?: WrapAcquire;
  };
}

export function requirements(cfg: Config, q: Quote, resource: string): Requirements[] {
  return q.accepts.map((a) => {
    const isEvm = a.network.startsWith("eip155:");
    return {
    scheme: "exact" as const,
    network: a.network,
    asset: a.mint,
    maxAmountRequired: a.grossRaw,
    // Chain-shaped payee. Sending the Solana base58 address on an eip155 row
    // makes the EIP-3009 `to` unparseable and every Base/RH payment unsignable.
    payTo: a.payTo ?? cfg.payTo,
    resource,
    // NAME THE RIGHT UPSTREAM. Media rides Together, not OpenRouter, and a
    // receipt that misnames where the work happened is a receipt nobody can
    // reconcile. priceModel is set only on the media path, so it doubles as
    // the discriminator and tells the payer this is a per-unit estimate
    // against a vendor example rather than a metered token count.
    //
    // AND NAME THE RIGHT BASIS. This used to read "OpenRouter <model> × 3" on
    // the ordinary text path, which was accurate and is no longer the deal:
    // the text lane is a FRACTION of OpenRouter's own price, never a multiple
    // of it. Quote the discount, not a multiplier that can no longer exceed 1.
    description: q.priceModel
      ? `Together ${q.model} × ${q.markup}, ${q.priceModel} at ${a.pricedAt}`
      : (q.savedPct ?? 0) > 0.005
        ? `${q.model} — ${Math.round((q.savedPct ?? 0) * 100)}% off buying direct (${(q.savesVsDirect ?? 1).toFixed(1)}× cheaper), at ${a.pricedAt}`
        : `${q.model} — at OpenRouter's own price, never above it, at ${a.pricedAt}`,
    maxTimeoutSeconds: 120,
    extra: {
      facilitator: cfg.facilitator,
      feePayer: isEvm ? undefined : cfg.feePayer,
      symbol: a.symbol,
      decimals: a.decimals,
      name: isEvm ? a.eip712?.name : undefined,
      version: isEvm ? a.eip712?.version : undefined,
      billedUsd: a.billedUsd,
      tokenUsd: a.tokenUsd,
      pricedAt: a.pricedAt,
      priceStale: a.priceStale,
      // Advertising a markup while running a ~29x gross margin is a lie the
      // first time someone counts tokens. State the basis, and only quote a
      // multiplier when a multiplier is actually what formed the price.
      pricing: q.pricing,
      directUsd: q.directUsd,
      savesVsDirect: q.savesVsDirect,
      rate: q.rate,
      savedPct: q.savedPct,
      savedUsd: q.savedUsd,
      volume: q.volume,
      // The EFFECTIVE multiplier, not the configured one. On the fail-open
      // path quoteLive runs with markup 1 (we charge at cost when our own
      // memory did not engage) — reporting cfg.markup there told the caller
      // they paid 3x when they paid 1x, on exactly the calls where trust
      // matters most. q.markup is what actually formed this price.
      markup: q.pricing === "markup" ? q.markup : undefined,
      acquire: isEvm ? undefined : acquireForMint(a.mint, a.symbol),
    },
  };
  });
}

export function challenge(cfg: Config, q: Quote, resource: string, error = "payment required") {
  return {
    x402Version: 1,
    accepts: requirements(cfg, q, resource),
    error,
    // Name UNDERLYING assets, never the wrapper tickers — those are internal
    // plumbing. Derived from the live rails so it cannot drift out of date.
    help: solanaWrap402Help(underlyingNames(cfg), cfg.facilitator),
  };
}

/** Underlying assets behind the live rails, deduped, in offer order. */
export function underlyingNames(cfg: Config): string {
  const seen = new Set<string>();
  for (const a of cfg.assets) {
    const net = a.network ?? cfg.network;
    const chain = net.startsWith("solana:") ? "Solana"
      : net === "eip155:8453" ? "Base"
      : net === "eip155:4663" ? "Robinhood Chain"
      : net;
    // wrapper ticker -> what the holder actually brought
    const under = /^yUSDCx$/.test(a.symbol) ? "USDC"
      : /^wUSDGx$/.test(a.symbol) ? "USDG"
      : /^wTOKENx$/.test(a.symbol) ? "TOKEN"
      : a.symbol;
    seen.add(`${under} on ${chain}`);
  }
  return [...seen].join(", ");
}

export async function verify(cfg: Config, header: string, reqs: Requirements[]): Promise<{ ok: boolean; reason?: string; picked?: Requirements; payer?: string }> {
  let payload: { network?: string; payload?: unknown };
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed X-PAYMENT header" };
  }
  // One network can carry SEVERAL rows (eip155:4663 quotes wUSDGx plus the
  // memecoin twins). The x402 exact payload does not name its asset — the
  // asset only exists inside the signed EIP-712 domain — so network-only
  // matching pinned every RH payment to the first row and the facilitator
  // answered "signature does not match payer" for any other asset. Match by
  // network, order by signed-value == row's maxAmountRequired (raw amounts
  // differ per asset), and let the facilitator's verify break any remaining
  // tie by trying each candidate until one validates.
  const sameNet = reqs.filter((r) => r.network === payload.network);
  const authValue = String(
    (payload as { payload?: { authorization?: { value?: unknown } } }).payload?.authorization?.value ?? "",
  );
  const candidates = [
    ...sameNet.filter((r) => r.maxAmountRequired === authValue),
    ...sameNet.filter((r) => r.maxAmountRequired !== authValue),
  ];
  if (!candidates.length && reqs[0]) candidates.push(reqs[0]);
  if (!candidates.length) return { ok: false, reason: "no matching requirements" };
  let lastReason: string | undefined;
  for (const picked of candidates) {
    try {
      const r = await fetch(`${cfg.facilitator}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentPayload: payload, paymentRequirements: picked }),
      });
      const j = (await r.json()) as { isValid?: boolean; invalidReason?: string; payer?: string };
      if (j.isValid) return { ok: true, picked, payer: j.payer };
      lastReason = j.invalidReason;
    } catch (e) {
      return { ok: false, reason: `facilitator unreachable: ${(e as Error).message.slice(0, 80)}` };
    }
  }
  return { ok: false, reason: lastReason ?? "no candidate row validated", picked: candidates[0] };
}

export async function settle(cfg: Config, header: string, picked: Requirements) {
  const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const r = await fetch(`${cfg.facilitator}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: payload, paymentRequirements: picked }),
  });
  return r.json().catch(() => ({ success: false }));
}
