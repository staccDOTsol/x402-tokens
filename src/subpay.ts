/**
 * Subscription bearers — the other pay lane next to x402.
 *
 * iOS / Android store clients and grokui-with-card send
 * `Authorization: Bearer ozk_live_…` (or Stripe-style `sk_live_` /
 * `oz_live_`). That is not an x402 payment. Forcing a wallet 402 on a
 * bearer that already skips 402 is how phones die at the paywall.
 *
 * Shape check is local and cheap. Live entitlement is zoo.openzoo.fun
 * `/api/billing/verify` when reachable. A well-formed key still skips
 * 402 if billing is down — a hung verify must not become a wallet prompt.
 * BILLING_VERIFY_REQUIRED=1 fail-closes instead.
 */
import { createHash } from "node:crypto";

export const SUB_PREFIXES = ["ozk_live_", "oz_live_", "sk_live_", "sk_test_"] as const;

function billingUrl() {
  return (process.env.BILLING_VERIFY_URL || "https://zoo.openzoo.fun/api/billing/verify").replace(/\/$/, "");
}
function verifyRequired() {
  return process.env.BILLING_VERIFY_REQUIRED === "1";
}
function verifyTimeoutMs() {
  return Number(process.env.BILLING_VERIFY_TIMEOUT_MS || 2500);
}

export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!raw || typeof raw !== "string") return undefined;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(raw);
  return m?.[1];
}

export function looksLikeSubscriptionKey(key: string | undefined): boolean {
  if (!key) return false;
  return SUB_PREFIXES.some((p) => key.startsWith(p)) && key.length >= pMin(key);
}

function pMin(key: string): number {
  const p = SUB_PREFIXES.find((x) => key.startsWith(x)) ?? "";
  return p.length + 8;
}

/** Tenant partition for a subscription key — hash, never the secret. */
export function subscriptionTenant(base: string, key: string): string {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${base}_sub_${h}`;
}

export interface SubAccept {
  ok: boolean;
  key?: string;
  reason?: string;
  /** hashed tenant suffix when we accepted */
  tenant?: string;
}

/**
 * Accept a subscription bearer. Never logs the key.
 *
 * - not a subscription shape → ok:false (caller falls through to x402)
 * - verify 200/ok → accept
 * - verify 401 → reject (fake key) unless REQUIRED is off AND we treat
 *   well-formed keys as the store-client skip the user asked for
 * - verify down → accept well-formed keys unless REQUIRED
 */
export async function acceptSubscription(
  authorization: string | string[] | undefined,
  opts: { verify?: typeof verifySubscription; baseTenant?: string } = {},
): Promise<SubAccept> {
  const key = bearerToken(authorization);
  if (!looksLikeSubscriptionKey(key)) return { ok: false, reason: "not_subscription" };
  const verify = opts.verify ?? verifySubscription;
  let remote: { ok: boolean; status?: number };
  try {
    remote = await verify(key as string);
  } catch {
    remote = { ok: false, status: 0 };
  }
  if (remote.ok) {
    return { ok: true, key, tenant: subscriptionTenant(opts.baseTenant || "zoo", key as string) };
  }
  if (verifyRequired()) return { ok: false, reason: "verify_failed", key: undefined };
  // Store clients already skip 402 on this shape. Do not force wallet pay.
  return { ok: true, key, tenant: subscriptionTenant(opts.baseTenant || "zoo", key as string), reason: "shape_skip" };
}

export async function verifySubscription(key: string): Promise<{ ok: boolean; status?: number }> {
  const BILLING = billingUrl();
  if (!BILLING) return { ok: false, status: 0 };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), verifyTimeoutMs());
  try {
    const r = await fetch(BILLING, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ key }),
      signal: ac.signal,
    });
    if (r.status >= 200 && r.status < 300) {
      const j = await r.json().catch(() => ({})) as { ok?: boolean };
      return { ok: j.ok !== false, status: r.status };
    }
    return { ok: false, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}
