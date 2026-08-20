/**
 * Streaming + first-X-back race + one-settle billing.
 *
 * These four must fail on main (stream forced false, no race, N-pay if a
 * client raced itself):
 *   1. stream:true yields SSE tokens, not a single JSON blob
 *   2. race 4 need 2: one fetch-failed, two real answers → a real answer wins
 *   3. all racers fail → race-level failure
 *   4. billing/credit is charged once for the race, not per racer
 */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "x402-race-"));
process.env.CREDITS_PATH = join(dir, "credits.jsonl");
process.env.SPEND_PATH = join(dir, "spend.jsonl");
process.env.RACE_POOL_CHEAP = "m1,m2,m3,m4";
process.env.RACE_JUDGE_MODEL = "judge";
process.env.RACE_RACER_TIMEOUT_MS = "2000";
process.env.BILLING_VERIFY_URL = "http://127.0.0.1:1/no-billing";
process.env.BILLING_VERIFY_TIMEOUT_MS = "50";

const { createServerFor } = await import("./server.js");
const { grantCredit, creditEntries, _resetCredits } = await import("./credits.js");
const { _clearModelCache } = await import("./openrouter.js");
import type { Config } from "./config.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

let calls: string[] = [];
let settleCount = 0;
let upstreamByModel: Record<string, number> = {};
let raceMode: "mixed" | "allfail" | "plain" = "plain";

const MODELS = ["m", "m1", "m2", "m3", "m4", "judge"];

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
      calls.push("upstream");
      let parsed: { model?: string; stream?: boolean; messages?: Array<{ content?: string }> } = {};
      try { parsed = JSON.parse(b || "{}"); } catch { /* */ }
      const model = String(parsed.model || "m");
      upstreamByModel[model] = (upstreamByModel[model] || 0) + 1;

      if (raceMode === "allfail") {
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "fetch failed" } }));
        return;
      }
      if (raceMode === "mixed") {
        if (model === "m1") { req.destroy(); return; }
        if (model === "m4") {
          setTimeout(() => send({ id: "late", choices: [{ message: { role: "assistant", content: "late-should-not-win" } }] }), 250);
          return;
        }
        if (model === "judge") {
          const prompt = String(parsed.messages?.[0]?.content || "");
          const score = prompt.includes("real-two") ? 9 : 7;
          return send({ id: "judge", choices: [{ message: { role: "assistant", content: `SCORE ${score}` } }] });
        }
        const text = model === "m3" ? "real-two" : "real-one";
        const delay = model === "m3" ? 40 : 15;
        setTimeout(() => send({ id: model, choices: [{ message: { role: "assistant", content: text } }] }), delay);
        return;
      }

      if (parsed.stream) {
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        const ev = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        ev({ id: "gen", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        ev({ id: "gen", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] });
        ev({ id: "gen", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] });
        ev({ id: "gen", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return send({ id: "gen", choices: [{ message: { role: "assistant", content: "hi" } }] });
    }
    if (req.url === "/verify") { calls.push("verify"); return send({ isValid: true, payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" }); }
    if (req.url === "/settle") {
      calls.push("settle");
      settleCount += 1;
      return send({ success: true, transaction: "SIGSIGSIG", network: "solana:test", payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" });
    }
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
  webSearchDefault: false, xaiKey: "",
  assets: [{ symbol: "yUSDCx", mint: "MINT", decimals: 6, feeBps: 20, priceMint: "USDC", stableUsd: 1 }],
} as unknown as Config;

const gw = createServerFor(cfg).listen(0);
await new Promise<void>((r) => gw.on("listening", () => r()));
const gport = (gw.address() as { port: number }).port;
const chatUrl = `http://127.0.0.1:${gport}/v1/chat/completions`;
const payment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "solana:test", payload: { transaction: "AAAA" } })).toString("base64");

function reset() {
  calls = [];
  settleCount = 0;
  upstreamByModel = {};
  _clearModelCache();
}

// 1. stream:true yields SSE tokens, not a single JSON blob
reset(); raceMode = "plain";
{
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payment },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: true }),
  });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  ok(r.status === 200, "stream:true settled → 200");
  ok(ct.includes("text/event-stream"), `content-type is SSE, not JSON (${ct})`);
  ok(text.includes("data: "), "body has SSE data frames");
  ok(text.includes("Hel") && text.includes("lo"), "SSE carries token chunks");
  ok(text.includes(": x402 "), "trailing : x402 receipt comment");
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* expected */ }
  ok(parsed === null, "body is not a single JSON blob");
  ok(/savesVsDirect/.test(text), "receipt includes savesVsDirect");
}

// 2. race 4 need 2: one racer fetch-failed, two real answers → a real answer wins
reset(); raceMode = "mixed";
{
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payment },
    body: JSON.stringify({
      messages: [{ role: "user", content: "ping" }], max_tokens: 8,
      stream: true, race: 4, race_need: 2, tier: "cheap",
    }),
  });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  ok(r.status === 200, "race stream → 200");
  ok(ct.includes("text/event-stream"), "race stream is SSE");
  ok(text.includes("real-two") || text.includes("real-one"), "a real answer wins");
  ok(!/failed: fetch failed/.test(text), "winner is not fetch-failed");
  ok(!/late-should-not-win/.test(text), "slow 4th does not win");
  ok(/racing 1\/2 back|racing 2\/2 back|judging/.test(text), "status frames are on the stream");
  ok(text.includes(": x402 "), "race stream carries an x402 receipt");
  ok((upstreamByModel.m1 || 0) >= 1, "failed racer was launched");
  ok((upstreamByModel.m2 || 0) >= 1 && (upstreamByModel.m3 || 0) >= 1, "two real racers launched");
}

// 3. all racers fail → race-level failure
reset(); raceMode = "allfail";
{
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payment },
    body: JSON.stringify({
      messages: [{ role: "user", content: "ping" }], max_tokens: 8,
      stream: false, race: 4, race_need: 2, tier: "cheap",
    }),
  });
  const j = await r.json() as { error?: { message?: string; code?: string }; choices?: Array<{ message?: { content?: string } }> };
  const msg = j.error?.message || j.choices?.[0]?.message?.content || "";
  ok(r.status >= 400 || !!j.error, "all-fail is an error, not a 200 assistant string");
  ok(/every model failed|race_failed/.test(JSON.stringify(j)), "race-level failure");
  ok(!/failed: fetch failed/.test(msg), "not a per-model fetch-failed answer");
  ok(j.error?.code === "race_failed" || /every model failed/.test(JSON.stringify(j)), "code is race_failed");
}

// 4. billing/credit is charged once for the race, not per racer
reset(); raceMode = "mixed";
_resetCredits();
grantCredit("zoo", 50, "test");
{
  const appliedBefore = creditEntries("zoo").filter((e) => e.reason === "applied").length;
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "ping" }], max_tokens: 8,
      stream: false, race: 4, race_need: 2, tier: "cheap",
    }),
  });
  const j = await r.json() as { choices?: unknown[]; x402?: { credit?: unknown; billedUsd?: number } };
  ok(r.status === 200, "credit-covered race → 200");
  ok(Array.isArray(j.choices), "credit race returns a completion");
  const applied = creditEntries("zoo").filter((e) => e.reason === "applied").length - appliedBefore;
  ok(applied === 1, `credit applied once, not per racer (got ${applied})`);
  ok(settleCount === 0, "no x402 settle on the credit path");
  const racerCalls = (upstreamByModel.m1 || 0) + (upstreamByModel.m2 || 0) + (upstreamByModel.m3 || 0) + (upstreamByModel.m4 || 0);
  ok(racerCalls >= 3, `several racers launched (${racerCalls}) but billed once`);
}

// 4b. x402 path: one settle for the whole race
reset(); raceMode = "mixed";
{
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payment },
    body: JSON.stringify({
      messages: [{ role: "user", content: "ping" }], max_tokens: 8,
      stream: false, race: 4, race_need: 2, tier: "cheap",
    }),
  });
  ok(r.status === 200, "x402 race → 200");
  ok(settleCount === 1, `settle once for the race, not per racer (got ${settleCount})`);
}

// Store subscription: ozk_live skips 402 (no wallet, no local credit required).
// One accept covers the whole race — do not N-charge or N-402.
reset(); raceMode = "mixed";
_resetCredits();
{
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ozk_live_testkey999999" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "ping" }], max_tokens: 8,
      race: 4, race_need: 2, tier: "cheap",
    }),
  });
  const j = await r.json() as { choices?: unknown[]; x402?: { subscription?: unknown; billedUsd?: number } };
  ok(r.status === 200, "ozk_live bearer skips 402 on a race");
  ok(Array.isArray(j.choices), "subscription race returns a completion");
  ok(settleCount === 0, "subscription never x402-settles");
  const racerCalls = (upstreamByModel.m1 || 0) + (upstreamByModel.m2 || 0) + (upstreamByModel.m3 || 0) + (upstreamByModel.m4 || 0);
  ok(racerCalls >= 3, `several racers launched (${racerCalls}) under one subscription accept`);
}

gw.close(); mock.close();
console.log("stream+race selftest OK");
