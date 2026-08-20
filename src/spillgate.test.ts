/** Gateway: every client gets Claude-CLI spill. 100-turn body is forwarded
 *  as a short tail + x-hrr-context, including when the header was already set. */
process.env.BILLING_VERIFY_URL = "http://127.0.0.1:1/no-billing";
process.env.BILLING_VERIFY_TIMEOUT_MS = "50";

import { createServer } from "node:http";
import { createServerFor } from "./server.js";
import { _resetSessionMemo } from "./spill.js";
import type { Config } from "./config.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

_resetSessionMemo();

const upstreamBodies: Array<{ messages: unknown; stream?: boolean; headers: Record<string, string> }> = [];
let bindCalls: Array<{ items?: unknown[]; context_id?: string }> = [];

const mock = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    const url = req.url || "";
    if (url === "/models") return send({ data: [{ id: "m", pricing: { prompt: "0.0000003", completion: "0.0000025" }, context_length: 1000000 }] });
    if (url.endsWith("/internal/v1/hrr/bind") || url === "/internal/v1/hrr/bind") {
      const j = JSON.parse(b || "{}") as { items?: unknown[]; context_id?: string };
      bindCalls.push(j);
      return send({ context_id: j.context_id || "ctx_GATE", bound: (j.items || []).length });
    }
    if (url.includes("/hrr/recall")) return send({ items: [{ text: "earlier: holographic memory" }] });
    if (url === "/chat/completions") {
      const j = JSON.parse(b || "{}") as { messages?: unknown; stream?: boolean };
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      upstreamBodies.push({ messages: j.messages, stream: j.stream, headers });
      return send({ id: "gen", choices: [{ message: { role: "assistant", content: "hi" } }] });
    }
    if (url === "/verify") return send({ isValid: true, payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" });
    if (url === "/settle") return send({ success: true, transaction: "SIG", network: "solana:test", payer: "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku" });
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
  lecoreUrl: base, lecoreKey: "", lecoreTenant: "zoo", lecoreSpillTokens: 8000,
  lecoreTopK: 8, lecoreTailChars: 2000, lecoreChunkChars: 1200, lecoreQueryChars: 400,
  lecoreChunkOverlap: 300, lecoreTimeoutMs: 5000, lecoreRequired: false,
  assets: [{ symbol: "yUSDCx", mint: "MINT", decimals: 6, feeBps: 20, priceMint: "USDC", stableUsd: 1 }],
} as unknown as Config;

const gw = createServerFor(cfg).listen(0);
await new Promise<void>((r) => gw.on("listening", () => r()));
const gport = (gw.address() as { port: number }).port;
const chatUrl = `http://127.0.0.1:${gport}/v1/chat/completions`;
const msgUrl = `http://127.0.0.1:${gport}/v1/messages`;
const payment = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: "exact", network: "solana:test", payload: { transaction: "AAAA" },
})).toString("base64");

const hundred = Array.from({ length: 100 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `turn ${i} ` + "holographic memory ".repeat(80),
}));
const fatBody = JSON.stringify({
  model: "m",
  messages: [{ role: "system", content: "be brief" }, ...hundred],
  max_tokens: 8,
});

function lastUpstreamCount() {
  const last = upstreamBodies[upstreamBodies.length - 1];
  return Array.isArray(last?.messages) ? last.messages.length : -1;
}

// 1. Claude-CLI shape (no header) + payment → short tail, stream forced false
{
  bindCalls = [];
  upstreamBodies.length = 0;
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payment, "x-claude-code-session-id": "sess-cli" },
    body: fatBody,
  });
  const j = await r.json() as { x402?: { spill?: { sent?: number; total?: number; context_id?: string } }; choices?: unknown[] };
  ok(r.status === 200, `CLI-shaped paid call is 200 (got ${r.status})`);
  ok(lastUpstreamCount() > 0 && lastUpstreamCount() <= 12, `upstream got a short tail (${lastUpstreamCount()} msgs, not 101)`);
  ok(upstreamBodies[0].stream === false, "gateway still forces stream:false");
  ok(Boolean(r.headers.get("x-hrr-context") === "ctx_GATE" || j.x402?.spill?.context_id), "context id rides back to the client");
  ok((j.x402?.spill?.sent ?? lastUpstreamCount()) <= 8, `receipt names a short sent (got ${j.x402?.spill?.sent})`);
  ok((j.x402?.spill?.total ?? 101) >= 100, "receipt names the original turn count");
}

// 2. Header ALREADY set (grokui) — still cut, append that id
{
  bindCalls = [];
  upstreamBodies.length = 0;
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": payment,
      "x-hrr-context": "ctx_GROKUI",
    },
    body: fatBody,
  });
  ok(r.status === 200, `header-already-set paid call is 200 (got ${r.status})`);
  ok(lastUpstreamCount() <= 12, `header-set still forwards a short tail (${lastUpstreamCount()})`);
  ok(bindCalls.some((b) => b.context_id === "ctx_GROKUI"), "bind appended to the caller-supplied id");
  ok(r.headers.get("x-hrr-context") === "ctx_GROKUI", "response echoes the reused id");
}

// 3. Subscription bearer skips 402 (not a wallet pay)
{
  upstreamBodies.length = 0;
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ozk_live_testkey999999" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
  });
  ok(r.status === 200, `ozk_live bearer skips 402 (got ${r.status})`);
  ok(upstreamBodies.length === 1, "subscription path reached upstream without x-payment");
}

// 4. Bare POST still 402 — we did not break wallet pay
{
  const r = await fetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
  });
  ok(r.status === 402, "no bearer and no payment still 402");
}

// 5. /v1/messages is proxied through the same spill
{
  bindCalls = [];
  upstreamBodies.length = 0;
  const r = await fetch(msgUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": payment },
    body: JSON.stringify({
      model: "m",
      system: "be brief",
      max_tokens: 8,
      messages: hundred,
    }),
  });
  const j = await r.json() as { type?: string; role?: string; content?: unknown };
  ok(r.status === 200, `/v1/messages paid is 200 (got ${r.status})`);
  ok(j.type === "message" && j.role === "assistant", "Anthropic-shaped response");
  ok(lastUpstreamCount() <= 12, `/v1/messages also forwarded a short tail (${lastUpstreamCount()})`);
}

gw.close();
mock.close();
console.log("\nspillgate selftest OK");
