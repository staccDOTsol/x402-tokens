/** Settle-order: NO CONFIRMED SETTLE, NO UPSTREAM CALL.
 *
 *  The bug this pins down: the handler used to call OpenRouter first and
 *  settle after, so a payment that could not clear (8 "Simulation failed"
 *  settles in the 2026-08-14 production logs) still shipped a full model
 *  response — free inference for every failed settle. The mock facilitator +
 *  mock openrouter here record call ORDER, so a regression to serve-first
 *  fails loudly.
 */
import { createServer } from "node:http";
import { createServerFor } from "./server.js";
import type { Config } from "./config.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

let calls: string[] = [];
let settleMode: "ok" | "fail" = "fail";

// One mock server plays facilitator AND openrouter, path-routed.
const mock = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/models") return send({ data: [{ id: "m", pricing: { prompt: "0.0000003", completion: "0.0000025" }, context_length: 1000000 }] });
    if (req.url === "/chat/completions") { calls.push("upstream"); return send({ id: "gen", choices: [{ message: { role: "assistant", content: "hi" } }] }); }
    if (req.url === "/verify") { calls.push("verify"); return send({ isValid: true, payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" }); }
    if (req.url === "/settle") {
      calls.push("settle");
      return send(settleMode === "ok"
        ? { success: true, transaction: "SIGSIGSIG", network: "solana:test", payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" }
        : { success: false, errorReason: "Simulation failed: insufficient funds", network: "solana:test" });
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
  assets: [{ symbol: "yUSDCx", mint: "MINT", decimals: 6, feeBps: 20, priceMint: "USDC", stableUsd: 1 }],
} as unknown as Config;

const gw = createServerFor(cfg).listen(0);
await new Promise<void>((r) => gw.on("listening", () => r()));
const gport = (gw.address() as { port: number }).port;
const chatUrl = `http://127.0.0.1:${gport}/v1/chat/completions`;
const chatBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "ping" }], max_tokens: 8 });
const payment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "solana:test", payload: { transaction: "AAAA" } })).toString("base64");

// 1. free quote path: no X-PAYMENT -> 402 with accepts, nothing settled or served
calls = [];
{
  const r = await fetch(chatUrl, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody });
  const j = (await r.json()) as { accepts?: unknown[]; error?: string };
  ok(r.status === 402, "no X-PAYMENT -> 402");
  ok(Array.isArray(j.accepts) && j.accepts.length === 1, "402 carries accepts");
  ok(!calls.includes("upstream") && !calls.includes("settle"), "quote touches neither settle nor upstream");
}

// 2. failed settle -> clean 402, "payment failed: <reason>", upstream NEVER called
calls = []; settleMode = "fail";
{
  const r = await fetch(chatUrl, { method: "POST", headers: { "content-type": "application/json", "x-payment": payment }, body: chatBody });
  const j = (await r.json()) as { error?: string; accepts?: unknown[] };
  ok(r.status === 402, "failed settle -> 402 (was: 200 + free inference)");
  ok((j.error ?? "").startsWith("payment failed: "), `402 body says why: "${j.error}"`);
  ok(Array.isArray(j.accepts), "failed-settle 402 re-quotes so the client can retry");
  ok(calls.includes("verify") && calls.includes("settle"), "verify and settle were attempted");
  ok(!calls.includes("upstream"), "UPSTREAM NEVER CALLED on failed settle");
}

// 3. good settle -> 200, and settle ordered strictly BEFORE upstream
calls = []; settleMode = "ok";
{
  const r = await fetch(chatUrl, { method: "POST", headers: { "content-type": "application/json", "x-payment": payment }, body: chatBody });
  const j = (await r.json()) as { choices?: unknown[]; x402?: { settle?: { success?: boolean } } };
  ok(r.status === 200, "settled payment -> 200");
  ok(Array.isArray(j.choices), "model output present");
  ok(j.x402?.settle?.success === true, "receipt carries the settle");
  ok(calls.indexOf("settle") > calls.indexOf("verify"), "verify before settle");
  ok(calls.indexOf("upstream") > calls.indexOf("settle"), "SETTLE BEFORE UPSTREAM");
  ok(calls.filter((c) => c === "upstream").length === 1, "upstream called exactly once");
}

gw.close(); mock.close();
console.log("settle-order selftest OK");
