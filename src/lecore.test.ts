/** Proves the two things that matter: OFF is byte-identical passthrough, and
 *  ON reprices the 402 down because the spill happens BEFORE the quote. */
import { createServer } from "node:http";
import { prepare } from "./lecore.js";
import { estimateTokens } from "./math.js";
import type { Config } from "./config.js";

const base = { lecoreKey: "", lecoreTenant: "zoo", lecoreSpillTokens: 500, lecoreTopK: 4, lecoreTailChars: 2000, lecoreChunkChars: 1200, lecoreQueryChars: 400, lecoreChunkOverlap: 300, lecoreTimeoutMs: 5000, lecoreRequired: false };
const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

const book = Array.from({ length: 60 }, (_, i) =>
  ({ role: "user", content: `chapter ${i}: ` + "holographic memory ".repeat(60) }));
const body = { model: "m", messages: [...book, { role: "user", content: "who is jarett?" }] };
const before = estimateTokens(body.messages);

// --- fake HRR sidecar ---
const srv = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    void b;
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/v1/hrr/bind") return res.end(JSON.stringify({ context_id: "ctx_TEST" }));
    if (req.url === "/internal/v1/hrr/recall") return res.end(JSON.stringify({ items: [{ text: "jarett is stacc" }] }));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise<void>((r) => srv.listen(0, () => r()));
const port = (srv.address() as { port: number }).port;

// 1. OFF -> untouched
const off = await prepare({ ...base, lecoreUrl: "" } as Config, body as Record<string, unknown>);
ok(off.info.engaged === false, "OFF: does not engage");
ok(off.body === (body as unknown), "OFF: forwards the SAME object (no copy, no mutation)");
ok(off.info.tokensAfter === before, `OFF: quote unchanged (${before} tok)`);

// 2. small body -> untouched even when configured
const small = { model: "m", messages: [{ role: "user", content: "hi" }] };
const s = await prepare({ ...base, lecoreUrl: `http://127.0.0.1:${port}` } as Config, small as Record<string, unknown>);
ok(s.info.engaged === false && s.info.reason === "under spill threshold", "small body: under threshold, passthrough");

// 3. ON -> spills, and the QUOTE INPUT shrinks
const on = await prepare({ ...base, lecoreUrl: `http://127.0.0.1:${port}` } as Config, body as Record<string, unknown>, "ctx_TEST");
ok(on.info.engaged === true, "ON: engages");
ok(on.info.tokensAfter < on.info.tokensBefore, `ON: ${on.info.tokensBefore} -> ${on.info.tokensAfter} tokens`);
ok(estimateTokens(on.body.messages) === on.info.tokensAfter, "ON: reported tokensAfter matches the forwarded body");
const msgs = on.body.messages as Array<{ role?: string; content?: string }>;
ok(msgs[msgs.length - 1].content === "who is jarett?", "ON: the live ask survives verbatim");
ok(String(msgs[0].content).includes("jarett is stacc"), "ON: recalled slice is injected");
console.log(`\nBILLING: 402 priced on ${on.info.tokensAfter} tok instead of ${on.info.tokensBefore} -> ${(on.info.tokensBefore / on.info.tokensAfter).toFixed(1)}x cheaper, and that ratio is the discount off buying direct`);

// 4. sidecar down -> fail-open, never takes the zoo down. MUST still cut:
// returning the original 850k body is how every racer and every phone died.
const dead = await prepare({ ...base, lecoreUrl: "http://127.0.0.1:1" } as Config, body as Record<string, unknown>);
ok(dead.info.engaged === false, "sidecar down: fail-open (not engaged)");
ok(String(dead.info.reason).startsWith("fail-open"), "sidecar down: reason reported, not silent");
ok((dead.body.messages as unknown[]).length < (body.messages as unknown[]).length,
  `sidecar down: still cuts the tail (${(dead.body.messages as unknown[]).length} < ${(body.messages as unknown[]).length})`);

// 5. LECORE_REQUIRED=1 -> fail-closed
let threw = false;
try { await prepare({ ...base, lecoreUrl: "http://127.0.0.1:1", lecoreRequired: true } as Config, body as Record<string, unknown>); }
catch (e) { threw = String((e as Error).message).startsWith("lecore_unavailable"); }
ok(threw, "LECORE_REQUIRED=1: fail-closed with lecore_unavailable");

srv.close();
console.log("\nlecore selftest OK");
