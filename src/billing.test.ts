/**
 * Keep prepaid after a launched / settled call. Quote is a ceiling vs
 * direct (never bill MORE than going naked). Receipt cogsUsd is actual
 * provider cost. billedUsd is what the user paid. Do not grant credit
 * back for race_unused or provider_error — we still pay OpenRouter.
 */
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "x402-billing-"));
process.env.CREDITS_PATH = join(dir, "credits.jsonl");
process.env.SPEND_PATH = join(dir, "spend.jsonl");
process.env.RACE_POOL_CHEAP = "m1,m2,m3,m4";
process.env.RACE_JUDGE_MODEL = "judge";
process.env.RACE_RACER_TIMEOUT_MS = "2000";
process.env.BILLING_VERIFY_URL = "http://127.0.0.1:1/no-billing";
process.env.BILLING_VERIFY_TIMEOUT_MS = "50";
process.env.OPENROUTER_TIMEOUT_MS = "800";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

import type { Quote } from "./quote.js";
import { reconcileQuote, usageFromCompletion } from "./quote.js";
import { raceActualCogsUsd, raceActualUsd, racePartConsumed, raceReconcile, type RaceResult } from "./race.js";
import { prepaidBilledUsd, refundAfterSettle, x402Receipt, type PayInfo } from "./completions.js";
import { creditEntries, grantCredit, _resetCredits } from "./credits.js";

function q(partial: Partial<Quote> & { billedUsd: number; openrouterUsd: number }): Quote {
  return {
    model: "m",
    promptTokensEst: 10,
    maxOut: 256,
    markup: 1,
    pricedAt: "t",
    accepts: [],
    pricing: "volume",
    directUsd: partial.directUsd ?? partial.openrouterUsd,
    ...partial,
  };
}

const pay = (over: Partial<PayInfo> = {}): PayInfo => ({
  paidByCredit: false,
  picked: { asset: "yUSDCx", maxAmountRequired: "1" },
  settled: { success: true, transaction: "tx" },
  payer: "P",
  ...over,
});

const raceResult = (over: Partial<RaceResult> = {}): RaceResult => ({
  text: "ok",
  model: "m2",
  error: false,
  statusLog: [],
  judgeUsed: true,
  launched: ["m1", "m2", "m3", "m4"],
  countable: ["m2", "m3"],
  failed: ["m1"],
  aborted: ["m4"],
  usedModels: ["m2", "m3"],
  ...over,
});

const parts = [
  { model: "m1", role: "racer" as const, q: q({ model: "m1", billedUsd: 0.04, openrouterUsd: 0.04 }) },
  { model: "m2", role: "racer" as const, q: q({ model: "m2", billedUsd: 0.05, openrouterUsd: 0.05 }) },
  { model: "m3", role: "racer" as const, q: q({ model: "m3", billedUsd: 0.06, openrouterUsd: 0.06 }) },
  { model: "m4", role: "racer" as const, q: q({ model: "m4", billedUsd: 0.07, openrouterUsd: 0.07 }) },
  { model: "judge", role: "judge" as const, q: q({ model: "judge", billedUsd: 0.01, openrouterUsd: 0.01 }) },
];
const ceilingCogs = parts.reduce((s, p) => s + p.q.openrouterUsd, 0);
const used = raceResult();

/* ---------------------------------------------------------------------- *
 * Unit: after settle / launch, never grant race_unused or provider_error.
 * ---------------------------------------------------------------------- */
console.log("--- no grant-back after settle ---");
_resetCredits();
writeFileSync(process.env.CREDITS_PATH as string, "");
{
  const r = refundAfterSettle("t", false, 0.42, 0, true, { failed: "provider_error", unused: "reconcile" });
  ok(r === undefined, "provider_error after a launched call does not refund");
  ok(!creditEntries("t").some((e) => e.reason === "provider_error"),
    "ledger does not write provider_error for prepaid / paidByCredit");
}
{
  const before = creditEntries("t").length;
  const r = refundAfterSettle("t", true, 0.42, 0, true, { failed: "provider_error", unused: "reconcile" });
  ok(r === undefined, "subscription skip-402 still does not mint credit");
  ok(creditEntries("t").length === before, "paidBySub writes nothing");
}
{
  const r = refundAfterSettle("t", false, 1, 0.25, false);
  ok(r === undefined, "unused racers / unused ceiling are not granted back");
  ok(!creditEntries("t").some((e) => e.reason === "race_unused"),
    "ledger does not write race_unused");
}
{
  const quoted = q({ billedUsd: 0.10, openrouterUsd: 0.12, directUsd: 0.10 });
  ok(Math.abs(prepaidBilledUsd(quoted) - 0.10) < 1e-12, "prepaid billed stays at the quote");
  const leaked = q({ billedUsd: 0.08, openrouterUsd: 0.05, directUsd: 0.05 });
  ok(Math.abs(prepaidBilledUsd(leaked) - 0.05) < 1e-12, "billed is still a ceiling vs direct");
}

/* ---------------------------------------------------------------------- *
 * Unit: cogsUsd is used racers, never the N+judge ceiling.
 * ---------------------------------------------------------------------- */
console.log("--- cogsUsd is actual, not the ceiling ---");
ok(!racePartConsumed(parts[0], used), "failed racer is unused");
ok(racePartConsumed(parts[1], used) && racePartConsumed(parts[2], used), "countable racers are used");
ok(!racePartConsumed(parts[3], used), "aborted racer is unused");
ok(racePartConsumed(parts[4], used), "judge counts when used");
const actualCogs = raceActualCogsUsd(parts, used);
const actualBill = raceActualUsd(parts, used);
ok(Math.abs(actualCogs - 0.12) < 1e-12, `used cogs = m2+m3+judge (got ${actualCogs})`);
ok(actualCogs < ceilingCogs - 1e-12, `used cogs ${actualCogs} < N+judge ceiling ${ceilingCogs}`);
ok(Math.abs(actualBill - 0.12) < 1e-12, "used billed matches used racers");

const receipt = x402Receipt({
  q: q({ billedUsd: 0.23, openrouterUsd: ceilingCogs, directUsd: 0.23 }),
  lecoreInfo: { engaged: false, tokensBefore: 1, tokensAfter: 1 },
  pay: pay(),
  billedUsd: 0.23,
  cogsUsd: actualCogs,
  race: {
    n: 4, need: 2, tier: "cheap", models: ["m1", "m2", "m3", "m4"],
    quotedUsd: 0.23, actualUsd: actualBill, actualCogsUsd: actualCogs, unusedUsd: 0.11,
  },
});
ok(receipt.cogsUsd === actualCogs, "receipt cogsUsd === used actual, not q.openrouterUsd");
ok(receipt.cogsUsd !== ceilingCogs, "receipt cogsUsd is not the N+judge ceiling");
ok((receipt.billedUsd as number) === 0.23, "receipt billedUsd stays at what the user paid");
ok((receipt.billedUsd as number) <= (receipt.directUsd as number) + 1e-12, "receipt billedUsd <= directUsd");
ok(!receipt.refund_credit, "receipt has no refund_credit when we keep prepaid");

const painted = x402Receipt({
  q: q({ billedUsd: 0.23, openrouterUsd: ceilingCogs, directUsd: 0.23 }),
  lecoreInfo: { engaged: false, tokensBefore: 1, tokensAfter: 1 },
  pay: pay(),
  billedUsd: 0.23,
  race: {
    n: 4, need: 2, tier: "cheap", models: ["m1", "m2", "m3", "m4"],
    quotedUsd: 0.23, actualUsd: actualBill, actualCogsUsd: actualCogs, unusedUsd: 0.11,
  },
});
ok(painted.cogsUsd === actualCogs, "even without extras.cogsUsd, race.actualCogsUsd wins over the ceiling");
ok((painted.billedUsd as number) === 0.23, "billed stays prepaid even when race.actualUsd is lower");

/* ---------------------------------------------------------------------- *
 * Unit: quote is a ceiling; reconcile never bills above direct.
 * ---------------------------------------------------------------------- */
console.log("--- quote is a ceiling ---");
{
  const quoted = q({
    billedUsd: 0.10,
    openrouterUsd: 0.10,
    directUsd: 0.10,
    maxOut: 256,
    promptTokensEst: 100,
    promptPrice: 0.000001,
    completionPrice: 0.000002,
  });
  const rec = reconcileQuote(quoted, { prompt_tokens: 100, completion_tokens: 8, cost: 0.02 });
  ok(rec.billedUsd <= quoted.billedUsd + 1e-12, "reconcile never bills above the prepaid quote");
  ok(rec.billedUsd <= (quoted.directUsd ?? 0) + 1e-12, "reconcile never bills above direct");
  ok(rec.cogsUsd === 0.02, "cogsUsd is usage.cost, not the max_tokens ceiling");
  ok(rec.billedUsd < quoted.billedUsd, "emitting less than max_tokens lowers the reconciled bill");
}
{
  const quoted = q({ billedUsd: 0.08, openrouterUsd: 0.05, directUsd: 0.05 });
  const rec = reconcileQuote(quoted, { cost: 0.05 });
  ok(rec.billedUsd <= 0.05 + 1e-12, "billed is capped at direct even if the quote leaked above it");
}
{
  const u = usageFromCompletion({ usage: { prompt_tokens: 3, completion_tokens: 7, cost: 0.001 } });
  ok(!!u && u.cost === 0.001 && u.completion_tokens === 7, "usage.cost is read off the completion");
}
{
  const rec = raceReconcile(parts, used, new Map([
    ["m2", { cost: 0.001 }],
    ["m3", { cost: 0.002 }],
    ["judge", { cost: 0.0005 }],
  ]));
  ok(Math.abs(rec.cogsUsd - 0.0035) < 1e-12, "race cogs sums usage.cost of used parts only");
  ok(rec.billedUsd <= 0.12 + 1e-12, "race billed stays at-or-under used quotes");
}

/* ---------------------------------------------------------------------- *
 * Integration: gateway door.
 * ---------------------------------------------------------------------- */
console.log("--- gateway ---");

const { createServerFor } = await import("./server.js");
const { _clearModelCache } = await import("./openrouter.js");
import type { Config } from "./config.js";

let mode: "ok" | "502" | "503" | "fetchfail" | "race" | "xai" = "ok";
let upstreamHostHits = 0;
const MODELS = ["m", "m1", "m2", "m3", "m4", "judge", "x-ai/grok-3"];

const mock = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/models") {
      return send({
        data: MODELS.map((id) => ({ id, pricing: { prompt: "0.0000003", completion: "0.0000025" }, context_length: 1000000 })),
      });
    }
    if (req.url === "/chat/completions") {
      upstreamHostHits += 1;
      let parsed: { model?: string; messages?: Array<{ content?: string }> } = {};
      try { parsed = JSON.parse(b || "{}"); } catch { /* */ }
      const model = String(parsed.model || "m");
      if (mode === "502") {
        res.statusCode = 502;
        return send({ error: { message: "bad gateway" } });
      }
      if (mode === "503") {
        res.statusCode = 503;
        return send({ error: { message: "unavailable" } });
      }
      if (mode === "fetchfail") {
        // Stay silent so complete() hits OPENROUTER_TIMEOUT_MS (timeout / fetch-failed).
        return;
      }
      if (mode === "race") {
        if (model === "m1") { req.destroy(); return; }
        if (model === "m4") {
          setTimeout(() => send({
            id: "late",
            choices: [{ message: { role: "assistant", content: "late" } }],
            usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.000004 },
          }), 250);
          return;
        }
        if (model === "judge") {
          const prompt = String(parsed.messages?.[0]?.content || "");
          return send({
            id: "judge",
            choices: [{ message: { role: "assistant", content: prompt.includes("real-two") ? "SCORE 9" : "SCORE 7" } }],
            usage: { prompt_tokens: 20, completion_tokens: 2, cost: 0.000005 },
          });
        }
        const text = model === "m3" ? "real-two" : "real-one";
        return send({
          id: model,
          choices: [{ message: { role: "assistant", content: text } }],
          usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.00001 },
        });
      }
      return send({
        id: "gen",
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 },
      });
    }
    if (req.url === "/verify") return send({ isValid: true, payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" });
    if (req.url === "/settle") return send({ success: true, transaction: "SIGSIGSIG", network: "solana:test", payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" });
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
const mport = (mock.address() as { port: number }).port;
const base = `http://127.0.0.1:${mport}`;

const cfg = {
  port: 0, publicUrl: base, facilitator: base, network: "solana:test",
  payTo: "PAYTO", feePayer: "FEEPAYER", markup: 3, discount: 0.5, floorMultiple: 1.5,
  volume: { rateMax: 1, rateFloor: 0.25, scaleUsd: 10, decay: 0.25 }, volumeWindowDays: 30,
  openrouterKey: "k", openrouterUrl: base, birdeyeKey: "", defaultModel: "m",
  lecoreUrl: "", lecoreKey: "", lecoreTenant: "zoo", lecoreSpillTokens: 8000,
  lecoreTopK: 8, lecoreTailChars: 2000, lecoreChunkChars: 1200, lecoreQueryChars: 400,
  lecoreChunkOverlap: 300, lecoreTimeoutMs: 5000, lecoreRequired: false,
  webSearchDefault: false, xaiKey: "should-not-be-used", xaiUrl: "http://127.0.0.1:1",
  assets: [{ symbol: "yUSDCx", mint: "MINT", decimals: 6, feeBps: 20, priceMint: "USDC", stableUsd: 1 }],
} as unknown as Config;

const gw = createServerFor(cfg).listen(0);
await new Promise<void>((r) => gw.on("listening", () => r()));
const gport = (gw.address() as { port: number }).port;
const chatUrl = `http://127.0.0.1:${gport}/v1/chat/completions`;

async function chat(body: unknown, headers: Record<string, string> = {}) {
  return fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function resetLedger() {
  writeFileSync(process.env.CREDITS_PATH as string, "");
  _resetCredits();
  _clearModelCache();
}

function refundReasons(tenant: string) {
  return creditEntries(tenant).filter((e) =>
    e.reason === "provider_error" || e.reason === "race_unused" || e.reason === "race_failed" || e.reason === "reconcile",
  );
}

// Prepaid 502 / 503 / fetch-failed: we launched upstream, so keep the draw.
for (const errMode of ["502", "503", "fetchfail"] as const) {
  resetLedger();
  grantCredit("zoo", 5, "seed");
  mode = errMode;
  const r = await chat({ model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 32 });
  const j = await r.json() as {
    x402?: { refund_credit?: { usd?: number; reason?: string }; billedUsd?: number; cogsUsd?: number; quotedUsd?: number };
  };
  ok(r.status >= 400, `${errMode}: prepaid error is not a 200`);
  ok(!j.x402?.refund_credit, `${errMode}: no refund_credit after a launched call`);
  ok((j.x402?.billedUsd ?? 0) > 0, `${errMode}: billedUsd stays at what the user paid`);
  ok(Math.abs((j.x402?.billedUsd ?? 0) - (j.x402?.quotedUsd ?? 1)) < 1e-12,
    `${errMode}: billed stays at the prepaid quote`);
  ok((j.x402?.cogsUsd ?? 1) === 0, `${errMode}: cogsUsd is actual (no usage.cost on a provider error)`);
  const applied = creditEntries("zoo").filter((e) => e.reason === "applied").reduce((s, e) => s + e.usd, 0);
  const folded = creditEntries("zoo").reduce((s, e) => s + e.usd, 0);
  ok(applied < 0, `${errMode}: prepaid credit was drawn (applied=${applied})`);
  ok(refundReasons("zoo").length === 0, `${errMode}: drawn prepaid is not granted back`);
  ok(folded < 5 - 1e-12, `${errMode}: ledger balance stays reduced (folded=${folded})`);
}

// Successful JSON: billed ≤ direct, cogs is usage.cost not the max_tokens ceiling.
resetLedger();
grantCredit("zoo", 5, "seed");
mode = "ok";
{
  const r = await chat({ model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 256 });
  const j = await r.json() as { x402?: { billedUsd?: number; quotedUsd?: number; cogsUsd?: number; directUsd?: number } };
  ok(r.status === 200, "prepaid success → 200");
  ok((j.x402?.billedUsd ?? 9) <= (j.x402?.directUsd ?? 0) + 1e-12, "billedUsd ≤ directUsd");
  ok((j.x402?.cogsUsd ?? 9) === 0.00001, "cogsUsd is usage.cost, not the max_tokens quote");
  ok((j.x402?.billedUsd ?? 9) <= (j.x402?.quotedUsd ?? 0) + 1e-12, "billedUsd ≤ quoted ceiling");
  ok(Math.abs((j.x402?.billedUsd ?? 0) - (j.x402?.quotedUsd ?? 1)) < 1e-12,
    "success billed stays at prepaid (unused tokens are not granted back)");
}

// 4-need-2 race with 2 failures: do NOT restore prepaid. billed stays. cogs is actual.
resetLedger();
grantCredit("zoo", 50, "seed");
mode = "race";
{
  const before = creditEntries("zoo").reduce((s, e) => s + e.usd, 0);
  const r = await chat({
    messages: [{ role: "user", content: "ping" }], max_tokens: 32,
    race: 4, race_need: 2, tier: "cheap",
  });
  const j = await r.json() as {
    x402?: {
      billedUsd?: number; quotedUsd?: number; cogsUsd?: number; directUsd?: number;
      refund_credit?: { reason?: string };
      race?: { actualUsd?: number; actualCogsUsd?: number; unusedUsd?: number; quotedUsd?: number };
    };
  };
  ok(r.status === 200, "prepaid 4-need-2 race → 200");
  const x = j.x402!;
  ok(x.cogsUsd === x.race?.actualCogsUsd, "receipt cogsUsd === race.actualCogsUsd");
  ok(!x.refund_credit, "4-need-2 with failures does not write refund_credit");
  ok(refundReasons("zoo").length === 0, "2 failures do not restore prepaid (no race_unused / provider_error)");
  ok(Math.abs((x.billedUsd ?? 0) - (x.quotedUsd ?? 1)) < 1e-12, "billed stays at the prepaid N+judge quote");
  ok((x.billedUsd ?? 9) <= (x.directUsd ?? 0) + 1e-12, "race billedUsd ≤ directUsd");
  ok((x.cogsUsd ?? 9) < (x.quotedUsd ?? 0), "cogsUsd is below the prepaid N+judge ceiling");
  ok(Math.abs((x.cogsUsd ?? 9) - 0.000025) < 1e-12, `cogsUsd is used racers' usage.cost (m2+m3+judge=0.000025, got ${x.cogsUsd})`);
  const applied = creditEntries("zoo").filter((e) => e.reason === "applied").reduce((s, e) => s + e.usd, 0);
  const folded = creditEntries("zoo").reduce((s, e) => s + e.usd, 0);
  ok(applied < 0, `prepaid was drawn once for the race (applied=${applied})`);
  ok(folded < before - 1e-12, `unused / failed racers do not restore the drawn balance (folded=${folded})`);
}

// x-ai/* meters through OpenRouter, not the direct-xAI URL.
resetLedger();
grantCredit("zoo", 5, "seed");
mode = "ok";
upstreamHostHits = 0;
{
  const r = await chat({ model: "x-ai/grok-3", messages: [{ role: "user", content: "ping" }], max_tokens: 8 });
  const j = await r.json() as { choices?: unknown[]; error?: unknown };
  ok(r.status === 200, "x-ai/* through OpenRouter → 200 (dead xaiUrl was not used)");
  ok(Array.isArray(j.choices), "x-ai/* returns a completion from the OpenRouter mock");
  ok(upstreamHostHits >= 1, "x-ai/* hit the OpenRouter mock, not XAI_URL");
}

gw.close(); mock.close();
console.log("billing selftest OK");
