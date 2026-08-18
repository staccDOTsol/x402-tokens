/** Fee math vs the ACTUAL Token-2022 rounding, plus the spot-price cache.
 *
 *  1. grossUp must survive Token-2022's own fee rule (fee = ceil(amount*bps/1e4),
 *     verified 20bps on-chain for yUSDCx 6Zjjx…LuTv on 2026-08-14): for every
 *     net, payTo must receive >= net after withhold, and never absurdly more.
 *     This clears the fee-accounting suspicion on the 8 failed settles — the
 *     quote's maxAmountRequired is gross, receipt is net, and the math holds
 *     for every amount, so short-received was never the failure mode.
 *
 *  2. spotUsdCached: fresh within TTL (one upstream hit), soft-stale on
 *     price-API failure (429 must not 500 a quote), fail-closed past the bound.
 */
import { grossUp } from "./math.js";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

// --- 1. gross-up sweep against Token-2022 ceiling fee ---------------------
const t22fee = (amount: bigint, bps: bigint) => (amount * bps + 9_999n) / 10_000n; // ceil, uncapped maximumFee (yUSDCx: u64::MAX)

let worstOver = 0n;
const check = (net: bigint, bps: number) => {
  const gross = grossUp(net, bps);
  const received = gross - t22fee(gross, BigInt(bps));
  if (received < net) { console.error(`FAIL net=${net} bps=${bps}: received ${received} < net`); process.exit(1); }
  const over = received - net;
  if (over > worstOver) worstOver = over;
};
for (let net = 1n; net <= 50_000n; net++) check(net, 20);
for (const net of [999_999n, 1_000_000n, 123_456_789n, 10n ** 15n, 10n ** 18n]) {
  check(net, 20); check(net, 1); check(net, 100); check(net, 9_999);
}
ok(true, "received >= net for every swept amount (20bps + edge bps)");
ok(worstOver <= 2n, `gross-up is tight: worst over-delivery ${worstOver} raw units`);

// --- 2. spot cache: fresh TTL, soft-stale fallback, bounded ---------------
process.env.SPOT_TTL_MS = "60000";
process.env.SPOT_STALE_MAX_MS = "600000";
const { spotUsdCached, _clearSpotCache } = await import("./quote.js");
type Asset = import("./config.js").Asset;
type Config = import("./config.js").Config;

let fetches = 0;
let mode: "ok" | "429" = "ok";
const origFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetches++;
  if (mode === "429") return new Response("rate limited", { status: 429 });
  return new Response(JSON.stringify({ success: true, data: { value: 0.5 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const cfg = { birdeyeKey: "k" } as unknown as Config;
const asset = { symbol: "wTOKENx", mint: "MEME_MINT", decimals: 6, feeBps: 20, priceMint: "UNDERLYING" } as Asset;

_clearSpotCache();
const first = await spotUsdCached(cfg, asset);
ok(first.usd === 0.5 && !first.stale && fetches === 1, "first quote hits the price API");
const second = await spotUsdCached(cfg, asset);
ok(second.usd === 0.5 && !second.stale && fetches === 1, "second quote inside TTL is served from cache (no API hit)");

mode = "429";
process.env.SPOT_TTL_MS = "0"; // force TTL expiry so the 429 path runs
const stale = await spotUsdCached(cfg, asset);
ok(stale.usd === 0.5 && stale.stale === true, "429 with a recent price -> soft-stale last-known price, NOT a 500");
ok(stale.at === first.at, "stale result reports when the spot was actually fetched");

process.env.SPOT_STALE_MAX_MS = "0"; // price now older than the bound
let threw = false;
try { await spotUsdCached(cfg, asset); } catch { threw = true; }
ok(threw, "past the staleness bound the quote fails closed, as before");

globalThis.fetch = origFetch;

// --- 3. the volume curve, as pure maths -----------------------------------
//
// The price the gateway charges is directUsd x volumeRate(spend). Everything
// the pricing contract promises therefore has to be true of this one function
// before any quote is involved, including for inputs no sane caller produces.
const { volumeRate } = await import("./math.js");
const CURVE = { rateMax: 1, rateFloor: 0.25, scaleUsd: 10, decay: 0.25 };

ok(volumeRate(0, CURVE) === 1, "spend $0 -> rate 1.0 (par with OpenRouter, never above)");
ok(volumeRate(-5, CURVE) === 1, "a negative spend is a bug upstream, not a discount");
ok(volumeRate(NaN, CURVE) === 1, "NaN spend falls back to the ceiling rather than pricing off garbage");
ok(volumeRate(Infinity, CURVE) === 1, "an infinite spend is garbage too — ceiling, never a free lunch");
ok(volumeRate(1_000, undefined) === 1, "a missing curve prices at the ceiling instead of throwing inside a 402");

// The shipped curve, to 3dp. If someone retunes the defaults this table is
// what tells them by how much.
const table: Array<[number, number]> = [[1, 0.977], [10, 0.841], [100, 0.549], [1_000, 0.315], [2_550, 0.250]];
for (const [spend, want] of table) {
  const got = volumeRate(spend, CURVE);
  ok(Math.abs(got - want) < 0.001, `$${spend} trailing spend -> ${got.toFixed(3)} of direct (expected ${want})`);
}

// Monotone and bounded on a fine sweep, not just at the table rows.
let prev = Infinity, minSeen = 1, maxSeen = 0;
for (let s = 0; s <= 20_000; s += 7.5) {
  const r = volumeRate(s, CURVE);
  if (r > prev + 1e-12) { console.error(`FAIL curve rose at $${s}`); process.exit(1); }
  prev = r; minSeen = Math.min(minSeen, r); maxSeen = Math.max(maxSeen, r);
}
ok(true, "curve is non-increasing across a 2,667-point sweep to $20k");
ok(maxSeen <= 1 && minSeen >= CURVE.rateFloor, `curve stays inside [${CURVE.rateFloor}, 1] (saw [${minSeen.toFixed(3)}, ${maxSeen.toFixed(3)}])`);
ok(volumeRate(1_000, { ...CURVE, decay: 0 }) === 1, "decay 0 is the kill switch — everyone back at the ceiling");
ok(volumeRate(1_000, { ...CURVE, rateFloor: 0.9 }) === 0.9, "a raised floor is respected");

// --- 4. the trailing-spend ledger ----------------------------------------
//
// It is what feeds the curve, so its two load-bearing behaviours — durability
// across a restart, and ageing out of the window — are priced behaviour.
process.env.SPEND_PATH = join(mkdtempSync(join(tmpdir(), "spend-")), "spend.jsonl");
const spend = await import("./spend.js");

ok(spend.trailingSpend("t_new") === 0, "an unknown tenant has spent nothing -> pays the ceiling");
spend.recordSpend("t_a", 0.25);
spend.recordSpend("t_a", 0.75);
spend.recordSpend("t_b", 10);
ok(spend.trailingSpend("t_a") === 1, "spend accumulates per tenant");
ok(spend.trailingSpend("t_b") === 10, "tenants are isolated from each other");
spend.recordSpend("t_a", 0);
spend.recordSpend("t_a", -5);
spend.recordSpend("", 5);
ok(spend.trailingSpend("t_a") === 1, "zero, negative and tenant-less writes are ignored");

spend._resetSpend(); // "restart": drop the in-memory fold, replay from disk
ok(spend.trailingSpend("t_a") === 1, "spend survives a restart — a redeploy must not reset anyone's price");

// A day outside the window can never price anything again.
const old = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
appendFileSync(process.env.SPEND_PATH, JSON.stringify({ tenant: "t_a", usd: 999, day: old }) + "\n");
spend._resetSpend();
ok(spend.trailingSpend("t_a", 30) === 1, "spend older than the window is excluded");
ok(spend.trailingSpend("t_a", 365) === 1000, "...and included when the window is widened to cover it");

console.log("feemath + spot-cache + volume-curve + spend-ledger selftest OK");
