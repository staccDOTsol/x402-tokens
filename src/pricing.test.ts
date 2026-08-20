/**
 * THE PRICING CONTRACT, asserted rather than asserted-about.
 *
 *   1. CEILING   — billedUsd is NEVER above what buying the same body from
 *                  OpenRouter costs. This is the whole point of the change:
 *                  the flat 3x is gone and nothing may reintroduce it.
 *   2. DECREASE  — the price is monotonically NON-INCREASING in the tenant's
 *                  trailing spend. Talk more, pay less, with no tier cliff.
 *   3. FACE VALUE— $N of prepaid credit costs exactly $N. Prepaying must never
 *                  be worse than not prepaying.
 *
 * Plus the properties the old file already defended and which must survive:
 * the counterfactual leCore discount, the cost floor, and monotonicity in
 * BODY SIZE (padding a body past the spill threshold must not buy a discount).
 *
 * Numbers are the measured 60k-needle cell (70,906 tok direct -> 890 forwarded).
 */
import { quoteRequest, quoteUnits } from "./quote.js";
import { estimateTokens, volumeRate } from "./math.js";
import type { Config } from "./config.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };
const usd = (n: number) => `$${n.toFixed(6)}`;

// gemini-2.5-flash raw rates; quoteRequest calls getModel, so we monkeypatch fetch.
const P = 3e-7, C = 2.5e-6;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request) => {
  const url = String(u);
  if (url.includes("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "m", pricing: { prompt: String(P), completion: String(C) }, context_length: 1000000 }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error("unexpected fetch " + url);
}) as typeof fetch;

const CURVE = { rateMax: 1, rateFloor: 0.25, scaleUsd: 10, decay: 0.25 };
const base = {
  openrouterUrl: "https://x/api/v1", openrouterKey: "k", defaultModel: "m",
  markup: 3, discount: 0.5, floorMultiple: 1.5, volume: CURVE, volumeWindowDays: 30, assets: [],
  network: "n", payTo: "p", feePayer: "f", facilitator: "https://f",
} as unknown as Config;

// A body whose FORWARDED size is 890 tokens (~3,560 chars) and whose PRE-SPILL
// size was 70,906 tokens.
const forwarded = { model: "m", max_tokens: 40, messages: [{ role: "user", content: "x".repeat(890 * 4) }] };
const BEFORE = 70906;

const direct = BEFORE * P + 40 * C;          // what buying this body direct costs

/* ---------------------------------------------------------------------- *
 * 1. CEILING — never more expensive than OpenRouter.
 * ---------------------------------------------------------------------- */
console.log("--- ceiling ---");

// The regression this whole change exists for: a small body with nothing to
// spill used to bill 3x OpenRouter's own rate. It must now bill exactly 1x.
const plain = await quoteRequest(base, forwarded);
// what we actually spend forwarding this body — read off the quote rather than
// re-derived, so the message-envelope tokens are counted the same way.
const ourCost = plain.openrouterUsd;
console.log(`direct=${usd(direct)}  ourCost=${usd(ourCost)}  (${(direct / ourCost).toFixed(0)}x)\n`);
ok(plain.pricing === "volume", "no counterfactual -> volume pricing (the flat markup path is gone)");
ok(Math.abs(plain.billedUsd - ourCost) < 1e-12,
  `uncompressed body bills the DIRECT price, not 3x it (${usd(plain.billedUsd)} vs old ${usd(ourCost * 3)})`);
ok(plain.billedUsd < ourCost * 3, "strictly cheaper than the retired 3x floor");
ok((plain.rate ?? 9) <= 1, `rate <= 1 (${plain.rate})`);
ok((plain.savesVsDirect ?? 0) >= 1, `savesVsDirect is a >=1 multiple, never the old 0.3333 (${plain.savesVsDirect})`);

// Sweep: every combination of spend, body size and compression must respect it.
let ceilingChecks = 0;
for (const spend of [0, 0.01, 1, 10, 100, 1_000, 10_000, 1e6]) {
  for (const chars of [4, 400, 4_000, 40_000, 400_000]) {
    for (const before of [undefined, 900, 5_000, BEFORE, 1_000_000]) {
      const b = { model: "m", max_tokens: 40, messages: [{ role: "user", content: "x".repeat(chars) }] };
      const q = await quoteRequest(base, b, before, spend);
      if (!(q.billedUsd <= (q.directUsd ?? 0) + 1e-12)) {
        console.error(`FAIL ceiling breached: spend=${spend} chars=${chars} before=${before} billed=${q.billedUsd} direct=${q.directUsd}`);
        process.exit(1);
      }
      if (!(q.billedUsd > 0)) { console.error("FAIL non-positive price"); process.exit(1); }
      ceilingChecks++;
    }
  }
}
ok(true, `billedUsd <= directUsd across ${ceilingChecks} spend x body x compression combinations`);

// And the ceiling cannot be configured away: rateMax is clamped to 1.
ok(volumeRate(0, { ...CURVE, rateMax: 5 }) === 1, "X402_RATE_MAX above 1 is clamped — no config can price above OpenRouter");

/* ---------------------------------------------------------------------- *
 * 2. DECREASE — monotonically non-increasing in trailing spend.
 * ---------------------------------------------------------------------- */
console.log("\n--- decreasing in usage ---");

const spends = [0, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_550, 5_000, 50_000];
let prevRate = Infinity;
for (const s of spends) {
  const r = volumeRate(s, CURVE);
  if (r > prevRate + 1e-12) { console.error(`FAIL curve rose at $${s}: ${r} > ${prevRate}`); process.exit(1); }
  prevRate = r;
}
ok(true, `volumeRate is non-increasing across ${spends.length} spend levels`);
ok(volumeRate(0, CURVE) === 1, "a brand-new tenant pays exactly the OpenRouter price, no more");
ok(volumeRate(1e9, CURVE) === CURVE.rateFloor, "the curve bottoms out at the configured floor, not at zero");

// The billed price itself, on a compressed body where there is margin to give.
let prevBilled = Infinity;
const table: string[] = [];
for (const s of spends) {
  const q = await quoteRequest(base, forwarded, BEFORE, s);
  if (q.billedUsd > prevBilled + 1e-12) {
    console.error(`FAIL price rose with usage at $${s}: ${q.billedUsd} > ${prevBilled}`);
    process.exit(1);
  }
  prevBilled = q.billedUsd;
  table.push(`   spend $${String(s).padStart(6)}  rate ${(q.volume?.rate ?? 0).toFixed(3)}  billed ${usd(q.billedUsd)}  = ${((q.rate ?? 1) * 100).toFixed(1)}% of direct`);
}
ok(true, "billedUsd is non-increasing in trailing spend");
console.log(table.join("\n"));

// Continuity: no cliff. Adjacent cents of spend must not move the rate more
// than a hair — the same no-cliff law quote.ts enforces on body size.
let worstJump = 0;
for (let s = 0; s < 200; s += 0.25) {
  worstJump = Math.max(worstJump, volumeRate(s, CURVE) - volumeRate(s + 0.25, CURVE));
}
ok(worstJump < 0.01, `no tier cliff: worst 25-cent step moves the rate ${(worstJump * 100).toFixed(3)}%`);

/* ---------------------------------------------------------------------- *
 * 3. FACE VALUE — prepaid credit buys exactly its face value.
 * ---------------------------------------------------------------------- */
console.log("\n--- prepaid credit ---");

for (const amount of [1, 5, 25, 100, 499.99, 500]) {
  const q = quoteUnits(base, "credit", amount, "prepay", 1);
  if (Math.abs(q.billedUsd - amount) > 1e-9) {
    console.error(`FAIL credit face value: $${amount} quoted at ${q.billedUsd}`);
    process.exit(1);
  }
}
ok(true, "$N of credit costs exactly $N at every amount the endpoint accepts");

// ...and it stays face value however the MEDIA markup is tuned. This is the
// property the old `usd / cfg.markup` divide-to-cancel could not guarantee.
for (const markup of [1, 2, 3, 7.5]) {
  const q = quoteUnits({ ...base, markup } as Config, "credit", 25, "prepay", 1);
  if (Math.abs(q.billedUsd - 25) > 1e-9) {
    console.error(`FAIL credit face value broke at X402_MARKUP=${markup}: ${q.billedUsd}`);
    process.exit(1);
  }
}
ok(true, "face value survives any X402_MARKUP — it is structural, not a cancellation");
ok(quoteUnits(base, "img", 0.04, "per-image").billedUsd === 0.04 * base.markup,
  "the media lane still takes its markup (default arg unchanged)");

/* ---------------------------------------------------------------------- *
 * Surviving properties: leCore discount, cost floor, no body-size cliff.
 * ---------------------------------------------------------------------- */
console.log("\n--- leCore counterfactual + cost floor ---");

const cf = await quoteRequest(base, forwarded, BEFORE);
ok(cf.pricing === "counterfactual", "counterfactual tokens -> counterfactual pricing");
ok(cf.billedUsd < direct, `caller pays LESS than direct (${usd(cf.billedUsd)} < ${usd(direct)})`);
ok(Math.abs(cf.billedUsd - direct * 0.5) < 1e-12, "a fresh tenant on a compressed body pays discount x direct (0.5)");
ok(cf.billedUsd > ourCost, "never priced under our own cost");
const cfProfit = cf.billedUsd - ourCost;
console.log(`  fresh tenant   : pays ${usd(cf.billedUsd)}  profit ${usd(cfProfit)}`);
const heavy = await quoteRequest(base, forwarded, BEFORE, 50_000);
ok(heavy.billedUsd < cf.billedUsd, `a heavy tenant pays less than a fresh one (${usd(heavy.billedUsd)} < ${usd(cf.billedUsd)})`);
ok(heavy.billedUsd > ourCost, "even at the rate floor we are above our own cost on this body");
console.log(`  floor-rate one : pays ${usd(heavy.billedUsd)}  profit ${usd(heavy.billedUsd - ourCost)}`);

// Cost floor: a body that barely spilled must not price under cost, and a
// heavy tenant must not be able to push it there either. The floor is
// at-cost only — min(our forwarded cost, direct) — never a 1.5× lift.
const tinySpill = await quoteRequest(base, forwarded, 900, 50_000);
ok(tinySpill.flooredAtCost === true, "near-zero spill at the floor rate -> cost floor engages");
const cappedFloor = Math.min(ourCost, tinySpill.directUsd ?? 0);
ok(tinySpill.billedUsd >= cappedFloor - 1e-12,
  "cost floor holds at our own cost (subordinate to the 1x-direct ceiling)");
ok(tinySpill.billedUsd <= (tinySpill.directUsd ?? 0) + 1e-12, "floored bill still ≤ direct");
ok(tinySpill.billedUsd <= ourCost + 1e-12, "floored bill still ≤ our forwarded cost");
ok(tinySpill.billedUsd + 1e-12 < ourCost * base.floorMultiple,
  "1.5× floorMultiple in Config is not the bill");

// Live cell (Claude spill HUD): forwarded catalog ~$0.35, 1.5× floor wanted
// ~$0.51, X 0.6768. Prove the cap is STRUCTURAL — Config still passes 1.5.
ok(ourCost * 1.5 > (tinySpill.directUsd ?? 0),
  "0.51-vs-0.35 shape: 1.5× forwarded cost exceeds like-for-like direct");
ok(tinySpill.billedUsd <= (tinySpill.directUsd ?? 0) + 1e-12,
  `billed ${usd(tinySpill.billedUsd)} ≤ direct ${usd(tinySpill.directUsd ?? 0)}, never the 1.5× lift ${usd(ourCost * 1.5)}`);
ok(tinySpill.openrouterUsd * 1.5 > (tinySpill.directUsd ?? 0),
  "old wrong law (billed may sit at ourCost × 1.5) would have exceeded direct");

/* ---------------------------------------------------------------------- *
 * Spilled Claude-session: 3/N tail vs 100-turn counterfactual.
 * billedUsd ≤ directUsd. The old wrong law (billed ≤ ourCost × 1.5) is
 * not a license to sit at 1.5× when that exceeds direct.
 * ---------------------------------------------------------------------- */
console.log("\n--- spilled Claude-session billed ≤ direct ---");
const sessionTurn = (i: number) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `turn ${i} ` + "context padding ".repeat(40),
});
const hundredTurns = Array.from({ length: 100 }, (_, i) => sessionTurn(i));
const forwardedTail = {
  model: "m",
  max_tokens: 256,
  messages: hundredTurns.slice(-3),
};
const sessionTokens = estimateTokens(hundredTurns);
ok(sessionTokens > estimateTokens(forwardedTail.messages),
  "3/N tail is much smaller than the 100-turn counterfactual");
const spilled = await quoteRequest(base, forwardedTail, sessionTokens, 0);
ok(spilled.pricing === "counterfactual", "3/N of 100 turns -> counterfactual pricing");
ok(spilled.billedUsd <= (spilled.directUsd ?? 0) + 1e-12,
  `spilled Claude-session billed ${usd(spilled.billedUsd)} ≤ direct ${usd(spilled.directUsd ?? 0)}`);
// The OLD wrong law: billedUsd <= openrouterUsd * max(floorMultiple, 1).
// That permitted sitting at 1.5 × forwarded cogs. It is not the contract.
const oldWrongCeiling = spilled.openrouterUsd * Math.max(base.floorMultiple, 1);
if (oldWrongCeiling > (spilled.directUsd ?? 0) + 1e-12) {
  ok(spilled.billedUsd <= (spilled.directUsd ?? 0) + 1e-12,
    "when 1.5× ourCost would exceed direct, billed still ≤ direct (old wrong law discarded)");
}

// Monotone in BODY SIZE: padding a body must never lower the bill.
let prevBySize = 0;
for (const chars of [1_000, 10_000, 20_000, 39_000, 40_000, 41_000, 42_000, 80_000]) {
  const b = { model: "m", max_tokens: 40, messages: [{ role: "user", content: "x".repeat(chars) }] };
  const q = await quoteRequest(base, b, Math.max(chars / 4, 1) * 2, 100);
  if (q.billedUsd < prevBySize - 1e-12) {
    console.error(`FAIL price fell as the body grew at ${chars} chars: ${q.billedUsd} < ${prevBySize}`);
    process.exit(1);
  }
  prevBySize = q.billedUsd;
}
ok(true, "price is non-decreasing in body size — padding still buys nothing");

// discount 0 disables only the leCore leg; the volume curve stands alone.
const off = await quoteRequest({ ...base, discount: 0 } as Config, forwarded, BEFORE, 1_000);
ok(off.pricing === "volume", "X402_DISCOUNT=0 -> volume pricing, not a markup");
ok(off.billedUsd <= (off.directUsd ?? 0) + 1e-12, "and still never above direct");

// decay 0 is the kill switch: everyone at the ceiling, nothing else changes.
const pinned = await quoteRequest({ ...base, volume: { ...CURVE, decay: 0 } } as Config, forwarded, BEFORE, 1e6);
ok(Math.abs(pinned.billedUsd - direct * 0.5) < 1e-12, "X402_VOLUME_DECAY=0 pins every tenant at the ceiling rate");

globalThis.fetch = origFetch;
console.log(`\nold flat 3x on the uncompressed body: ${usd(ourCost * 3)}  ->  now ${usd(plain.billedUsd)}`);
console.log("pricing selftest OK");
