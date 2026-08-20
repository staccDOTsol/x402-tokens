/**
 * Per-tenant trailing spend — the input to the volume curve.
 *
 * WHY A SEPARATE STORE. usage.ts already records every billed call, but it
 * records them keyed by PAYER (a wallet address) into a bounded 10k ring that
 * has been measured holding as little as 1h39m of history. Pricing cannot read
 * from that: the axis is the tenant (sha256(chain:signer:namespace), the same
 * key credits.ts partitions by), the window is 30 days, and a price that
 * silently changes because a ring rolled over is not a price. So this is a
 * small, durable, purpose-built ledger — modelled on credits.ts.
 *
 * SHAPE. One append per settled call, folded on read into UTC-day buckets per
 * tenant. Day buckets rather than raw events because the memory then has a
 * hard ceiling — tenants x windowDays — instead of growing with traffic, and
 * because nothing about a volume discount needs sub-day resolution.
 *
 * WHAT COUNTS. Inference actually served: billedUsd on every call the tenant
 * paid for, whether that payment came from x402 or from prepaid credit. NOT
 * top-ups. Counting a $100 top-up AND the $100 of calls it pays for would
 * double-count the same dollar and let a tenant buy the floor rate twice over
 * for one hundred dollars.
 *
 * SHARDING — THE HONEST LIMITATION. The app runs several Fly machines and each
 * has its own volume, so a tenant spread across machines accumulates its
 * window on each one separately. That means the discount arrives SLOWER than
 * strictly earned, never faster: every machine sees a subset of the spend, so
 * every machine computes a rate >= the true one, and the failure mode is
 * "charged closer to list", not "gave away inference". Deliberately not fixed
 * with a fan-out here: pricing must not depend on a cross-machine round trip
 * that can time out mid-402. The fix, when it is worth it, is to fold spend
 * into the existing usage fan-out and read it once per minute per tenant.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const ledgerPath = () => process.env.SPEND_PATH || "/data/spend.jsonl";
/** Compact the append log into one line per (tenant, day) past this size. */
const maxBytes = () => Number(process.env.SPEND_MAX_BYTES || 8 * 1024 * 1024);

type Entry = { tenant: string; usd: number; day: string };

/** tenant -> UTC day ("2026-08-18") -> USD spent that day */
let buckets: Map<string, Map<string, number>> | null = null;
let appendsSinceStat = 0;

export const utcDay = (t = Date.now()): string => new Date(t).toISOString().slice(0, 10);

function fold(map: Map<string, Map<string, number>>, e: Entry): void {
  if (!e || typeof e.tenant !== "string" || !e.tenant) return;
  const usd = Number(e.usd);
  if (!Number.isFinite(usd) || usd <= 0) return;
  const day = typeof e.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.day) ? e.day : utcDay();
  const byDay = map.get(e.tenant) ?? new Map<string, number>();
  byDay.set(day, (byDay.get(day) ?? 0) + usd);
  map.set(e.tenant, byDay);
}

function load(): Map<string, Map<string, number>> {
  if (buckets) return buckets;
  buckets = new Map();
  const p = ledgerPath();
  if (existsSync(p)) {
    try {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { fold(buckets, JSON.parse(line) as Entry); } catch { /* torn line at crash; skip */ }
      }
    } catch { /* an unreadable ledger must not stop the server: everyone just starts at the ceiling */ }
  }
  return buckets;
}

/**
 * Rewrite the append log as its own folded state: one line per (tenant, day),
 * which is bounded by tenants x window instead of by traffic. Old days are
 * dropped here rather than accumulating forever — they can never affect a
 * price again.
 */
function compact(windowDays: number): void {
  const p = ledgerPath();
  const cutoff = utcDay(Date.now() - windowDays * 86_400_000);
  const lines: string[] = [];
  for (const [tenant, byDay] of load()) {
    for (const [day, usd] of byDay) {
      if (day < cutoff) { byDay.delete(day); continue; }
      lines.push(JSON.stringify({ tenant, usd, day } satisfies Entry));
    }
    if (byDay.size === 0) load().delete(tenant);
  }
  try {
    const tmp = `${p}.compact`;
    writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "");
    renameSync(tmp, p);
  } catch { /* disk trouble must not take down serving; the in-memory fold is still correct */ }
}

/**
 * Record inference a tenant actually paid for. Never throws — a pricing
 * ledger must not be able to fail a request that already settled on-chain.
 */
export function recordSpend(tenant: string, usd: number, windowDays = 30): void {
  if (!tenant || !(usd > 0) || !Number.isFinite(usd)) return;
  const e: Entry = { tenant, usd, day: utcDay() };
  fold(load(), e);
  try {
    appendFileSync(ledgerPath(), JSON.stringify(e) + "\n");
    if ((appendsSinceStat += 1) >= 200) {
      appendsSinceStat = 0;
      if (statSync(ledgerPath()).size > maxBytes()) compact(windowDays);
    }
  } catch { /* in-memory total stays right; a restart just resets this tenant toward the ceiling */ }
}

/** This tenant's spend over the trailing `windowDays`, in USD.
 *
 *  PURE — it does not prune. Ageing out happens in compact(), which is the
 *  only place that knows it is safe: dropping a day here would make the answer
 *  depend on which window a previous caller happened to ask for, and a price
 *  that changes because of someone else's read is not a price. */
export function trailingSpend(tenant: string, windowDays = 30): number {
  if (!tenant) return 0;
  const byDay = load().get(tenant);
  if (!byDay) return 0;
  const cutoff = utcDay(Date.now() - windowDays * 86_400_000);
  let total = 0;
  for (const [day, usd] of byDay) if (day >= cutoff) total += usd;
  return total;
}

/** Test hook — drops the in-memory fold so the next read replays from disk. */
export function _resetSpend(): void { buckets = null; appendsSinceStat = 0; }
