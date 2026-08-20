/**
 * Provider-error credits.
 *
 * Settle-before-serve is deliberate (see server.ts: failed settles used to be
 * free inference), which means a call whose UPSTREAM then errors has already
 * been paid for. MEASURED (2026-08-15): xAI rejected the upstream key and the
 * gateway settled $0.088 on-chain for an error JSON — grok bought ~$1 of
 * "Incorrect API key" that day.
 *
 * We cannot un-settle, and on-chain refunds are their own project. What we can
 * do tonight, honestly: credit the tenant the full billed amount and apply it
 * automatically to their next quotes until consumed. Keyed by tenant (same key
 * the sidecar partitions by), because at quote time no payer address exists
 * yet — the common case (same client retries immediately) is exactly the case
 * this serves. Durable jsonl so restarts do not eat anyone's credit.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const ledgerPath = () => process.env.CREDITS_PATH || "/data/credits.jsonl";

type Entry = { tenant: string; usd: number; reason: string; t: number };

let balances: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (balances) return balances;
  balances = new Map();
  if (existsSync(ledgerPath())) {
    for (const line of readFileSync(ledgerPath(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Entry;
        balances.set(e.tenant, (balances.get(e.tenant) ?? 0) + e.usd);
      } catch { /* torn line at crash; skip */ }
    }
  }
  return balances;
}

function write(e: Entry): void {
  try {
    appendFileSync(ledgerPath(), JSON.stringify(e) + "\n");
  } catch { /* disk trouble must not take down serving; balance stays in-memory */ }
  load().set(e.tenant, (load().get(e.tenant) ?? 0) + e.usd);
}

export function creditBalance(tenant: string): number {
  return Math.max(0, load().get(tenant) ?? 0);
}

/** Upstream returned an error object after we settled: full billed amount back. */
export function grantCredit(tenant: string, usd: number, reason: string): void {
  if (usd <= 0) return;
  write({ tenant, usd, reason, t: Date.now() });
}

/**
 * Apply available credit to a quote. Returns the discounted amount and
 * RECORDS the consumption immediately — optimistic, so a caller who abandons
 * the quote wastes their own credit rather than double-spending it. Credits
 * exist to make error responses free, not to be a bank.
 */
export function applyCredit(tenant: string, billedUsd: number): { usd: number; creditUsed: number } {
  const bal = creditBalance(tenant);
  if (bal <= 0) return { usd: billedUsd, creditUsed: 0 };
  const used = Math.min(bal, billedUsd);
  write({ tenant, usd: -used, reason: "applied", t: Date.now() });
  return { usd: billedUsd - used, creditUsed: used };
}

/** Test hook — drop the in-memory fold so the next read replays from disk. */
export function _resetCredits(): void { balances = null; }

/** Ledger rows for this tenant (test / receipt). Never throws. */
export function creditEntries(tenant?: string): Array<{ tenant: string; usd: number; reason: string; t: number }> {
  const out: Array<{ tenant: string; usd: number; reason: string; t: number }> = [];
  if (!existsSync(ledgerPath())) return out;
  try {
    for (const line of readFileSync(ledgerPath(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { tenant: string; usd: number; reason: string; t: number };
        if (!tenant || e.tenant === tenant) out.push(e);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return out;
}
