/**
 * Wallet SESSIONS — sign once, spend for a day.
 *
 * THE PROBLEM THIS SOLVES. A namespace signature is verified against a short
 * replay window (LECORE_NAMESPACE_SIG_WINDOW_MS, 5 min). That is right for a
 * CLI, which holds the key and can re-sign silently on every call. It is
 * unusable in a browser: a wallet never signs without a user gesture, so
 * "prove the payer on every message" means a Phantom prompt every five
 * minutes of chatting. Users do not do that; they end up on the shared
 * tenant, which is exactly the misbilling the signature exists to prevent.
 *
 * So the signature is exchanged ONCE for a bearer token that carries the
 * tenant it proved. One prompt per day instead of one per five minutes, and
 * the tenant is still derived from a verified signer — never from a string
 * the caller asserted.
 *
 * STATELESS ON PURPOSE. The token is `v1.<payload>.<hmac>`; there is no
 * session table to grow, replicate between Fly machines, or leak. Revocation
 * is therefore coarse (rotate the secret), which is an accepted trade for a
 * 24h credential that only selects a tenant and cannot move funds.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secretFor(cfg: { lecoreKey?: string }): string {
  const s = process.env.OPENZOO_SESSION_SECRET || cfg.lecoreKey || "";
  // Refuse rather than fall back to a constant: a guessable secret here mints
  // tokens for ANY tenant, which is strictly worse than having no sessions.
  if (!s) throw new Error("OPENZOO_SESSION_SECRET (or LECORE_HRR_KEY) is not set");
  return s;
}

/** Mint a token for an ALREADY-VERIFIED tenant. Never call with an unverified one. */
export function mintSession(cfg: { lecoreKey?: string }, tenant: string, ttlMs = DEFAULT_TTL_MS): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlMs;
  const payload = b64url(Buffer.from(JSON.stringify({ t: tenant, e: expiresAt }), "utf8"));
  const mac = b64url(createHmac("sha256", secretFor(cfg)).update(payload).digest());
  return { token: `v1.${payload}.${mac}`, expiresAt };
}

/** The tenant a token proves, or null. Constant-time, expiry-checked. */
export function tenantFromSession(cfg: { lecoreKey?: string }, token: string | undefined): string | null {
  if (!token || !token.startsWith("v1.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, payload, mac] = parts;
  let want: string;
  try { want = b64url(createHmac("sha256", secretFor(cfg)).update(payload).digest()); }
  catch { return null; }
  const a = Buffer.from(mac), b = Buffer.from(want);
  // Length check first: timingSafeEqual THROWS on a length mismatch, and an
  // exception inside tenant resolution is a 500 for everyone.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const raw = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const { t, e } = JSON.parse(raw) as { t?: string; e?: number };
    if (!t || typeof e !== "number" || Date.now() > e) return null;
    return t;
  } catch { return null; }
}
