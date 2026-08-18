import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { complete, listModels } from "./openrouter.js";
import { clankerPrompt, renderIndex } from "./page.js";
import { quoteLive, quoteMediaLive, quoteUnits } from "./quote.js";
import { generateImage, getMedia, listMedia, normalizeResolution, pollVideo, submitVideo, unitCostUsd } from "./together.js";
import { ablatePassthrough, attach, bindPassthrough, ContextGoneError, lecoreCall, memorySearch, memoryWrite, prepare, type LecoreResult } from "./lecore.js";
import { challenge, requirements, settle, verify } from "./x402.js";
import { verifySignedNamespace } from "./nsauth.js";
import { mintSession, tenantFromSession } from "./session.js";
import { buildUnsignedPayment, PayBuildError, type AcceptRow } from "./paybuild.js";
import { applyCredit, creditBalance, grantCredit } from "./credits.js";
import { recordSpend, trailingSpend } from "./spend.js";
import { dedupObserve } from "./dedup.js";
import * as usage from "./usage.js";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * What a CLIENT can use, which is not what the transformer holds. Bodies past
 * the spill threshold are carved and bound to the HRR sidecar before the 402,
 * and `POST /v1/hrr/bind` + `X-HRR-Context` does it explicitly — so the usable
 * ceiling is the bind capacity, not any single model's window.
 */
/**
 * Per-caller context isolation.
 *
 * Every bind used to land in ONE sidecar tenant ("zoo"), so a context was
 * protected only by its id being unguessable — no isolation between callers
 * at all, and the free bind endpoint means anyone can write into that shared
 * space. Callers now supply an opaque namespace (the shim sends a hash of its
 * wallet pubkey) which is hashed into the tenant id, so one wallet's corpora
 * are unreachable from another's even if an id leaks.
 *
 * Hashed, not used raw: the namespace should not become a way to write
 * arbitrary tenant strings into the sidecar, and hashing bounds the shape.
 * Callers that send nothing keep the legacy shared tenant.
 *
 * UNVERIFIED, though: a raw namespace string is just whatever the caller
 * typed — nothing checks the caller actually controls the wallet (or other
 * identity) that string is supposed to represent. Anyone who learns or
 * guesses another caller's namespace (e.g. from a leaked log line) gets
 * read/write access to that tenant's leCore memory just by resending it.
 *
 * X-Openzoo-Namespace-Sig / -Signer / -Ts let a caller PROVE namespace
 * ownership: sign `openzoo-namespace:<namespace>:<timestamp>` (see
 * nsauth.ts) with the same wallet key x402 payments already use (Solana
 * ed25519 or EVM secp256k1 — config.ts assets[].network), inside a short
 * replay window. When that checks out, the tenant is hashed from the
 * VERIFIED signer identity, not the caller-supplied string, so the string
 * itself stops being the access-control boundary.
 *
 * Soft launch (cfg.lecoreRequireSignedNamespace, env
 * LECORE_REQUIRE_SIGNED_NAMESPACE, default "0"): unsigned namespaces and
 * invalid signatures still fall through to the pre-existing raw-hash
 * behavior — same as today, just logged — until the flag flips to "1", at
 * which point an unsigned or invalid claim loses the custom namespace
 * (falls back to the shared base tenant) instead of getting one. Never a
 * hard 401: every route that calls tenantFor is a documented free
 * passthrough (see /v1/hrr/bind, /v1/lecore/* below), and refusing the
 * request outright would break that for callers mid-migration — losing
 * isolation gracefully is the correct failure mode here, not losing the
 * endpoint.
 */
function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length ? s : undefined;
}

function tenantFor(cfg: Config, req: IncomingMessage): string {
  // A SESSION is a signature that was already verified, so it is checked
  // first and needs no replay window: the token carries its own expiry. This
  // is what lets a browser wallet bill its own tenant without re-signing
  // every five minutes.
  const sess = tenantFromSession(cfg, headerStr(req, "x-openzoo-session"));
  if (sess) return sess;

  const ns = req.headers["x-openzoo-namespace"];
  if (typeof ns !== "string" || !ns.trim()) return cfg.lecoreTenant;
  const namespace = ns.trim();

  const sig = headerStr(req, "x-openzoo-namespace-sig");
  const signer = headerStr(req, "x-openzoo-namespace-signer");
  const ts = headerStr(req, "x-openzoo-namespace-ts");
  const chain = headerStr(req, "x-openzoo-namespace-chain");
  const signAttempted = !!(sig || signer || ts);

  if (signAttempted) {
    const v = verifySignedNamespace({ namespace, signature: sig, signer, timestamp: ts, chain }, cfg.lecoreNamespaceSigWindowMs);
    if (v.ok && v.signer && v.chain) {
      // Hash signer AND namespace, not just the raw string: binding in the
      // proven signer closes the squatting hole (another wallet signing the
      // identical namespace label lands in a DIFFERENT tenant, since its
      // signer differs), while keeping the namespace in the hash means one
      // wallet can still run several isolated namespaces (e.g. per project)
      // instead of collapsing to a single tenant per wallet.
      const h = createHash("sha256").update(`${v.chain}:${v.signer}:${namespace}`).digest("hex").slice(0, 16);
      return `${cfg.lecoreTenant}_${h}`;
    }
    logEvent({ path: req.url, status: "namespace_sig_invalid", reason: v.reason });
    if (cfg.lecoreRequireSignedNamespace) return cfg.lecoreTenant;
    // soft launch: fall through to the legacy raw-hash path below.
  } else if (cfg.lecoreRequireSignedNamespace) {
    logEvent({ path: req.url, status: "namespace_unsigned", reason: "signing required, no signature sent" });
    return cfg.lecoreTenant;
  } else {
    logEvent({ path: req.url, status: "namespace_unsigned" });
  }

  const h = createHash("sha256").update(namespace).digest("hex").slice(0, 16);
  return `${cfg.lecoreTenant}_${h}`;
}

/**
 * Tenants to try, in order, for an operation that references an EXISTING
 * context id.
 *
 * A context bound before namespacing — or bound by a different tool that does
 * not send the header — lives in the base tenant, and looking it up in the
 * namespaced one fails. MEASURED in production: an agent bound a corpus with
 * a plain script (tenant "zoo"), then asked through the shim (tenant
 * "zoo_<hash>") and every spill bind came back 400, silently disabling the
 * whole feature for that conversation.
 *
 * New contexts are still created in the caller's own tenant — this fallback
 * only makes a PRE-EXISTING id reachable, so isolation holds going forward
 * while nothing bound earlier is orphaned.
 */
function tenantCandidates(cfg: Config, req: IncomingMessage): string[] {
  const own = tenantFor(cfg, req);
  return own === cfg.lecoreTenant ? [own] : [own, cfg.lecoreTenant];
}

/** Run `fn` against each candidate tenant, returning the first that succeeds. */
async function withTenantFallback<T>(
  cfg: Config,
  req: IncomingMessage,
  fn: (c: Config) => Promise<T>,
  ctxHint?: string,
): Promise<T> {
  const tenants = tenantCandidates(cfg, req);
  let last: unknown;
  for (let i = 0; i < tenants.length; i++) {
    try {
      return await fn({ ...cfg, lecoreTenant: tenants[i], lecoreTopK: topKFor(cfg, req, ctxHint),
        lecoreCorpusChunks: ctxHint ? contextChunks.get(ctxHint) : undefined });
    } catch (e) {
      last = e;
      // ContextGoneError here means "not in THIS tenant", which is exactly the
      // case the fallback exists for — keep going. Only the last candidate's
      // failure is the real answer.
    }
  }
  throw last;
}


/**
 * Retrieval breadth for THIS request.
 *
 * top_k is the number of chunks the sidecar returns, and the default is tuned
 * for pointed questions. An exhaustive ask ("list every mention of X") over a
 * large corpus needs far more: MEASURED on an 8.7MB Telegram export (~7,000
 * chunks), top_k=16 surfaced ~19KB and an agent's grep found pump.fun and
 * Solana evidence that retrieval had missed — the corpus held it, the pass
 * never saw it. Callers that know they want breadth can now say so, bounded
 * so nobody can ask for the whole corpus and blow the bill up.
 */
/** Ceiling for an EXPLICIT X-HRR-Top-K. */
const TOP_K_MAX = 256;
/**
 * Ceiling for AUTOMATIC widening. Same as the explicit ceiling on purpose:
 * a low auto-cap makes "adaptive" a lie — it pinned a 500-chunk corpus and a
 * 50,000-chunk corpus to the identical breadth, which is the exact failure
 * (fixed top_k regardless of size) this was meant to remove. The log2 curve
 * below is ALREADY the cost control: it grows sub-linearly forever, so a 100×
 * bigger corpus buys ~3.5× the breadth, never 100×.
 */
const TOP_K_AUTO_MAX = TOP_K_MAX;
/** Chunks bound per context, learned at bind time. Bounded, in-memory, and
 *  per-machine — a miss just means the default, never an error. */
const contextChunks = new Map<string, number>();
function rememberChunks(contextId: string | undefined, bound: number | undefined) {
  if (!contextId || !Number.isFinite(bound as number)) return;
  contextChunks.set(contextId, (contextChunks.get(contextId) ?? 0) + (bound as number));
  if (contextChunks.size > 5000) contextChunks.delete(contextChunks.keys().next().value as string);
}

/**
 * Retrieval breadth SCALED TO THE CORPUS.
 *
 * A fixed top_k is wrong at both ends: 16 chunks is plenty for a 50-chunk
 * corpus and hopeless for a 7,000-chunk one. MEASURED on an 8.7MB Telegram
 * export, top_k=16 put ~19KB of 8.7MB in front of the model and an agent's
 * grep found pump.fun and Solana evidence retrieval had never surfaced.
 *
 * Scales with log2 of corpus size, not linearly: retrieval quality per extra
 * chunk falls off fast, and every chunk is billed prompt tokens, so doubling
 * the corpus should widen the net a little, not double the bill. A caller can
 * always override with X-HRR-Top-K, which wins over everything.
 */
function scaleTopK(base: number, chunks: number): number {
  if (!Number.isFinite(chunks) || chunks <= base) return base;
  const widened = Math.round(base * (1 + Math.log2(chunks / base) / 2));
  return Math.min(Math.max(widened, base), TOP_K_AUTO_MAX);
}

function topKFor(cfg: Config, req: IncomingMessage, contextId?: string): number {
  const raw = Number(req.headers["x-hrr-top-k"]);
  if (Number.isFinite(raw)) return Math.min(Math.max(Math.floor(raw), 1), TOP_K_MAX);
  const known = contextId ? contextChunks.get(contextId) : undefined;
  return known ? scaleTopK(cfg.lecoreTopK, known) : cfg.lecoreTopK;
}

const CLIENT_USABLE_CONTEXT = 128_000_000;
/** One POST cannot carry the whole ceiling: the edge 413s near ~32MiB. */
const MAX_SINGLE_POST_TOKENS = 9_800_000;
const metaDir = join(here, "..", "meta");

const json = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s), ...extra });
  res.end(s);
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// ---------------------------------------------------------------------------
// Observability. One structured "evt" line per chat request — before this,
// the only log was the settle result, so user acquisition was unmeasurable
// server-side. The same event now also goes to the usage store (in-memory ring
// + /data/usage_events.jsonl when a volume is mounted), which is what
// GET /v1/usage and /v1/usage/summary read.
//
// The STORED row keeps the full payer address (public on-chain, and a payer
// has to be able to look themselves up); the LOG LINE keeps the 8-char form it
// has always had. IPs are truncated at capture in both, and no endpoint ever
// returns one.

/** First 8 chars of a payer address — enough to count distinct payers, not to dox one. */
export const shortPayer = (p?: string) => (p ? p.slice(0, 8) : undefined);

/** IPv4 loses its last octet, IPv6 keeps its first three groups. */
export const shortIp = (ip?: string) => {
  if (!ip) return undefined;
  const first = ip.split(",")[0].trim();
  if (first.includes(".")) return first.split(".").slice(0, 3).join(".") + ".x";
  return first.split(":").slice(0, 3).join(":") + "::x";
};

const logEvent = (e: Record<string, unknown>) => {
  const stored: Record<string, unknown> = { ts: new Date().toISOString(), ...e };
  usage.record(stored as usage.UsageEvent); // never throws — telemetry must not fail a request
  console.log("evt", JSON.stringify({ ...stored, payer: shortPayer(stored.payer as string | undefined) }));
};

export function createServerFor(cfg: Config) {
  const resource = `${cfg.publicUrl}/v1/chat/completions`;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", cfg.publicUrl);

    // CORS. A browser or webview client — the Cordova/Seeker shell, or any
    // in-page x402 payer — cannot call this API without it: the preflight is
    // rejected before the real request is ever sent. There is nothing to
    // protect by withholding it, because this gateway has no cookies and no
    // ambient session: every paid call is authorised by an x402 signature and
    // every tenant by a signed namespace, both of which the caller must
    // present explicitly. Same-origin policy was never the boundary here.
    //
    // x-payment / x-hrr-context / the namespace headers must be allowed
    // explicitly — they are not CORS-safelisted — and x-payment-response must
    // be EXPOSED or the client cannot read its own settlement receipt.
    const origin = (req.headers.origin as string | undefined) ?? "*";
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers",
      "content-type, authorization, x-payment, x-hrr-context, x-hrr-top-k, x-hrr-gate, "
      + "x-openzoo-namespace, x-openzoo-namespace-sig, x-openzoo-namespace-signer, "
      + "x-openzoo-namespace-ts, x-openzoo-namespace-chain");
    res.setHeader("access-control-expose-headers", "x-payment-response, x-402-priced-at");
    res.setHeader("access-control-max-age", "86400");
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = renderIndex(cfg);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/token.jpg") {
      const p = join(metaDir, "token.jpg");
      if (!existsSync(p)) return json(res, 404, { error: "no token.jpg" });
      const buf = readFileSync(p);
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": buf.length, "cache-control": "public, max-age=86400" });
      return res.end(buf);
    }

    if (req.method === "GET" && (url.pathname === "/metadata.json" || url.pathname === "/token.json")) {
      const p = join(metaDir, "metadata.json");
      if (!existsSync(p)) return json(res, 404, { error: "no metadata" });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" });
      return res.end(readFileSync(p));
    }

    if (req.method === "GET" && (url.pathname === "/prompt.txt" || url.pathname === "/clanker.txt")) {
      const text = clankerPrompt(cfg);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
      return res.end(text);
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, {
        ok: true,
        rails: cfg.assets.map((a) => a.symbol),
        facilitator: cfg.facilitator,
        // `markup` is the MEDIA lane only now. Text is a rate off OpenRouter's
        // own price, and the whole contract is in `pricing` below.
        markup: cfg.markup,
        pricing: {
          ceiling: "openrouter-direct",
          rateMax: cfg.volume.rateMax,
          rateFloor: cfg.volume.rateFloor,
          volumeScaleUsd: cfg.volume.scaleUsd,
          volumeDecay: cfg.volume.decay,
          volumeWindowDays: cfg.volumeWindowDays,
          lecoreDiscount: cfg.discount,
        },
      });
    }

    // -----------------------------------------------------------------------
    // Usage. Three reads, no writes.
    //
    //   /v1/usage/local    this machine's shard only — the fan-out target, and
    //                      the honest answer to "what does ONE machine know?"
    //   /v1/usage          one payer's own history, merged across machines
    //   /v1/usage/summary  aggregate, non-identifying counters
    //
    // AUTH — deliberately none. The key is a Solana address that is already
    // public on-chain, as are the amounts and the settle transactions, so a
    // token here would only stop the payer from reading their own receipts.
    // What we do NOT publish is anything not already public: no IPs at any
    // resolution, no request bodies, no prompts. The unauthenticated status is
    // stated in the response so nobody assumes these rows are private.
    if (req.method === "GET" && url.pathname === "/v1/usage/local") {
      const payer = url.searchParams.get("payer");
      if (!payer) return json(res, 200, usage.localSummary());
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 5000);
      return json(res, 200, {
        machine: usage.machineId,
        events: usage.localEventsFor(payer, limit).map(usage.publicEvent),
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/usage") {
      const payer = (url.searchParams.get("payer") || (req.headers["x-payer"] as string) || "").trim();
      if (!payer) {
        return json(res, 400, {
          error: "pass ?payer=<solana address> (or an X-Payer header) to see that payer's usage",
          aggregate: `${cfg.publicUrl}/v1/usage/summary`,
        });
      }
      if (payer.length < 6) return json(res, 400, { error: "payer must be at least 6 characters (prefix match allowed)" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 1000);
      const scan = Math.max(limit, 2000); // totals cover more than the rows we print back
      const q = `/v1/usage/local?payer=${encodeURIComponent(payer)}&limit=${scan}`;
      const mine = usage.localEventsFor(payer, scan).map(usage.publicEvent);
      const { results, expected, responded } = await usage.fanout<{ events: usage.PublicEvent[] }>(q);
      const merged = [...mine, ...results.flatMap((r) => r.events || [])]
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      const roll = usage.aggregate(merged);
      return json(res, 200, {
        payer,
        matched: merged.length ? (merged[0].payer === payer ? "exact" : "prefix") : "none",
        ...roll,
        events: merged.slice(0, limit),
        events_returned: Math.min(limit, merged.length),
        events_matched: merged.length,
        coverage: usage.coverage(expected, responded, {
          totals_cover: `the ${merged.length} matched event(s) still retained — not all time`,
          auth: "unauthenticated: keyed on a public Solana address, so anyone who knows the address can read these rows. No IPs, bodies or prompts are returned.",
        }),
      });
    }

    // Stats WITH history. /v1/usage/summary is the live view; this is the one
    // a dashboard can plot, because daily rows are folded as events arrive and
    // persisted to the volume rather than reconstructed from a 10k ring.
    // Build an UNSIGNED payment transaction for a caller that holds a wallet
    // but cannot construct Solana transactions — a phone, a webview, an
    // in-page burner. Free: it reads chain state and returns bytes, it moves
    // nothing. The payer's key never comes near this process.
    if (req.method === "POST" && url.pathname === "/v1/pay/build") {
      const raw = await readBody(req);
      let body: { accept?: AcceptRow; payer?: string };
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
      if (!body.accept || typeof body.payer !== "string") {
        return json(res, 400, {
          error: "pass { accept: <one accepts[] row from the 402>, payer: <base58 pubkey> }",
        });
      }
      if (!String(body.accept.network || "").startsWith("solana:")) {
        return json(res, 400, {
          error: "only solana rows can be built here",
          detail: "EVM rows are EIP-3009 signatures, not transactions — sign those client-side",
        });
      }
      try {
        const built = await buildUnsignedPayment(
          cfg.solanaRpc, body.accept, body.payer, cfg.facilitator,
        );
        logEvent({ path: url.pathname, status: "pay_built", reason: built.wrap ? "wrapped" : "direct" });
        return json(res, 200, built);
      } catch (e) {
        // A bad pubkey or an unknown mint is the CALLER's error; an RPC that
        // will not answer is ours. Both are 400-shaped to the client, but say
        // which so a mobile dev is not left guessing.
        const msg = (e as Error).message.slice(0, 400);
        logEvent({ path: url.pathname, status: "pay_build_failed", reason: msg });
        // A PayBuildError is a diagnosis, not a crash: the payer is short of
        // the underlying, or the asset's acquire recipe did not check out.
        // Surface the code and the numbers so the client can say "you need
        // 0.42 USDC" instead of relaying a simulation failure later.
        if (e instanceof PayBuildError) {
          return json(res, 400, { error: e.message, code: e.code, ...e.detail });
        }
        return json(res, 400, { error: "could not build payment", detail: msg });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/stats") {
      const mine = usage.localSummary();
      const { results } = await usage.fanout<usage.Shard>("/v1/usage/local");
      const merged = usage.mergeShards([mine, ...results]) as { topModels?: { model: string; calls: number }[] };
      return json(res, 200, usage.statsPayload(merged.topModels ?? []));
    }

    if (req.method === "GET" && url.pathname === "/v1/usage/summary") {
      const mine = usage.localSummary();
      const { results, expected, responded } = await usage.fanout<usage.Shard>("/v1/usage/local");
      const merged = usage.mergeShards([mine, ...results]);
      return json(res, 200, {
        app: "x402-tokens",
        ...merged,
        coverage: usage.coverage(expected, responded, {
          identifying: "none — payer counts are distinct 8-char prefixes, never full addresses or IPs",
        }),
      });
    }

    if (req.method === "GET" && (url.pathname === "/.well-known/x402.json" || url.pathname === "/quote")) {
      const dummy = { model: cfg.defaultModel, messages: [{ role: "user", content: "ping" }], max_tokens: 32 };
      const q = await quoteLive(cfg, dummy);
      if (url.pathname === "/quote") return json(res, 200, q);
      return json(res, 200, {
        x402Version: 1,
        name: "x402-tokens",
        facilitator: cfg.facilitator,
        resources: [{
          resource,
          type: "http",
          x402Version: 1,
          description: "Chat completions, image generation and video generation. Priced at the 402 in USD.",
          accepts: requirements(cfg, q, resource),
        }],
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const models = await listModels(cfg.openrouterUrl, cfg.openrouterKey);
      const data = [...models.byId.values()].map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "openrouter",
        // OPENROUTER'S OWN RATE, because that is now the CEILING — this list
        // used to advertise it times 3, which was both the real price and an
        // advertisement for buying elsewhere. `prompt`/`completion` are the
        // most anyone pays; the rate falls from here with trailing spend
        // (see math.ts volumeRate and the `volume` block on every receipt),
        // and falls further whenever leCore compresses the body.
        pricing: {
          prompt: m.prompt,
          completion: m.completion,
          unit: "USD",
          basis: "openrouter-direct",
          note: "ceiling — never more than buying direct; decreases with trailing usage",
          rateFloor: cfg.volume.rateFloor,
        },
        // CLIENT-USABLE context, not the transformer window. Every model here
        // sits behind leCore auto-spill (+ POST /v1/hrr/bind), so a caller can
        // hand any of them a corpus far past its attention limit — that is the
        // whole product. Advertising the raw window tells clients to chunk
        // when they don't have to. The true attention limit stays visible as
        // max_model_len; single-POST ceiling is separate because a body that
        // big 413s at the edge regardless of what the model can hold.
        context_length: CLIENT_USABLE_CONTEXT,
        context_window: CLIENT_USABLE_CONTEXT,
        max_single_post_tokens: MAX_SINGLE_POST_TOKENS,
        ...(m.context ? { max_model_len: m.context } : {}),
      }));
      // MEDIA MODELS BELONG IN THE SAME LIST. A client discovering the zoo
      // through /v1/models would otherwise conclude — correctly, for the text
      // upstream, and wrongly for the gateway — that nothing here makes images
      // or video. They carry `kind` and `endpoint` so a caller knows not to
      // POST them to /v1/chat/completions, and `pricing.unit` instead of
      // per-token rates because that is genuinely how they bill.
      if (cfg.togetherKey) {
        try {
          const media = await listMedia(cfg.togetherUrl, cfg.togetherKey);
          for (const m of media.byId.values()) {
            data.push({
              id: m.id,
              object: "model",
              owned_by: m.organization ?? "together",
              kind: m.kind,
              endpoint: `/v1/${m.kind}s/generations`,
              pricing: {
                unit: m.perMegapixelUsd ? "megapixel" : m.kind === "video" ? "clip" : "image",
                usd: (m.perMegapixelUsd ?? m.exampleUsd) * cfg.markup,
                basis: m.exampleNote,
                markup: cfg.markup,
              },
            } as unknown as typeof data[number]);
          }
        } catch (e) {
          // the text catalog must still serve if the media upstream is down
          console.error(`models: media catalog unavailable (${(e as Error).message})`);
        }
      }
      return json(res, 200, { object: "list", data });
    }

    /* ------------------------------------------------------------------ *
     * MEDIA LANE — image and video.
     *
     * A separate upstream and a separate price model, because neither fits
     * the text path: OpenRouter serves no video at all, and a diffusion job
     * has no prompt/completion tokens to meter. See together.ts.
     *
     * Polling a video job is FREE and comes first: the caller already paid at
     * submit, and charging per poll would make a slow render cost more than a
     * fast one for identical work.
     * ------------------------------------------------------------------ */
    if (req.method === "GET" && url.pathname.startsWith("/v1/videos/")) {
      if (!cfg.togetherKey) return json(res, 503, { error: "media lane not configured" });
      const id = decodeURIComponent(url.pathname.slice("/v1/videos/".length));
      if (!id) return json(res, 400, { error: "job id required" });
      const r = await pollVideo(cfg.togetherVideoUrl, cfg.togetherKey, id);
      logEvent({ path: "/v1/videos/generations/:id", status: "free", ip: shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined) });
      return json(res, r.status, r.json);
    }

    if (req.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/videos/generations")) {
      const kind = url.pathname === "/v1/images/generations" ? "image" : "video";
      if (!cfg.togetherKey) {
        return json(res, 503, { error: { message: "media lane not configured on this gateway", code: "media_unconfigured" } });
      }
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      const ip = shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined);
      // Accept BOTH shapes. Together's video route wants the args nested under
      // `payload` while every other endpoint takes them flat; making callers
      // remember which is which is a papercut we can absorb here.
      const payload = (body.payload && typeof body.payload === "object" ? body.payload : body) as Record<string, unknown>;
      const prompt = payload.prompt ?? body.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) return json(res, 400, { error: "prompt required" });

      const modelId = String(body.model || (kind === "image" ? cfg.defaultImageModel : cfg.defaultVideoModel));
      let m;
      try {
        m = await getMedia(cfg.togetherUrl, cfg.togetherKey, modelId);
      } catch (e) {
        return json(res, 400, { error: { message: (e as Error).message, code: "model_not_found" } });
      }
      if (m.kind !== kind) {
        return json(res, 400, {
          error: { message: `${modelId} is a ${m.kind} model — POST it to /v1/${m.kind}s/generations`, code: "wrong_endpoint" },
        });
      }

      const width = Number(payload.width ?? 1024);
      const height = Number(payload.height ?? 1024);
      const n = Number(payload.n ?? 1);
      const seconds = payload.seconds !== undefined ? Number(payload.seconds) : undefined;
      const priceModel = kind === "image"
        ? (m.perMegapixelUsd ? "per-megapixel" : "per-image")
        : "per-clip-block";
      const upstreamUsd = unitCostUsd(m, { width, height, seconds, n });
      const q = await quoteMediaLive(cfg, modelId, upstreamUsd, priceModel);
      // The x402 `resource` must name what is actually being bought. The
      // module-level one is hardcoded to /v1/chat/completions, and a payment
      // authorization bound to that URL for an image job is a receipt that
      // does not match the work — and, for any facilitator that checks the
      // resource, an outright mismatch.
      const mediaResource = `${cfg.publicUrl}${url.pathname}`;
      const reqs = requirements(cfg, q, mediaResource);
      const bodyBytes = Buffer.byteLength(raw);
      const evt = (status: string, extra: Record<string, unknown> = {}) =>
        logEvent({ path: url.pathname, status, model: modelId, kind, bodyBytes, ip, ...extra });

      const header = req.headers["x-payment"] as string | undefined;
      const tenantKey = tenantFor(cfg, req);
      let paidByCredit = false;
      if (!header && q.billedUsd > 0 && creditBalance(tenantKey) >= q.billedUsd) {
        applyCredit(tenantKey, q.billedUsd);
        paidByCredit = true;
        evt("credit_used", { billedUsd: q.billedUsd });
      }
      if (!header && !paidByCredit) {
        evt("402_quoted", { billedUsd: q.billedUsd, priceModel });
        return json(res, 402, challenge(cfg, q, mediaResource), { "x-402-priced-at": q.pricedAt });
      }
      const v = paidByCredit
        ? { ok: true as const, picked: { asset: "credit", maxAmountRequired: "0" } as never, payer: tenantKey }
        : await verify(cfg, header as string, reqs);
      if (!v.ok || !v.picked) {
        evt("402_invalid", { reason: (v.reason ?? "invalid payment").slice(0, 200) });
        return json(res, 402, challenge(cfg, q, mediaResource, v.reason ?? "invalid payment"));
      }
      const settled = paidByCredit
        ? { success: true, transaction: "credit", payer: tenantKey }
        : (await settle(cfg, header as string, v.picked).catch((e) => ({ success: false, errorReason: (e as Error).message }))) as
          { success?: boolean; errorReason?: string; transaction?: string; payer?: string };
      if (!settled.success) {
        const reason = (settled.errorReason ?? "settle failed").slice(0, 300);
        evt("failed_settle", { payer: settled.payer ?? v.payer, reason, billedUsd: q.billedUsd });
        return json(res, 402, challenge(cfg, q, mediaResource, `payment failed: ${reason}`), { "x-402-priced-at": q.pricedAt });
      }

      const out = kind === "image"
        ? await generateImage(cfg.togetherUrl, cfg.togetherKey, { ...payload, model: modelId, prompt })
        : await submitVideo(cfg.togetherVideoUrl, cfg.togetherKey, modelId, {
            ...payload,
            prompt,
            // seconds is a STRING upstream, and resolution must be 720P/1080P
            // or the job is accepted and then fails — after we have settled.
            seconds: String(payload.seconds ?? 5),
            resolution: normalizeResolution(payload.resolution),
          });

      // Paid, then the upstream failed: credit it back in full. Same contract
      // as the text lane — we cannot un-settle on chain, so the tenant carries
      // the balance forward instead of eating our outage.
      if (out.status < 200 || out.status >= 300) {
        if (q.billedUsd > 0 && !paidByCredit) {
          grantCredit(tenantKey, q.billedUsd, `${kind} upstream ${out.status}`);
        }
        evt("upstream_error", { upstream: out.status, billedUsd: q.billedUsd, credited: !paidByCredit });
        return json(res, out.status, out.json);
      }
      // Media spend counts toward the text lane's volume curve. It is real
      // money spent here, and splitting the two ledgers would mean a tenant
      // who buys $500 of video still pays list price on their first sentence.
      if (q.billedUsd > 0) recordSpend(tenantKey, q.billedUsd, cfg.volumeWindowDays);
      evt("served", { billedUsd: q.billedUsd, upstreamUsd, priceModel, tx: settled.transaction });
      return json(res, 200, out.json, {
        "x-402-billed-usd": String(q.billedUsd),
        "x-402-price-model": priceModel,
      });
    }

    // "The body never ships twice": bind a corpus once, then ask with
    // X-HRR-Context on small bodies. Free — see bindPassthrough for why.
    // PREPAY. Settling on-chain per call is where the latency actually lives:
    // this gateway answers its 402 challenge in ~0.12s, while a full paid call
    // MEASURED 9-37s end to end, almost all of it the payment round trip.
    // Credit is already spent automatically wherever a quote is priced, but
    // nothing could ever ADD credit except an error refund. Buying it in one
    // settlement lets every later call skip verify+settle entirely.
    /**
     * Exchange a namespace signature for a 24h session token.
     *
     * Deliberately mints from tenantFor()'s OWN result rather than
     * re-deriving: whatever proves a tenant elsewhere proves it here, so the
     * two can never drift apart. An unsigned caller resolves to the shared
     * tenant, which must never be handed out as a session — that would mint
     * a credential for everyone's balance.
     */
    if (req.method === "POST" && url.pathname === "/v1/auth/session") {
      // Verify the signature HERE rather than leaning on tenantFor's silent
      // fallback: that path downgrades an expired signature to the shared
      // tenant, and minting a session from it would hand out a credential for
      // everyone's balance.
      const sig = headerStr(req, "x-openzoo-namespace-sig");
      const signer = headerStr(req, "x-openzoo-namespace-signer");
      const ts = headerStr(req, "x-openzoo-namespace-ts");
      const chainH = headerStr(req, "x-openzoo-namespace-chain");
      const nsRaw = req.headers["x-openzoo-namespace"];
      const nsStr = typeof nsRaw === "string" ? nsRaw.trim() : "";
      if (!nsStr || !(sig && signer && ts)) {
        return json(res, 403, {
          error: "a session requires a signed namespace",
          detail: "send x-openzoo-namespace with -sig / -signer / -ts",
        });
      }
      const v = verifySignedNamespace(
        { namespace: nsStr, signature: sig, signer, timestamp: ts, chain: chainH },
        cfg.lecoreNamespaceSigWindowMs,
      );
      if (!v.ok) {
        return json(res, 401, { error: "namespace signature rejected", detail: v.reason });
      }
      const tenant = tenantFor(cfg, req);
      if (tenant === cfg.lecoreTenant) {
        return json(res, 403, {
          error: "a session requires a signed namespace",
          detail: "send x-openzoo-namespace with -sig / -signer / -ts",
        });
      }
      try {
        const { token, expiresAt } = mintSession(cfg, tenant);
        logEvent({ path: url.pathname, status: "session_minted" });
        return json(res, 200, {
          token, expiresAt,
          usage: "send it as x-openzoo-session on any request; it replaces the namespace headers",
        });
      } catch (e) {
        return json(res, 503, { error: "sessions are not configured", detail: (e as Error).message });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/credits") {
      return json(res, 200, { balanceUsd: creditBalance(tenantFor(cfg, req)) });
    }

    if (req.method === "POST" && url.pathname === "/v1/credits/topup") {
      const raw = await readBody(req);
      let body: { usd?: unknown };
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
      const usd = Number(body.usd);
      // NO $500 CEILING. It was an arbitrary guard that mostly stopped people
      // giving us money — someone topping up $5,000 hit a 400 and left. The
      // payment is settled on chain before any credit is granted, so an
      // oversized number costs the caller, not us; there is nothing to protect
      // against by refusing it. Kept configurable so a ceiling can come back
      // without a code change if a real reason for one appears.
      //
      // The FLOOR stays: a top-up below a cent cannot be represented in the
      // rails' 6-decimal units and would settle as a no-op.
      const maxTopUp = Number(process.env.X402_CREDIT_MAX_USD || "0") || Infinity;
      if (!Number.isFinite(usd) || usd < 0.01 || usd > maxTopUp) {
        return json(res, 400, {
          error: Number.isFinite(maxTopUp)
            ? `usd must be a number between 0.01 and ${maxTopUp}`
            : "usd must be a number of at least 0.01",
        });
      }
      const tenantKey = tenantFor(cfg, req);
      // Credit is keyed by TENANT, and an unsigned request resolves to the
      // shared one — topping that up would hand the balance to every other
      // unsigned caller on the gateway. A proven namespace is mandatory here
      // even while it stays optional elsewhere.
      if (tenantKey === cfg.lecoreTenant) {
        return json(res, 403, {
          error: "credits require a signed namespace",
          detail: "send x-openzoo-namespace with -sig / -signer / -ts (openzoo >= 0.44.0 does this automatically)",
        });
      }
      // CREDIT IS SOLD AT FACE VALUE: $25 buys $25 of calls. Any take is
      // already in the price of the calls it pays for, and charging it twice
      // would make prepaying strictly worse than not — which would make this
      // endpoint a trap rather than a latency win.
      //
      // Expressed as markup 1 on the raw USD instead of the old
      // `usd / cfg.markup` divide-to-cancel. Same number today; but the old
      // form only held while cfg.markup was a single global constant, and it
      // is now a media-lane-only knob that pricing changes are free to move.
      // Face value should not be a property of what X402_MARKUP happens to be.
      // LIVE PRICES, not face value. quoteUnits falls back to `stableUsd ?? 1`,
      // so every non-stable asset was quoted at ONE DOLLAR: $5 of credit cost
      // 5 TOKEN (~$0.0012) or 5 LEOS — a ~4,000x and ~7,000x discount, and
      // credit is spendable at full value. The chat path never had this
      // because it goes through applyLiveSpots; top-up called quoteUnits
      // directly and skipped it.
      //
      // quoteMediaLive is exactly applyLiveSpots(quoteUnits(...)), which also
      // DROPS any asset with no believable spot rather than inventing one —
      // so a dead pool removes that row instead of underpricing it.
      const q = await quoteMediaLive(cfg, "credit", usd, "prepay", 1);
      const resource = `${cfg.publicUrl}/v1/credits/topup`;
      const ip = shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined);
      const evt = (status: string, extra: Record<string, unknown> = {}) =>
        logEvent({ path: url.pathname, status, ip, ...extra });

      const header = req.headers["x-payment"] as string | undefined;
      if (!header) {
        evt("402_quoted", { billedUsd: q.billedUsd, topupUsd: usd });
        return json(res, 402, challenge(cfg, q, resource), { "x-402-priced-at": q.pricedAt });
      }
      const v = await verify(cfg, header, requirements(cfg, q, resource));
      if (!v.ok || !v.picked) {
        evt("402_invalid", { reason: (v.reason ?? "invalid payment").slice(0, 200) });
        return json(res, 402, challenge(cfg, q, resource, v.reason ?? "invalid payment"));
      }
      const settled = await settle(cfg, header, v.picked)
        .catch((e) => ({ success: false, errorReason: (e as Error).message })) as
        { success?: boolean; errorReason?: string; transaction?: string; payer?: string };
      if (!settled.success) {
        const reason = (settled.errorReason ?? "settle failed").slice(0, 300);
        evt("failed_settle", { reason, topupUsd: usd });
        return json(res, 402, challenge(cfg, q, resource, `payment failed: ${reason}`));
      }
      // Grant only AFTER settlement succeeds — never on the strength of a
      // payment header alone.
      grantCredit(tenantKey, usd, "prepay");
      const balanceUsd = creditBalance(tenantKey);
      evt("topup_ok", { topupUsd: usd, balanceUsd, tx: settled.transaction });
      return json(res, 200, { ok: true, creditedUsd: usd, balanceUsd, tx: settled.transaction });
    }

    if (req.method === "POST" && url.pathname === "/v1/hrr/bind") {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      const { status, payload } = await bindPassthrough({ ...cfg, lecoreTenant: tenantFor(cfg, req) }, body);
      // Learn the corpus size so later asks against this context scale their
      // retrieval breadth to it (see scaleTopK).
      rememberChunks((payload as { context_id?: string }).context_id, (payload as { bound?: number }).bound);
      logEvent({
        path: url.pathname,
        status: "free",
        bodyBytes: Buffer.byteLength(raw),
        ip: shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined),
        http: status,
      });
      return json(res, status, payload);
    }

    // Right-to-forget. Free, and it really removes: see ablatePassthrough.
    if (req.method === "POST" && url.pathname === "/v1/hrr/ablate") {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
      const ctxHint = typeof body.context_id === "string" ? body.context_id : undefined;
      const { status, payload } = await withTenantFallback(
        cfg, req,
        (c) => ablatePassthrough(c, body as { context_id?: string; item_ids?: string[] }),
        ctxHint,
      );
      logEvent({ path: url.pathname, status: "free", bodyBytes: Buffer.byteLength(raw),
                 ip: shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined),
                 http: status });
      return json(res, status, payload);
    }

    // OUROBOROS memory — the model's durable external partition (leCore ZOO.md §8).
    // Free passthroughs like /v1/hrr/bind; per-tenant via x-openzoo-namespace.
    // leCore faculties — ZOO.md §1. Free, like /v1/models: a catalog you must
    // pay to read is a catalog models will hand-roll around.
    if (req.method === "POST" && /^\/v1\/lecore\/(find|describe|invoke)$/.test(url.pathname)) {
      const op = url.pathname.split("/").pop() as "find" | "describe" | "invoke";
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
      const tcfg = { ...cfg, lecoreTenant: tenantFor(cfg, req) };
      const { status, payload } = await lecoreCall(tcfg, op, body);
      logEvent({ path: url.pathname, status: "free", bodyBytes: Buffer.byteLength(raw),
                 ip: shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined),
                 http: status });
      return json(res, status, payload);
    }

    if (req.method === "POST" && (url.pathname === "/v1/memory/write" || url.pathname === "/v1/memory/search")) {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
      const tcfg = { ...cfg, lecoreTenant: tenantFor(cfg, req) };
      const { status, payload } = url.pathname === "/v1/memory/write"
        ? await memoryWrite(tcfg, body as { text?: string; tags?: string[] })
        : await memorySearch(tcfg, body as { query?: string; top?: number; tags?: string[] });
      logEvent({
        path: url.pathname,
        status: "free",
        bodyBytes: Buffer.byteLength(raw),
        ip: shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined),
        http: status,
      });
      return json(res, status, payload);
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let body: { model?: string; messages?: unknown; max_tokens?: number; stream?: boolean };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      if (!body.messages) return json(res, 400, { error: "messages required" });

      // WEB SEARCH ON, FOR EVERY MODEL, BY DEFAULT.
      //
      // OpenRouter's `web` plugin is search-then-inject middleware, so it works
      // on every model in the catalog — "does this model support search" is not
      // a real question here, and nothing needs rerouting to a search-native
      // model. Without it an agent on this gateway answers "I don't have direct
      // access to external tools like search engines" and confidently fails any
      // question about the last year, which is the single most visible way the
      // zoo looks broken next to a chat app.
      //
      // Opt out per request with plugins: [] (an explicit empty array), or
      // globally with WEB_SEARCH_DEFAULT=0. An explicit plugins array is always
      // respected as-is — we only ADD when the caller said nothing at all.
      //
      // It is not free: a flat $0.007 upstream per request (see WEB_PLUGIN_USD),
      // which quoteRequest adds to the upstream cost so the 402 reflects it.
      if (cfg.webSearchDefault && (body as { plugins?: unknown }).plugins === undefined) {
        (body as { plugins?: unknown }).plugins = [{ id: "web", max_results: cfg.webMaxResults }];
      }
      const bodyBytes = Buffer.byteLength(raw);
      const ip = shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined);

      // leCore in front. MUST precede quoteLive: the 402 is priced from
      // estimateTokens(messages), so spilling after the quote would bill the
      // caller 3x on the whole book and hand them the discount they already
      // paid for. Thread key lets a caller keep one holographic context.
      let headerCtx = req.headers["x-hrr-context"] as string | undefined;
      // ZERO-INTEGRATION DEDUP: clients that never heard of X-HRR-Context but
      // re-send the same fat prefix every call get it bound on sighting #2 and
      // stripped+attached from sighting #3 on. Fail-open by construction —
      // no match means nothing changes.
      let dedupStripped = 0;
      if (!headerCtx) {
        try {
          const dd = dedupObserve(cfg, tenantFor(cfg, req), body as { messages?: Array<{ role?: string; content?: unknown }> });
          if (dd.contextId && dd.messages?.length) {
            headerCtx = dd.contextId;
            (body as { messages?: unknown }).messages = dd.messages;
            dedupStripped = dd.strippedChars ?? 0;
          }
        } catch { /* dedup must never break a request */ }
      }
      // body.user is a stock OpenAI field: grok and Claude Code set it to a
      // username / uuid, NOT a context id. Feeding that to the spill bind as a
      // context_id makes the sidecar reject the append with 400 (invalid
      // context_id format), spill fails open, and the whole body ships
      // unspilled at full price — MEASURED: 45k-token bodies billed unspilled.
      // Only accept it as a thread key if it is actually one of our ids.
      const userThread = typeof (body as { user?: unknown }).user === "string"
        ? (body as { user: string }).user
        : undefined;
      const thread = headerCtx || (userThread?.startsWith("ctx_") ? userThread : undefined);
      let prepped: Record<string, unknown> = body as Record<string, unknown>;
      let lecoreInfo: LecoreResult["info"];
      try {
        const r = thread
          ? await withTenantFallback(cfg, req, (c) => prepare(c, body as Record<string, unknown>, thread), thread)
          : await prepare({ ...cfg, lecoreTenant: tenantFor(cfg, req), lecoreTopK: topKFor(cfg, req) }, body as Record<string, unknown>, thread);
        prepped = r.body;
        lecoreInfo = r.info;
      } catch (e) {
        return json(res, 503, { error: (e as Error).message });
      }

      // ATTACH: an EXPLICIT X-HRR-Context on a body too small to spill means
      // "the corpus is already bound — recall against it". Header only:
      // body.user is a stock OpenAI field and treating it as a context id
      // would 404 every ordinary small request that happens to set it.
      // A dead context 404s BEFORE the 402 so a stale manifest re-binds free.
      if (headerCtx && !lecoreInfo.engaged && cfg.lecoreUrl) {
        try {
          const a = await withTenantFallback(cfg, req, (c) => attach(c, prepped, headerCtx), headerCtx);
          prepped = a.body;
          lecoreInfo = a.info;
        } catch (e) {
          if (e instanceof ContextGoneError) {
            return json(res, 404, { error: { message: "hrr_context_not_found", code: "context_not_found", context_id: headerCtx } });
          }
          return json(res, 503, { error: (e as Error).message });
        }
      }

      // price the counterfactual when leCore engaged: the caller pays a fraction of
      // what this body would have cost them direct, not a markup on the slice.
      //
      // FAIL-OPEN MUST NOT BILL A MARKUP. If the sidecar times out on a fat body
      // we forward the whole thing — and the markup path would then charge
      // X402_MARKUP x the UNSPILLED cost, i.e. ~6x what buying direct costs, for
      // a call where our memory did nothing. MEASURED: a 967,288-token body
      // failed open at the 120s timeout. When leCore was supposed to engage and
      // didn't, price at direct (markup 1) — we still cover cost, and we never
      // punish a caller for our own outage.
      //
      // THIS IS NOW STRUCTURAL, not a special case: quoteRequest caps every
      // text price at the like-for-like direct cost, and on a fail-open the
      // body we forward IS the body they would have bought, so the cap already
      // equals the old `markup: 1` override. The override is therefore gone
      // (it multiplied a field the text lane no longer reads) and the flag is
      // kept for TELEMETRY — a fail-open used to be invisible in the event log
      // except as a surprising bill.
      const shouldHaveEngaged = Boolean(cfg.lecoreUrl)
        && !lecoreInfo.engaged
        && String(lecoreInfo.reason || "").startsWith("fail-open");
      // Tenant resolved BEFORE the quote now: the price depends on it. Same
      // key credits.ts and the sidecar partition by.
      const tenantKey = tenantFor(cfg, req);
      const q = await quoteLive(
        cfg,
        prepped,
        // ATTACH prices against the whole bound corpus, not tokensBefore. In
        // attach the ask is tiny and the recalled slice is ADDED, so
        // tokensBefore < what we forward and quote.ts's
        // `counterfactualTokens > promptTokens` test could never pass —
        // every attach call fell back to plain markup and reported a saving
        // of exactly 1/markup. SPILL is unchanged: there tokensBefore IS the
        // pre-compression body, which is the right counterfactual.
        lecoreInfo.engaged ? (lecoreInfo.corpusTokens ?? lecoreInfo.tokensBefore) : undefined,
        // TALK MORE, PAY LESS. What this tenant has already spent here in the
        // trailing window sets the fraction of OpenRouter's own price they
        // pay. A new tenant is at the ceiling (1x direct, never above it).
        trailingSpend(tenantKey, cfg.volumeWindowDays),
      );
      const reqs = requirements(cfg, q, resource);
      // one analytics line per chat request, whatever the outcome
      const evt = (status: string, extra: Record<string, unknown> = {}) => logEvent({
        path: url.pathname,
        status,
        model: String(body.model || cfg.defaultModel),
        bodyBytes,
        ip,
        tokens_before: lecoreInfo.tokensBefore,
        tokens_after: lecoreInfo.tokensAfter,
        // WHY leCore did not engage. Without this a fail-open is invisible in
        // telemetry — it looks identical to "engaged and forwarded", and the
        // only symptom is a surprising bill.
        lecore_reason: lecoreInfo.engaged ? undefined : lecoreInfo.reason,
        lecore_fail_open: shouldHaveEngaged || undefined,
        spill_tokens: lecoreInfo.spilledTokens,
        recalled: lecoreInfo.recalled,
        corpus_reuse: lecoreInfo.mode === "attach" || undefined,
        ...extra,
      });
      const header = req.headers["x-payment"] as string | undefined;
      // PROVIDER-ERROR CREDITS: settle-first means an upstream error is money
      // already taken (measured: $0.088 settled for an xAI auth-error body).
      // Those amounts become tenant credit; a quote fully covered by credit
      // serves WITHOUT payment. Optimistic consumption — see credits.ts.
      // (tenantKey is resolved above the quote — the price depends on it.)
      let paidByCredit = false;
      if (!header && q.billedUsd > 0 && creditBalance(tenantKey) >= q.billedUsd) {
        applyCredit(tenantKey, q.billedUsd);
        paidByCredit = true;
        evt("credit_used", { billedUsd: q.billedUsd });
      }
      if (!header && !paidByCredit) {
        evt("402_quoted", { billedUsd: q.billedUsd, dedup_stripped: dedupStripped || undefined });
        return json(res, 402, challenge(cfg, q, resource), { "x-402-priced-at": q.pricedAt });
      }
      const v = paidByCredit
        ? { ok: true as const, picked: { asset: "credit", maxAmountRequired: "0" } as never, payer: tenantKey }
        : await verify(cfg, header as string, reqs);
      if (!v.ok || !v.picked) {
        evt("402_invalid", { reason: (v.reason ?? "invalid payment").slice(0, 200) });
        return json(res, 402, challenge(cfg, q, resource, v.reason ?? "invalid payment"));
      }

      // SETTLE BEFORE THE UPSTREAM CALL. The old order (serve, then settle)
      // made every failed settle free inference: 8 "Simulation failed" settles
      // in the 2026-08-14 logs each shipped a full model response and collected
      // nothing. It also widened the blockhash window — the payer signs a
      // recent blockhash, and burning upstream-inference seconds before /settle
      // pushed slow calls past expiry (the empty-logs simulation failure).
      // No confirmed settle, no tokens. The trade: a call whose upstream then
      // errors has already settled — the receipt names the tx so it can be
      // made right, which beats free inference on every payment that cannot
      // clear.
      const settled = paidByCredit
        ? { success: true, transaction: "credit", payer: tenantKey }
        : (await settle(cfg, header as string, v.picked).catch((e) => ({ success: false, errorReason: (e as Error).message }))) as
        { success?: boolean; errorReason?: string; transaction?: string; payer?: string };
      console.log("settle", JSON.stringify(settled));
      if (!settled.success) {
        const reason = (settled.errorReason ?? "settle failed").slice(0, 300);
        evt("failed_settle", { payer: settled.payer ?? v.payer, reason, billedUsd: q.billedUsd });
        // clean 402, retryable: the client rebuilds (fresh blockhash / topped-up
        // balance) and pays against the re-quote below.
        return json(res, 402, challenge(cfg, q, resource, `payment failed: ${reason}`), { "x-402-priced-at": q.pricedAt });
      }

      // x-ai/* goes straight to xAI, not through OpenRouter's BYOK passthrough
      // (which 400s on a key it doesn't control — measured, see credits.ts).
      // Pricing is untouched: quoteRequest/quoteLive already read OpenRouter's
      // catalog price for this model id, and that is what the caller is
      // billed regardless of which upstream serves the completion. `plugins`
      // is an OpenRouter-only field (the web-search injection above) and does
      // not exist on xAI's API, so it is dropped on this path.
      const modelId = String((prepped as { model?: string }).model ?? "");
      const isDirectXai = modelId.startsWith("x-ai/") && !!cfg.xaiKey;
      const callUpstream = (b: Record<string, unknown>) => isDirectXai
        ? complete(cfg.xaiUrl, cfg.xaiKey, { ...b, plugins: undefined, model: modelId.slice("x-ai/".length) }, cfg.publicUrl)
        : complete(cfg.openrouterUrl, cfg.openrouterKey, b, cfg.publicUrl);

      let out = await callUpstream({ ...prepped, stream: false });

      // PAID-FOR-SILENCE GUARD. A reasoning model can spend the WHOLE
      // max_tokens budget on hidden reasoning and get truncated before it
      // emits one visible character. REPRODUCED: google/gemini-3.7-flash,
      // max_tokens=20, prompt "Reply with exactly the word ALIVE" ->
      // content:"" finish_reason:"length" completion_tokens:17 with 251 chars
      // of reasoning; at max_tokens=200 the same call answers "ALIVE". Users
      // saw ~1/3 of calls come back empty, each one billed (one liveness probe
      // cost $0.039 and returned nothing).
      //
      // We settle BEFORE the upstream call, on purpose (see above), so the
      // money is already taken and a refund is not on the table. The honest
      // remedy is to deliver what was paid for: retry ONCE with real headroom
      // and eat the extra upstream cost ourselves. Only on the exact signature
      // -- empty content AND finish_reason "length" -- so a legitimately empty
      // answer or a stop-finished one is never re-run.
      const emptyTruncated = (r: { status: number; json?: unknown }) => {
        if (r.status < 200 || r.status >= 300) return false;
        const ch = ((r.json as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> })
          ?.choices ?? [])[0];
        return !!ch && ch.finish_reason === "length" && !(ch.message?.content || "").trim();
      };
      // ONLY RETRY WHEN THE CAP WAS PLAUSIBLY THE PROBLEM. The first version of
      // this guard fired on ANY empty+length and re-ran at 4x max_tokens up to
      // 4096. On an agent asking for a multi-file emission that DOUBLED an
      // already-slow call: measured on the ttfx port, a 4000-token request
      // against a 396k-token bound context returned empty, and the next step
      // hung past 900s and killed the harness. A repair that can double the
      // slowest call in the system is worse than the failure it repairs.
      //
      // So: retry only a SMALL cap (where reasoning genuinely eats the whole
      // budget before any visible token), bound the bump absolutely, and never
      // fire when the caller already asked for room.
      const askedTok = Number((prepped as { max_tokens?: number }).max_tokens ?? 256);
      if (emptyTruncated(out) && askedTok < 512) {
        const roomier = 1024;
        console.log("retry", JSON.stringify({ reason: "empty_truncated", asked: askedTok, roomier }));
        const retry = await callUpstream({ ...prepped, stream: false, max_tokens: roomier });
        if (!emptyTruncated(retry) && retry.status >= 200 && retry.status < 300) out = retry;
      } else if (emptyTruncated(out)) {
        // Large caps: do NOT re-run. Say so in the response instead of
        // returning a silent void the caller pays for and cannot diagnose.
        console.log("empty_large_cap", JSON.stringify({ asked: askedTok }));
      }

      // Upstream handed back an error object after we took payment: full
      // billed amount becomes tenant credit, and the receipt says so.
      const providerErrored = !!(out.json as { error?: unknown })?.error
        && !((out.json as { choices?: unknown[] })?.choices?.length);
      if (providerErrored && q.billedUsd > 0 && !paidByCredit) {
        grantCredit(tenantKey, q.billedUsd, "provider_error");
      }
      // VOLUME LEDGER. Counts toward the tenant's next price — see spend.ts.
      // Skipped on exactly the calls whose money is being handed straight back
      // as credit: that credit gets spent on a later call which IS counted, and
      // counting both would let a provider outage buy a discount twice.
      if (q.billedUsd > 0 && !(providerErrored && !paidByCredit)) {
        recordSpend(tenantKey, q.billedUsd, cfg.volumeWindowDays);
      }
      evt(out.status >= 200 && out.status < 300 ? "paid_200" : "paid_upstream_error", {
        payer: settled.payer ?? v.payer,
        upstream: out.status,
        billedUsd: q.billedUsd,
        // WHAT IT COST US, and WHAT IT WOULD HAVE COST THE CALLER DIRECT.
        // Without these two the usage store can only ever answer "revenue" —
        // margin and the leCore saving are unrecoverable after the fact,
        // because both are derived from the quote and the quote is gone.
        cogsUsd: q.openrouterUsd,
        directUsd: q.directUsd,
        tx: settled.transaction, // public on-chain; the receipt a caller can verify themselves
      });
      return json(res, out.status, {
        ...(out.json as object),
        x402: {
          billedUsd: q.billedUsd,
          pricing: q.pricing,
          directUsd: q.directUsd,
          // savesVsDirect is a MULTIPLE (2 = you paid half). It is now always
          // >= 1 because billedUsd <= directUsd by construction — it used to
          // read 0.3333 on every flat-3x call, which any UI rendering it as a
          // saving turned into a 3x overcharge displayed as a win. The three
          // fields below are the unambiguous fractions; prefer them.
          savesVsDirect: q.savesVsDirect,
          rate: q.rate,
          savedPct: q.savedPct,
          savedUsd: q.savedUsd,
          // WHY this rate: trailing spend, the curve's floor, the window.
          // A caller can see what more usage buys instead of guessing.
          volume: q.volume,
          // OUR upstream cost. Clients were deriving it as billedUsd/markup,
          // which is only right on a straight-markup call: under counterfactual
          // pricing billedUsd is min(direct×discount, markupUsd), so that
          // division understates cost and overstates margin. Report it instead
          // of making every client re-derive it wrongly.
          cogsUsd: q.openrouterUsd,
          markup: q.pricing === "markup" ? q.markup : undefined,
          paid: v.picked.asset,
          lecore_fail_open: shouldHaveEngaged || undefined,
          amount: v.picked.maxAmountRequired,
          settle: settled,
          lecore: lecoreInfo,
          dedup_stripped_chars: dedupStripped || undefined,
          credit: paidByCredit ? { covered: q.billedUsd } : undefined,
          refund_credit: providerErrored && !paidByCredit
            ? { usd: q.billedUsd, reason: "provider_error", note: "auto-applied to your next calls" }
            : undefined,
        },
      });
    }

    return json(res, 404, { error: "not found" });
  };

  return {
    handler,
    listen(port = cfg.port) {
      usage.initUsage(); // notices the volume (if any) and replays its tail into the ring
      usage.initDaily();  // load persisted daily rollups so history survives deploys
      // Batch the rollup write instead of one whole-file write per event.
      // unref'd so it can never hold the process open by itself.
      setInterval(() => usage.flushDaily(), 10_000).unref();
      for (const sig of ["SIGTERM", "SIGINT"] as const) {
        process.once(sig, () => { usage.flushDaily(); process.exit(0); });
      }
      const s = createServer((req, res) => {
        handler(req, res).catch((e) => json(res, 500, { error: (e as Error).message.slice(0, 160) }));
      });
      // "::" = dual stack (IPv4-mapped still accepted). 0.0.0.0 bound IPv4 only,
      // which left the machine unreachable on its Fly 6PN address — the usage
      // fan-out between machines talks over exactly that address.
      s.listen(port, process.env.BIND_HOST || "::", () => console.log(`x402-tokens :${port}  ${cfg.publicUrl}`));
      return s;
    },
  };
}

export { loadConfig };
void extname;
