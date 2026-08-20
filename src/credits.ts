/**
 * Prepaid tenant credit (top-ups). Not an error-refund ledger.
 *
 * A quote fully covered by balance serves without a wallet 402. Consumption
 * is optimistic — a caller who abandons the quote wastes their own credit
 * rather than double-spending it. Once we draw prepaid (or settle on-chain)
 * and launch upstream, we keep the money: we still pay OpenRouter for
 * in-flight / settled work. Subscription skip-402 never mints credit here.
 *
 * Keyed by tenant (same key the sidecar partitions by). Durable jsonl so
 * restarts do not eat anyone's balance.
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

/** Add prepaid balance (top-up). Never used to refund a launched / settled call. */
export function grantCredit(tenant: string, usd: number, reason: string): void {
  if (usd <= 0) return;
  write({ tenant, usd, reason, t: Date.now() });
}

/**
 * Apply available credit to a quote. Returns the discounted amount and
 * RECORDS the consumption immediately — optimistic, so a caller who abandons
 * the quote wastes their own credit rather than double-spending it. Credits
 * exist so a tenant can skip the per-call 402, not to refund OpenRouter COGS.
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
