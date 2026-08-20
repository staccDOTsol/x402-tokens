/**
 * leCore in front of the passthrough.
 *
 * Moose: "the best way to run a model is with a holographic transformer
 * anyway... We add leCore in front and boom" -> every model on the zoo gets
 * HRR memory, without the provider knowing.
 *
 * WHY THIS RUNS BEFORE THE QUOTE, not before the upstream fetch: server.ts
 * prices the 402 from `estimateTokens(body.messages)`. If the spill happened
 * after the quote, a user pasting a book would be billed 3x on the WHOLE book
 * and only then get the benefit. Spilling first is the entire economic point:
 * the 402 names 3x of the *retrieved slice*, so long context on this zoo is
 * structurally cheaper than the same model on OpenRouter direct.
 *
 * FAIL-OPEN, deliberately, and it differs from the lecore gateway. app.py is
 * fail-closed (never answer without attach) because there the memory IS the
 * product. Here memory is an upgrade on a passthrough someone already paid
 * for, so an HRR outage must not take the whole zoo down. Set
 * LECORE_REQUIRED=1 to make it fail-closed instead. Either way the outcome is
 * reported in `x402.lecore` -- a silent downgrade would be a lie about what
 * was billed.
 */
import type { Config } from "./config.js";
import { estimateTokens } from "./math.js";
import { applySpillCut, type Msg as SpillMsg } from "./spill.js";

export interface LecoreResult {
  /** body to forward + price. Unchanged when leCore did not engage. */
  body: Record<string, unknown>;
  info: {
    engaged: boolean;
    /** "spill" = big body carved + bound here; "attach" = caller referenced a
     *  pre-bound context via X-HRR-Context and we only recalled. */
    mode?: "spill" | "attach";
    reason?: string;
    contextId?: string;
    tokensBefore: number;
    tokensAfter: number;
    spilledTokens?: number;
    /** attach only: how many passages recall returned. */
    recalled?: number;
    /** attach only: tokens in the WHOLE bound corpus — the counterfactual
     *  basis, i.e. what the caller would have had to send without leCore. */
    corpusTokens?: number;
  };
}

/** The context named in X-HRR-Context no longer exists on the sidecar
 *  (wiped, expired, or never bound here). Surfaced as HTTP 404 BEFORE the 402
 *  so a client with a stale manifest can re-bind without paying. */
export class ContextGoneError extends Error {
  constructor(public contextId: string) {
    super(`hrr context not found: ${contextId}`);
  }
}

interface Msg { role?: string; content?: unknown }

const text = (c: unknown): string =>
  typeof c === "string" ? c
    : Array.isArray(c) ? c.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n")
      : "";

/** The ASK inside a body that also carries corpus: last paragraph, capped.
 *  Used only as the retrieval query — the model still receives the full tail. */
export function askOf(s: string, max: number): string {
  const t = (s || "").trimEnd();
  if (t.length <= max) return t.trim();
  const para = t.split(/\n\s*\n/).pop() || t;
  return (para.length <= max ? para : para.slice(-max)).trim();
}



/**
 * CALIBRATED HONESTY ABOUT COVERAGE — leCore docs/ZOO.md §2.
 *
 * Retrieval hands the model top_k chunks of a corpus that may hold thousands,
 * and the model has no way to know which. MEASURED in production: asked to
 * "list every mention of pump.fun" over a 7,000-chunk corpus at top_k=16, the
 * model answered confidently and completely — and an agent's grep then found
 * evidence retrieval had never surfaced. The corpus held it; the pass never
 * saw it; nothing in the prompt said so.
 *
 * A silent under-answer is the worst failure a retrieval system has, because
 * it is indistinguishable from a correct one. So the preamble now STATES the
 * coverage, and when it is partial it tells the model to say so rather than
 * imply completeness. This is the cheap half of leCore's abstention story:
 * not a promised false-alarm rate, just a refusal to let the model imply a
 * completeness it cannot have. Costs ~40 tokens.
 */
export function coverageNote(recalled: number, chunks?: number): string {
  if (!recalled) return "";
  if (!Number.isFinite(chunks as number) || (chunks as number) <= 0) {
    return `\n\n[retrieval: ${recalled} passages, ranked by relevance. This is a SELECTION, not the whole corpus — if the question asks for every/all instances, say that your answer covers only what was retrieved.]`;
  }
  const total = chunks as number;
  const pct = Math.min(100, Math.round((recalled / total) * 100));
  if (recalled >= total) {
    return `\n\n[retrieval: all ${total} passages of this corpus are present — exhaustive answers are supported.]`;
  }
  return `\n\n[retrieval: ${recalled} of ~${total} passages (${pct}%), ranked by relevance. This is a SELECTION. Exhaustive claims ("every", "all", "none") are NOT supported by this slice — answer from what is here and say plainly that coverage was partial. The caller can widen it with a larger top_k.]`;
}

/** tool_call ids DEFINED by the assistant messages in a set. */
function definedCallIds(msgs: Msg[]): Set<string> {
  const ids = new Set<string>();
  for (const m of msgs) {
    const calls = (m as { tool_calls?: Array<{ id?: string }> }).tool_calls;
    if (Array.isArray(calls)) for (const c of calls) if (c?.id) ids.add(c.id);
  }
  return ids;
}

/**
 * A tool RESULT and the assistant tool_call that spawned it are one atomic
 * unit — split them and the upstream rejects with
 *   400 "No tool call found for function call output with call_id …"
 * because every function_call_output must match an earlier function_call of
 * the same id. The newest-first split can leave a result LIVE while its call
 * SPILLED (the call is older, so it lands in spill; the result is newer, so it
 * stays live). MEASURED: an agent run compacted 19,738->11,025 tokens and the
 * orphaned result 400'd the whole turn.
 *
 * Fix: pull messages back from the end of spill into live until every live
 * tool result's defining call is also live. Costs a few tokens of compaction,
 * never correctness.
 */
export function keepToolPairs(live: Msg[], spill: Msg[]): { live: Msg[]; spill: Msg[] } {
  const callIdOf = (m: Msg) => (m as { tool_call_id?: string }).tool_call_id;
  const dangles = (l: Msg[]) => {
    const defined = definedCallIds(l);
    return l.some((m) => m.role === "tool" && callIdOf(m) && !defined.has(callIdOf(m) as string));
  };
  let l = live;
  let s = spill;
  while (s.length && dangles(l)) {
    l = [s[s.length - 1], ...l];
    s = s.slice(0, -1);
  }
  return { live: l, spill: s };
}

/** Newest-first walk: keep whole recent turns inside the live window, spill the rest. */
function split(msgs: Msg[], keepTokens: number): { live: Msg[]; spill: Msg[] } {
  const live: Msg[] = [];
  let used = 0;
  let i = msgs.length - 1;
  for (; i >= 0; i--) {
    const t = estimateTokens([msgs[i]]);
    if (used + t > keepTokens && live.length > 0) break;
    live.unshift(msgs[i]);
    used += t;
  }
  return { live, spill: msgs.slice(0, i + 1) };
}

async function postRaw(url: string, payload: unknown, ms: number, key?: string): Promise<{ status: number; json: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function post(url: string, payload: unknown, ms: number, key?: string): Promise<unknown> {
  const { status, json } = await postRaw(url, payload, ms, key);
  if (status < 200 || status >= 300) throw new Error(`${url} -> ${status}`);
  return json;
}

export async function prepare(
  cfg: Config,
  body: Record<string, unknown>,
  thread?: string,
): Promise<LecoreResult> {
  const msgs = (Array.isArray(body.messages) ? body.messages : []) as Msg[];
  const before = estimateTokens(body.messages);
  const off = (r: string): LecoreResult => ({ body, info: { engaged: false, reason: r, tokensBefore: before, tokensAfter: before } });

  if (!cfg.lecoreUrl) return off("LECORE_HRR_URL unset");
  if (before <= cfg.lecoreSpillTokens) return off("under spill threshold");

  // TOOL CONVERSATIONS ARE FORWARDED INTACT. keepToolPairs keeps a call with
  // its result across the spill boundary, but that is not enough for a
  // provider whose tool API is STATEFUL (OpenAI/Azure Responses API): removing
  // ANY message and prepending a recalled-context system message invalidates
  // the server-side correlation, and the continuation 400s with
  //   "No tool call found for function call output with call_id …"
  // MEASURED: multi-turn agent runs on openai/gpt-5.6-sol-pro failed
  // repeatedly while every synthetic spill reproduced clean. So when tool
  // calls are present we do not spill at all — the body forwards whole and the
  // fail-open pricing (markup 1) means the caller is not overcharged for it.
  const hasTools = msgs.some((m) =>
    Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)
    || m.role === "tool"
    || (Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(
      (b) => b?.type === "tool_use" || b?.type === "tool_result")));

  // STRUCTURE-PRESERVING SPILL for tool conversations.
  //
  // A stateful provider (OpenAI/Azure Responses API) correlates tool calls by
  // id; removing a spilled message or reordering the array breaks that and the
  // continuation 400s "No tool call found for function call output". But the
  // provider does NOT care how LONG a tool result is — only that its envelope
  // (role, tool_call_id, order) is present. So keep EVERY message in place and
  // only shrink the heavy CONTENT of older ones, binding the full text to the
  // sidecar and replacing it with a short marker. Nothing is removed => nothing
  // can be orphaned; the big tokens (accumulated tool-result dumps) still leave
  // the request => the discount survives.
  if (hasTools) {
    const KEEP_TAIL = 4;               // most recent messages stay verbatim
    const SHRINK_OVER = 400;           // only shrink content longer than this
    const HEAD = 200;                  // chars of the original head to retain
    const cut = Math.max(0, msgs.length - KEEP_TAIL);
    const oldMsgs = msgs.slice(0, cut);
    const items = oldMsgs
      .map((m, i) => ({ text: `[${i}] ${m.role ?? "user"}: ${text(m.content)}` }))
      .filter((it) => it.text.trim().length > 0);
    if (!items.length) return off("nothing older than the live window");
    try {
      const bind = (await post(`${cfg.lecoreUrl}/internal/v1/hrr/bind`,
        { tenant_id: cfg.lecoreTenant, items, chunk: true,
          chunk_max_chars: cfg.lecoreChunkChars, chunk_overlap: cfg.lecoreChunkOverlap,
          ...(thread ? { context_id: thread } : {}) }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as { context_id?: string };
      const contextId = bind?.context_id;
      if (!contextId) throw new Error("bind returned no context_id");
      const query = askOf(text(msgs[msgs.length - 1]?.content), cfg.lecoreQueryChars);
      const rec = (await post(`${cfg.lecoreUrl}/internal/v1/hrr/recall`,
        { tenant_id: cfg.lecoreTenant, context_id: contextId, query, top_k: cfg.lecoreTopK },
        cfg.lecoreTimeoutMs, cfg.lecoreKey)) as { items?: Array<{ text?: string }> };
      const slice = (rec?.items ?? []).map((x) => x?.text ?? "").filter(Boolean).join("\n---\n");
      const MARK = " … [older turn — full text in the retrieved context above]";
      const shrunk = oldMsgs.map((m) => {
        const t = text(m.content);
        if (t.length <= SHRINK_OVER) return m; // small enough, leave alone
        // ARRAY CONTENT MUST SHRINK TOO. Anthropic-shaped bodies carry tool
        // results as content BLOCKS, not strings — an earlier version only
        // shrank strings, so every tool_result was skipped and the request
        // GREW (recalled slice added, nothing removed): measured 14,856 ->
        // 14,899. Shrink the text INSIDE each block and keep the block's
        // type/tool_use_id, so the provider's correlation is still intact.
        if (Array.isArray(m.content)) {
          const blocks = (m.content as Array<Record<string, unknown>>).map((b) => {
            const bt = typeof b?.text === "string" ? (b.text as string)
              : typeof b?.content === "string" ? (b.content as string) : null;
            if (bt === null || bt.length <= SHRINK_OVER) return b;
            const short = bt.slice(0, HEAD) + MARK;
            return typeof b.text === "string" ? { ...b, text: short } : { ...b, content: short };
          });
          return { ...m, content: blocks };
        }
        return { ...m, content: t.slice(0, HEAD) + MARK }; // plain string
      });
      const tail = msgs.slice(cut);
      const rebuilt: Msg[] = slice
        ? [{ role: "system", content: `Relevant earlier context, retrieved from holographic memory:\n${slice}${coverageNote((rec?.items ?? []).length, cfg.lecoreCorpusChunks)}` }, ...shrunk, ...tail]
        : [...shrunk, ...tail];
      const after = estimateTokens(rebuilt);
      return {
        body: { ...body, messages: rebuilt },
        info: { engaged: true, contextId, tokensBefore: before, tokensAfter: after, spilledTokens: before - after, mode: "spill" },
      };
    } catch (e) {
      const why = (e as Error).message.slice(0, 120);
      if (cfg.lecoreRequired) throw new Error(`lecore_unavailable: ${why}`);
      return failOpenCut(body, msgs, before, why);
    }
  }

  let { live, spill } = split(msgs, cfg.lecoreSpillTokens);
  // Never orphan a tool result from its call across the spill boundary.
  ({ live, spill } = keepToolPairs(live, spill));

  // INTRA-MESSAGE SPILL. Turn-granularity is not enough: a needle-in-a-haystack
  // prompt (and any pasted document) is ONE message holding the whole corpus AND
  // the question, so message-level splitting finds nothing older than the live
  // window and leCore no-ops on exactly the case it exists for. Measured on
  // context-bench NIAH: 10,345 tokens, engaged=false, answered by raw attention.
  // So when the live window is still oversized, carve the LAST message: keep its
  // tail (the actual ask) and spill the head as passages.
  //
  // THE GUARD IS "live is still fat", NOT "spill is empty". Requiring an empty
  // spill was a real, expensive bug: an agent conversation (older turns + a
  // huge recent tool result / pasted corpus) put the older turns in spill and
  // then left the giant last message WHOLE in the live window — MEASURED in
  // production, a 2.78MB Cursor body reported tokens_before == tokens_after ==
  // 677,948, i.e. leCore "engaged" and forwarded the entire book anyway, at
  // $3.39 a call, repeatedly. Single-message bodies spilled fine, which is why
  // it survived testing. Carve whenever the live window is over the threshold.
  if (estimateTokens(live) > cfg.lecoreSpillTokens && live.length > 0) {
    const lastIdx = live.length - 1;
    const body_ = text(live[lastIdx].content);
    const tailChars = cfg.lecoreTailChars;
    if (body_.length > tailChars * 2) {
      const head = body_.slice(0, body_.length - tailChars);
      const tail = body_.slice(body_.length - tailChars);
      // CHUNKING IS LECORE'S DECISION, NOT OURS. We used to slice the head
      // into fixed windows here, which silently destroys any fact that
      // straddles a boundary — MEASURED, a 57-char needle appeared in ZERO of
      // 1,584 chunks, so retrieval was asked to find text that no longer
      // existed. leCore's chunk_text says exactly this in its docstring ("a
      // fact split across two chunks is retrievable from neither") and splits
      // on paragraphs instead. So send the head WHOLE and let the sidecar
      // chunk it with leCore; `chunk: true` on bind does that server-side.
      // Preserve anything already destined for spill — older turns come first
      // so the bound corpus keeps conversation order.
      const passages: Msg[] = [{ role: live[lastIdx].role ?? "user", content: head }];
      spill = [...spill, ...live.slice(0, lastIdx), ...passages];
      live = [{ ...live[lastIdx], content: tail }];
    }
  }
  if (spill.length === 0) return off("nothing older than the live window");

  try {
    // 1. BIND the older turns, role-marked so the ranker sees who said what.
    const items = spill.map((m) => ({ text: `${m.role ?? "user"}: ${text(m.content)}` }))
      .filter((it) => it.text.trim().length > 0);
    if (items.length === 0) return off("spill was empty after flattening");

    const bind = (await post(`${cfg.lecoreUrl}/internal/v1/hrr/bind`,
      { tenant_id: cfg.lecoreTenant, items, chunk: true,
       chunk_max_chars: cfg.lecoreChunkChars, chunk_overlap: cfg.lecoreChunkOverlap,
       ...(thread ? { context_id: thread } : {}) }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as { context_id?: string };
    const contextId = bind?.context_id;
    if (!contextId) throw new Error("bind returned no context_id");

    // 2. RECALL the slice relevant to the live ask. This is what the user pays for.
    //
    // SEARCH WITH THE ASK, NOT THE ASK PLUS A PAGE OF THE CORPUS. The tail we
    // forward to the model is deliberately generous (LECORE_TAIL_CHARS, so the
    // model keeps local context), but using all of it as the QUERY is a bug that
    // silently inverts the ranking: measured on a 15k NIAH, a 2,000-char tail was
    // ~1,900 chars of filler, so the query vector looked like filler and the
    // filler chunks won at cosine 0.90 while the needle -- the least filler-like
    // passage in the corpus -- never made top-8. The ranker was right; the
    // question was wrong. Search with the last paragraph (the actual ask).
    const query = askOf(text(live[live.length - 1]?.content) || text(msgs[msgs.length - 1]?.content),
                        cfg.lecoreQueryChars);
    const rec = (await post(`${cfg.lecoreUrl}/internal/v1/hrr/recall`,
      { tenant_id: cfg.lecoreTenant, context_id: contextId, query, top_k: cfg.lecoreTopK }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as
      { items?: Array<{ text?: string }> };
    const slice = (rec?.items ?? []).map((x) => x?.text ?? "").filter(Boolean).join("\n---\n");

    const rebuilt: Msg[] = slice
      ? [{ role: "system", content: `Relevant earlier context, retrieved from holographic memory:\n${slice}${coverageNote((rec?.items ?? []).length, cfg.lecoreCorpusChunks)}` }, ...live]
      : live;
    const after = estimateTokens(rebuilt);
    return {
      body: { ...body, messages: rebuilt },
      info: { engaged: true, contextId, tokensBefore: before, tokensAfter: after, spilledTokens: before - after },
    };
  } catch (e) {
    const why = (e as Error).message.slice(0, 120);
    if (cfg.lecoreRequired) throw new Error(`lecore_unavailable: ${why}`);
    return failOpenCut(body, msgs, before, why);
  }
}

/** Sidecar down is not a license to forward 850k chars × N racers. */
function failOpenCut(
  body: Record<string, unknown>,
  msgs: Msg[],
  before: number,
  why: string,
): LecoreResult {
  const cut = applySpillCut(msgs as SpillMsg[]);
  if (cut.cut > cut.firstSpillable) {
    const system = cut.messages.slice(0, cut.firstSpillable);
    const tail = cut.messages.slice(cut.cut);
    const forwarded = [...system, ...tail];
    const after = estimateTokens(forwarded);
    return {
      body: { ...body, messages: forwarded },
      info: {
        engaged: false,
        reason: `fail-open-cut: ${why}`,
        tokensBefore: before,
        tokensAfter: after,
        spilledTokens: Math.max(0, before - after),
      },
    };
  }
  return {
    body,
    info: { engaged: false, reason: `fail-open: ${why}`, tokensBefore: before, tokensAfter: before },
  };
}

/**
 * ATTACH: the caller already bound a corpus (POST /v1/hrr/bind) and now sends
 * a SMALL body naming it via X-HRR-Context. The body never ships twice — we
 * recall top-k against the pre-bound context and prepend it, instead of asking
 * the caller to re-upload megabytes so `prepare` can re-carve them.
 *
 * BILLING BASIS IS THE MARKUP PATH, ON PURPOSE. tokensAfter > tokensBefore
 * here (the body grew by the recalled slice), so quoteRequest's counterfactual
 * guard never fires and the caller pays markup x a tiny body — typically far
 * cheaper than the counterfactual on the full corpus. The receipt stays honest
 * about that basis (pricing: "markup", mode: "attach").
 *
 * A MISSING CONTEXT IS 404, NOT FAIL-OPEN. The caller asked a question about a
 * corpus we do not have; answering without it would be a confident lie billed
 * as memory. ContextGoneError -> HTTP 404 pre-402, so a stale client manifest
 * re-binds without paying. Other sidecar failures honor LECORE_REQUIRED.
 */
export async function attach(
  cfg: Config,
  body: Record<string, unknown>,
  contextId: string,
): Promise<LecoreResult> {
  const msgs = (Array.isArray(body.messages) ? body.messages : []) as Msg[];
  const before = estimateTokens(body.messages);
  const off = (r: string): LecoreResult => ({ body, info: { engaged: false, mode: "attach", reason: r, contextId, tokensBefore: before, tokensAfter: before } });
  if (!cfg.lecoreUrl) return off("LECORE_HRR_URL unset");

  const query = askOf(text(msgs[msgs.length - 1]?.content), cfg.lecoreQueryChars);
  if (!query) return off("empty ask");

  try {
    const { status, json: rec } = await postRaw(`${cfg.lecoreUrl}/internal/v1/hrr/recall`,
      { tenant_id: cfg.lecoreTenant, context_id: contextId, query, top_k: cfg.lecoreTopK },
      cfg.lecoreTimeoutMs, cfg.lecoreKey);
    if (status === 404) throw new ContextGoneError(contextId);
    if (status < 200 || status >= 300) throw new Error(`recall -> ${status}`);
    const r = rec as { items?: Array<{ text?: string }>; chunks?: number; corpus_chars?: number | null };
    const items = (r?.items ?? []);
    const slice = items.map((x) => x?.text ?? "").filter(Boolean).join("\n---\n");
    const rebuilt: Msg[] = slice
      ? [{ role: "system", content: `Relevant earlier context, retrieved from holographic memory:\n${slice}${coverageNote(items.length, r?.chunks ?? cfg.lecoreCorpusChunks)}` }, ...msgs]
      : msgs;
    const after = estimateTokens(rebuilt);
    // What answering this WITHOUT leCore would have cost: shipping the whole
    // bound corpus. Prefer the sidecar's measured chars; fall back to chunk
    // count × leCore's ~600-char chunk target when texts weren't hydrated.
    const corpusTokens = Number.isFinite(r?.corpus_chars as number) && (r?.corpus_chars as number) > 0
      ? Math.ceil((r!.corpus_chars as number) / 4)
      : r?.chunks
        ? Math.ceil((r.chunks * 600) / 4)
        : undefined;
    return {
      body: { ...body, messages: rebuilt },
      info: {
        engaged: true, mode: "attach", contextId, tokensBefore: before, tokensAfter: after,
        recalled: items.length, corpusTokens,
      },
    };
  } catch (e) {
    if (e instanceof ContextGoneError) throw e;
    const why = (e as Error).message.slice(0, 120);
    if (cfg.lecoreRequired) throw new Error(`lecore_unavailable: ${why}`);
    return off(`fail-open attach: ${why}`);
  }
}

/**
 * Thin public bind passthrough -> sidecar /internal/v1/hrr/bind.
 * Free (no 402): auto-spill already binds unpaid bodies before the payment
 * check, so this adds no exposure — it just lets a client bind ONCE and then
 * ask forever with X-HRR-Context. Chunking stays leCore's decision
 * (chunk: true), same as the spill path. item_ids are dropped from the reply:
 * a 3.7MB corpus chunks into thousands and the caller only needs the id.
 */
export async function bindPassthrough(
  cfg: Config,
  body: { items?: Array<{ text?: string }>; corpus?: string; context_id?: string; mode?: string },
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!cfg.lecoreUrl) return { status: 503, payload: { error: "hrr_unconfigured: LECORE_HRR_URL unset" } };
  const items = Array.isArray(body.items) && body.items.length
    ? body.items
    : (typeof body.corpus === "string" && body.corpus.trim() ? [{ text: body.corpus }] : []);
  if (!items.length) return { status: 400, payload: { error: "items (array of {text}) or corpus (string) required" } };

  const { status, json } = await postRaw(`${cfg.lecoreUrl}/internal/v1/hrr/bind`,
    { tenant_id: cfg.lecoreTenant, items, chunk: true,
      chunk_max_chars: cfg.lecoreChunkChars, chunk_overlap: cfg.lecoreChunkOverlap,
      ...(body.context_id ? { context_id: body.context_id } : {}),
      ...(body.mode ? { mode: body.mode } : {}) },
    cfg.lecoreTimeoutMs, cfg.lecoreKey);
  if (status < 200 || status >= 300) {
    const j = json as { error?: string; code?: string };
    return { status, payload: { error: j?.error || `bind -> ${status}`, code: j?.code } };
  }
  const out = json as { object?: string; context_id?: string; bound?: number };
  return { status: 200, payload: { object: out.object ?? "hrr.context", context_id: out.context_id, bound: out.bound } };
}

/**
 * Right-to-forget, as an endpoint.
 *
 * The engine's store is a commutative monoid — merge(A,B).ablate(B) == A — so
 * removing one source is a subtraction, not a rebuild. Exposing it matters
 * because a product that says "connect your whole life" is only honest if
 * disconnecting actually takes the data back out, provably, on demand.
 *
 * Delegates to the sidecar's unbind with all:true for a whole context, or a
 * specific item_ids list. Free, like bind: charging for deletion is hostile.
 */
export async function ablatePassthrough(
  cfg: Config,
  body: { context_id?: string; item_ids?: string[] },
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!cfg.lecoreUrl) return { status: 503, payload: { error: "hrr_unconfigured: LECORE_HRR_URL unset" } };
  if (!body.context_id) return { status: 400, payload: { error: "context_id required" } };

  const ids = Array.isArray(body.item_ids) ? body.item_ids : [];
  const { status, json } = await postRaw(`${cfg.lecoreUrl}/internal/v1/hrr/unbind`,
    { tenant_id: cfg.lecoreTenant, context_id: body.context_id,
      ...(ids.length ? { item_ids: ids } : { all: true }) },
    cfg.lecoreTimeoutMs, cfg.lecoreKey);
  if (status < 200 || status >= 300) {
    const j = json as { error?: string };
    return { status, payload: { error: j?.error || `ablate -> ${status}` } };
  }
  const out = json as { removed?: number; unbound?: number; object?: string };
  return {
    status: 200,
    payload: {
      object: "hrr.ablate",
      context_id: body.context_id,
      removed: out.removed ?? out.unbound ?? 0,
    },
  };
}

/**
 * OUROBOROS memory — the model's durable external partition, per-tenant.
 *
 * Free passthroughs (like bindPassthrough): writing and reading your OWN memory
 * is infrastructure, not a metered inference. The sidecar still returns
 * `_meta.lecore.cost` + `_meta.lecore.receipt` on every call, so a metered lane
 * can be layered on later without changing the wire. See the sidecar's
 * ouroboros.py and leCore docs/ZOO.md §7-8.
 */
export async function memoryWrite(
  cfg: Config,
  body: { text?: string; tags?: string[] },
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!cfg.lecoreUrl) return { status: 503, payload: { error: "hrr_unconfigured: LECORE_HRR_URL unset" } };
  if (typeof body.text !== "string" || !body.text.trim()) return { status: 400, payload: { error: "text (string) required" } };
  const { status, json } = await postRaw(`${cfg.lecoreUrl}/internal/v1/memory/write`,
    { tenant_id: cfg.lecoreTenant, text: body.text, tags: Array.isArray(body.tags) ? body.tags : [] },
    cfg.lecoreTimeoutMs, cfg.lecoreKey);
  if (status < 200 || status >= 300) {
    const j = json as { error?: string; code?: string };
    return { status, payload: { error: j?.error || `memory_write -> ${status}`, code: j?.code } };
  }
  return { status: 200, payload: json as Record<string, unknown> };
}

export async function memorySearch(
  cfg: Config,
  body: { query?: string; top?: number; tags?: string[] },
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!cfg.lecoreUrl) return { status: 503, payload: { error: "hrr_unconfigured: LECORE_HRR_URL unset" } };
  if (typeof body.query !== "string" || !body.query.trim()) return { status: 400, payload: { error: "query (string) required" } };
  const { status, json } = await postRaw(`${cfg.lecoreUrl}/internal/v1/memory/search`,
    { tenant_id: cfg.lecoreTenant, query: body.query, top: body.top ?? 4, ...(Array.isArray(body.tags) ? { tags: body.tags } : {}) },
    cfg.lecoreTimeoutMs, cfg.lecoreKey);
  if (status < 200 || status >= 300) {
    const j = json as { error?: string; code?: string };
    return { status, payload: { error: j?.error || `memory_search -> ${status}`, code: j?.code } };
  }
  return { status: 200, payload: json as Record<string, unknown> };
}


/**
 * leCore's own faculties, proxied — docs/ZOO.md §1, §9, §11.
 *
 * `find` is Rule-0 for the whole zoo ("before implementing any algorithm, ask
 * whether leCore already has it"); `invoke` runs any of 3,214 capabilities
 * through leCore's OWN dispatch, so private-faculty refusals and the wire
 * conventions are inherited rather than re-enforced here. Discovery is free —
 * charging to look at a catalog would just make models hand-roll instead.
 */
export async function lecoreCall(
  cfg: Config,
  op: "find" | "describe" | "invoke",
  body: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  // AGAINST lecore-front, NOT the HRR sidecar. The sidecar deliberately imports
  // only four leCore modules; building the full faculty surface next to
  // bind/recall OOM'd it mid-bind on 20MB chunks (see hrr-context _lecore.py).
  // leCore's own service already exposes /tools + /invoke on its own app, so
  // discovery and heavy faculties run there and cannot starve retrieval.
  if (!cfg.lecoreFrontUrl) return { status: 503, payload: { error: "lecore_unconfigured: LECORE_FRONT_URL unset" } };
  const path = op === "invoke" ? "/invoke" : "/tools";
  const payload = op === "invoke"
    ? { name: body.name, args: body.args || {} }
    : { query: body.query ?? body.name, top: body.top ?? 8 };
  // SHORT, SEPARATE TIMEOUT. lecore-front builds its faculty catalog on demand
  // and an authed /tools has been measured not answering inside 300s, with no
  // request line logged (FastAPI logs on completion) — i.e. still grinding.
  // Inheriting the sidecar's generous timeout would hang a caller for minutes
  // on a discovery call; a fast, honest failure is strictly better than that.
  const frontMs = Number(process.env.LECORE_FRONT_TIMEOUT_MS || 8000);
  const { status, json } = await postRaw(`${cfg.lecoreFrontUrl}${path}`,
    payload, frontMs, cfg.lecoreFrontKey);
  if (status < 200 || status >= 300) {
    const j = json as { error?: string; code?: string };
    return { status, payload: { error: j?.error || `lecore_${op} -> ${status}`, code: j?.code } };
  }
  return { status: 200, payload: json as Record<string, unknown> };
}
