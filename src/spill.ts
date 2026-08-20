/**
 * Claude-CLI spill, on the gateway.
 *
 * Desktop `npx openzoo claude` binds the transcript prefix into HRR and
 * forwards system + a short tail (`sending 3/131 turns`). Grokui / phones /
 * Seeker / PSG1 POST the growing history (sometimes WITH x-hrr-context) and
 * used to skip that cut. This module is the same cut for every client that
 * hits /v1/chat/completions or /v1/messages.
 *
 * Rules:
 *   - NEVER skip the cut because the caller already sent x-hrr-context.
 *     Still stub/cut the tail. Reuse/append their id; do not forward 850k.
 *   - Bind failure is not a license to ship the book. Fail-open STILL cuts.
 *   - Score savings off dollars (directUsd / spentUsd), never a char ratio
 *     and never a sum of savesVsDirect multiples.
 */
import { estimateTokens } from "./math.js";

export interface Msg {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { arguments?: unknown } }>;
  tool_call_id?: string;
  function_call?: { arguments?: unknown };
}

export interface SpillKnobs {
  keepTail: number;
  minTurns: number;
  budget: number;
}

export const KNOB_DEFAULTS: SpillKnobs = Object.freeze({
  keepTail: 3,
  minTurns: 2,
  budget: 6000,
});

const KEEP_STEPS = [2, 3, 4, 6, 8] as const;
const TURNS_STEPS = [2, 3, 4, 6] as const;
const BUDGET_STEPS = [1500, 2500, 4000, 6000, 9000] as const;

/** Green HUD target: direct / spent. Char ratio is fallback only. */
export const ADAPT_TARGET = 10;
export const ADAPT_LOOSEN_AT = 20;

export const FAT_TOOL_CHARS = 400;
const BIND_MIN_CHARS = 2_000;
const HUGE_CHARS = 32_000;
const TAIL_CHARS = 2_000;
const SESSION_CAP = 4_096;

export type BindFn = (
  items: Array<{ text: string }>,
  contextId?: string,
) => Promise<{ context_id?: string } | null>;

function envInt(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function envKnobs(): SpillKnobs {
  return {
    keepTail: envInt("OPENZOO_KEEP_TAIL_MSGS", KNOB_DEFAULTS.keepTail),
    minTurns: envInt("OPENZOO_TAIL_MIN_TURNS", KNOB_DEFAULTS.minTurns),
    budget: envInt("OPENZOO_TAIL_MAX_CHARS", KNOB_DEFAULTS.budget),
  };
}

export function sanitizeKnobs(raw: Partial<SpillKnobs> = {}): SpillKnobs {
  const clamp = (n: unknown, lo: number, hi: number, fb: number) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fb;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };
  return {
    keepTail: clamp(raw.keepTail, KEEP_STEPS[0], KEEP_STEPS[KEEP_STEPS.length - 1], KNOB_DEFAULTS.keepTail),
    minTurns: clamp(raw.minTurns, TURNS_STEPS[0], TURNS_STEPS[TURNS_STEPS.length - 1], KNOB_DEFAULTS.minTurns),
    budget: clamp(raw.budget, BUDGET_STEPS[0], BUDGET_STEPS[BUDGET_STEPS.length - 1], KNOB_DEFAULTS.budget),
  };
}

function blockText(b: unknown): string {
  if (typeof b === "string") return b;
  if (!b || typeof b !== "object") return "";
  const o = b as { type?: string; text?: string; content?: unknown; name?: string; input?: unknown };
  if (o.type === "text") return o.text || "";
  if (o.type === "tool_use") return `[tool_use ${o.name ?? ""}] ${JSON.stringify(o.input ?? {})}`;
  if (o.type === "tool_result") {
    const c = o.content;
    return `[tool_result] ${typeof c === "string" ? c : JSON.stringify(c ?? "")}`;
  }
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content;
  return "";
}

export function msgText(m: Msg | undefined): string {
  const c = m?.content;
  const body = typeof c === "string" ? c
    : Array.isArray(c) ? c.map(blockText).filter(Boolean).join("\n")
    : c && typeof c === "object" ? JSON.stringify(c)
    : "";
  return body ? `${(m?.role || "?").toUpperCase()}: ${body}` : "";
}

export function messageChars(m: Msg | undefined): number {
  if (!m) return 0;
  let n = 0;
  const c = m.content;
  if (typeof c === "string") n += c.length;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (typeof b === "string") n += b.length;
      else if (b && typeof b === "object") {
        const o = b as { text?: unknown; content?: unknown };
        if (typeof o.text === "string") n += o.text.length;
        else if (typeof o.content === "string") n += o.content.length;
        else n += JSON.stringify(b).length;
      }
    }
  } else if (c && typeof c === "object") n += JSON.stringify(c).length;
  if (Array.isArray(m.tool_calls)) n += JSON.stringify(m.tool_calls).length;
  return n;
}

export function sliceChars(msgs: Msg[], from = 0, to?: number): number {
  const end = to == null ? msgs.length : to;
  let n = 0;
  for (let i = from; i < end && i < msgs.length; i++) n += messageChars(msgs[i]);
  return n;
}

export function firstSpillableIndex(msgs: Msg[]): number {
  return msgs.findIndex((m) => m?.role !== "system");
}

function lastUserAskIndex(msgs: Msg[], firstSpillable: number): number {
  for (let i = msgs.length - 1; i > firstSpillable; i--) {
    const m = msgs[i];
    if (m?.role === "user" && msgText(m).trim()) return i;
  }
  return -1;
}

function countRealTurns(msgs: Msg[], from: number): number {
  let n = 0;
  for (let i = from; i < msgs.length; i++) {
    const r = msgs[i]?.role;
    if (r === "user" || r === "assistant") n += 1;
  }
  return n;
}

function isSeverable(msgs: Msg[], i: number, firstSpillable: number): boolean {
  if (i <= firstSpillable || i >= msgs.length) return false;
  const prev = msgs[i - 1];
  if (!prev) return false;
  if (prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length) return false;
  return msgs[i].role !== "tool";
}

export function cutTranscript(msgs: Msg[], knobs: Partial<SpillKnobs> = {}): {
  cut: number;
  firstSpillable: number;
  lastUser: number;
  knobs: SpillKnobs;
} {
  const k = sanitizeKnobs({ ...envKnobs(), ...knobs });
  if (!Array.isArray(msgs) || !msgs.length) {
    return { cut: -1, firstSpillable: -1, lastUser: -1, knobs: k };
  }
  const firstSpillable = firstSpillableIndex(msgs);
  if (firstSpillable < 0) return { cut: -1, firstSpillable: -1, lastUser: -1, knobs: k };

  const keepTail = Math.min(k.keepTail, Math.max(2, Math.floor(msgs.length / 2)));
  const minTurns = Math.max(2, k.minTurns);

  let cut = -1;
  for (let i = msgs.length - keepTail; i > firstSpillable; i--) {
    if (isSeverable(msgs, i, firstSpillable)) { cut = i; break; }
  }
  if (cut <= firstSpillable) {
    for (let i = msgs.length - 2; i > firstSpillable; i--) {
      if (isSeverable(msgs, i, firstSpillable)) { cut = i; break; }
    }
  }
  if (cut <= firstSpillable) {
    return { cut: -1, firstSpillable, lastUser: lastUserAskIndex(msgs, firstSpillable), knobs: k };
  }

  let tailStart = cut;
  {
    let used = 0;
    for (let i = msgs.length - 1; i >= cut; i--) {
      used += messageChars(msgs[i]);
      if (used > k.budget && isSeverable(msgs, i, firstSpillable)) { tailStart = i; break; }
    }
  }
  if (tailStart > cut) cut = tailStart;

  if (countRealTurns(msgs, cut) < minTurns) {
    for (let i = cut - 1; i > firstSpillable; i--) {
      if (isSeverable(msgs, i, firstSpillable) && countRealTurns(msgs, i) >= minTurns) { cut = i; break; }
      if (i === firstSpillable + 1) { if (isSeverable(msgs, i, firstSpillable)) cut = i; break; }
    }
  }

  const lastUser = lastUserAskIndex(msgs, firstSpillable);
  if (lastUser > firstSpillable && cut > lastUser) cut = lastUser;
  if (lastUser > firstSpillable && countRealTurns(msgs, cut) < 2) {
    for (let i = cut - 1; i > firstSpillable; i--) {
      if (isSeverable(msgs, i, firstSpillable) && countRealTurns(msgs, i) >= 2) { cut = i; break; }
    }
    if (cut > lastUser) cut = lastUser;
  }

  return { cut, firstSpillable, lastUser, knobs: k };
}

function definedCallIds(msgs: Msg[]): Set<string> {
  const ids = new Set<string>();
  for (const m of msgs) {
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c?.id) ids.add(c.id);
  }
  return ids;
}

/** Pull spilled tool_calls back so a live tool result is never orphaned. */
export function keepToolPairs(live: Msg[], spill: Msg[]): { live: Msg[]; spill: Msg[] } {
  const callIdOf = (m: Msg) => m.tool_call_id;
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

function stubFatTools(msgs: Msg[]): { messages: Msg[]; stubbed: number } {
  let stubbed = 0;
  const out = msgs.map((m) => {
    const t = typeof m.content === "string" ? m.content : "";
    if (m.role === "tool" && t.length > FAT_TOOL_CHARS) {
      stubbed += 1;
      return { ...m, content: `${t.slice(0, 120)} … [older tool result — full text in bound context]` };
    }
    if (typeof m.content === "string" && t.length > FAT_TOOL_CHARS * 4 && m.role !== "user") {
      stubbed += 1;
      return { ...m, content: `${t.slice(0, 200)} … [older turn — full text in bound context]` };
    }
    return m;
  });
  return { messages: out, stubbed };
}

/**
 * Cut + stub. `dollarX` (directUsd/spentUsd) retunes keepTail for the NEXT
 * request; a miss recuts this request once. Char ratio is fallback only.
 */
export function applySpillCut(msgs: Msg[], opts: {
  knobs?: Partial<SpillKnobs>;
  dollarX?: number | null;
} = {}): {
  cut: number;
  firstSpillable: number;
  lastUser: number;
  knobs: SpillKnobs;
  messages: Msg[];
  sentChars: number;
  prefixChars: number;
} {
  let k = sanitizeKnobs({ ...envKnobs(), ...opts.knobs });
  const dollar = Number(opts.dollarX);
  if (Number.isFinite(dollar) && dollar > 0 && dollar < ADAPT_TARGET) {
    k = sanitizeKnobs({ ...k, keepTail: Math.max(2, k.keepTail - 1), minTurns: 2, budget: Math.max(1500, k.budget - 1500) });
  } else if (Number.isFinite(dollar) && dollar > ADAPT_LOOSEN_AT) {
    k = sanitizeKnobs({ ...k, keepTail: Math.min(8, k.keepTail + 1) });
  }

  const plan = cutTranscript(msgs, k);
  const stubbed = stubFatTools(msgs);
  if (plan.cut <= plan.firstSpillable) {
    return {
      ...plan,
      messages: stubbed.messages,
      sentChars: sliceChars(stubbed.messages, Math.max(0, plan.firstSpillable)),
      prefixChars: 0,
    };
  }
  const live0 = stubbed.messages.slice(plan.cut);
  const spill0 = stubbed.messages.slice(0, plan.cut);
  const { live, spill } = keepToolPairs(live0, spill0);
  return {
    cut: spill.length,
    firstSpillable: plan.firstSpillable,
    lastUser: plan.lastUser,
    knobs: k,
    messages: [...spill, ...live],
    sentChars: sliceChars(live),
    prefixChars: sliceChars(spill, plan.firstSpillable),
  };
}

/** Dollar / green HUD multiple. Never sum savesVsDirect — that is a multiple, not a dollar. */
export function hudDollarX(input: {
  directUsd?: number;
  spentUsd?: number;
  spillDirect?: number;
  spillSpend?: number;
  direct?: number;
  spend?: number;
} = {}): number | null {
  const billed = Number(input.spentUsd ?? input.spillSpend ?? input.spend);
  const direct = Number(input.directUsd ?? input.spillDirect ?? input.direct);
  if (billed > 0 && Number.isFinite(direct)) return direct / billed;
  return null;
}

export function createSpillStats() {
  return {
    spillCalls: 0,
    spillReuses: 0,
    spillSpend: 0,
    spillDirect: 0,
    lastSend: 0,
    noteSpill({ reused = false, sent = 0 } = {}) {
      this.spillCalls += 1;
      if (reused) this.spillReuses += 1;
      this.lastSend = sent;
    },
    /** Fold one quote. Sums DOLLARS, never savesVsDirect multiples. */
    noteQuote({ directUsd = 0, spentUsd = 0 } = {}) {
      this.spillDirect += Number(directUsd) || 0;
      this.spillSpend += Number(spentUsd) || 0;
    },
    snapshot() {
      return {
        calls: this.spillCalls,
        reusedBinds: this.spillReuses,
        spend: this.spillSpend,
        direct: this.spillDirect,
        savedUsd: Math.max(0, this.spillDirect - this.spillSpend),
        savingX: hudDollarX({ spillDirect: this.spillDirect, spillSpend: this.spillSpend }),
      };
    },
  };
}

export type SpillStats = ReturnType<typeof createSpillStats>;

const sessionMemo = new Map<string, { contextId: string; prefixChars: number }>();

export function _resetSessionMemo() { sessionMemo.clear(); }

export function rememberSession(key: string | undefined, contextId: string, prefixChars = 0) {
  if (!key || !contextId) return;
  sessionMemo.set(key, { contextId, prefixChars });
  if (sessionMemo.size > SESSION_CAP) sessionMemo.delete(sessionMemo.keys().next().value as string);
}

export function sessionContext(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return sessionMemo.get(key)?.contextId;
}

export function sessionKeyFrom(headers: Record<string, string | string[] | undefined>, body?: Record<string, unknown>): string | undefined {
  const h = (n: string) => {
    const v = headers[n];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" && s.trim() ? s.trim() : undefined;
  };
  const sid = h("x-claude-code-session-id")
    || h("x-session-id")
    || h("x-claude-session-id")
    || h("x-openzoo-session");
  if (sid) return `sid:${sid}`;
  const meta = body?.metadata as { user_id?: unknown } | undefined;
  if (typeof meta?.user_id === "string" && meta.user_id.trim()) return `sid:${meta.user_id.trim()}`;
  if (typeof body?.conversation_id === "string" && body.conversation_id.trim()) return `sid:${body.conversation_id.trim()}`;
  const user = body?.user;
  if (typeof user === "string" && user.startsWith("ctx_")) return `sid:${user}`;
  return undefined;
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(blockText).join("\n");
  return "";
}

/** One huge last message: keep the ask tail, spill the head (NIAH / pasted book). */
export function splitHugeLast(msgs: Msg[], tailChars = TAIL_CHARS): { msgs: Msg[]; head: string } | null {
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  const body = contentText(last.content);
  if (body.length <= tailChars * 2) return null;
  const head = body.slice(0, body.length - tailChars);
  const tail = body.slice(body.length - tailChars);
  const next = msgs.slice();
  next[next.length - 1] = { ...last, content: tail };
  return { msgs: next, head };
}

export interface SpillResult {
  body: Record<string, unknown>;
  contextId?: string;
  reused: boolean;
  sent: number;
  total: number;
  tokensBefore: number;
  tokensAfter: number;
  prefixChars: number;
  sentChars: number;
  log: string;
  engaged: boolean;
}

/**
 * Bind the spilled prefix and return system + tail.
 *
 * `headerCtx` is REUSED, never a skip. A client that already set
 * x-hrr-context still gets the tail cut and the prefix appended to that id.
 */
export async function spillTranscript(
  body: Record<string, unknown>,
  opts: {
    bind?: BindFn;
    headerCtx?: string;
    sessionKey?: string;
    knobs?: Partial<SpillKnobs>;
    dollarX?: number | null;
    log?: (line: string) => void;
  } = {},
): Promise<SpillResult | null> {
  const msgs = (Array.isArray(body.messages) ? body.messages : []) as Msg[];
  const tokensBefore = estimateTokens(body.messages);
  const total = msgs.length;
  const log = opts.log ?? (() => {});

  if (!msgs.length) return null;

  const adapted = applySpillCut(msgs, { knobs: opts.knobs, dollarX: opts.dollarX });
  const huge = sliceChars(msgs) >= HUGE_CHARS || tokensBefore > 8_000;
  const longTurns = total >= 6 && adapted.cut > adapted.firstSpillable;

  let working = msgs;
  let prefixItems: Array<{ text: string }> = [];
  let forwarded: Msg[] = msgs;
  let sent = total;
  let prefixChars = 0;
  let sentChars = sliceChars(msgs);
  let cutAt = -1;

  if (longTurns) {
    const system = msgs.slice(0, adapted.firstSpillable);
    const spill = adapted.messages.slice(adapted.firstSpillable, adapted.cut);
    const tail = adapted.messages.slice(adapted.cut);
    prefixItems = spill.map((m) => ({ text: msgText(m) })).filter((it) => it.text.trim());
    prefixChars = adapted.prefixChars;
    forwarded = [...system, ...tail];
    working = adapted.messages;
    sent = tail.length;
    sentChars = adapted.sentChars;
    cutAt = adapted.cut;
  } else {
    const one = splitHugeLast(msgs);
    if (one && (huge || one.head.length >= BIND_MIN_CHARS)) {
      prefixItems = [{ text: one.head }];
      prefixChars = one.head.length;
      forwarded = one.msgs;
      working = one.msgs;
      sent = forwarded.length;
      sentChars = sliceChars(forwarded);
      cutAt = 0;
    }
  }

  if (!prefixItems.length && !huge) return null;
  if (!prefixItems.length && huge) {
    // Un-severable storm: still stub and refuse to forward the book.
    const stubbed = stubFatTools(working);
    forwarded = stubbed.messages;
    sentChars = sliceChars(forwarded);
    sent = forwarded.length;
  }

  const known = opts.headerCtx
    || (opts.sessionKey ? sessionContext(opts.sessionKey) : undefined);
  let contextId = known;
  let reused = Boolean(known);

  if (prefixItems.length && opts.bind) {
    try {
      let bound = await opts.bind(prefixItems, known);
      if (!bound?.context_id && known) {
        // Append rejected (stale / wrong-tenant id). New bind, still cut.
        bound = await opts.bind(prefixItems, undefined);
        reused = false;
      }
      if (bound?.context_id) {
        contextId = bound.context_id;
        if (opts.sessionKey) rememberSession(opts.sessionKey, contextId, prefixChars);
      }
    } catch {
      // bind failed — still return the cut tail
    }
  } else if (known) {
    contextId = known;
    reused = true;
  }

  const tokensAfter = estimateTokens(forwarded);
  const keyKind = opts.sessionKey ? opts.sessionKey.slice(0, 12) : (known ? "header-ctx" : "content");
  const line = reused && contextId
    ? `transcript prefix already bound (${contextId}, ${keyKind}) — sending ${sent}/${total} turns`
    : contextId
      ? `transcript prefix bound (${prefixChars} chars → ${contextId}, ${keyKind}) — sending ${sent}/${total} turns`
      : `transcript prefix cut without bind — sending ${sent}/${total} turns`;
  log(line);

  return {
    body: { ...body, messages: forwarded },
    contextId,
    reused,
    sent,
    total,
    tokensBefore,
    tokensAfter,
    prefixChars,
    sentChars,
    log: line,
    engaged: forwarded !== msgs && (sent < total || tokensAfter < tokensBefore),
  };
}

/** Anthropic /v1/messages → OpenAI-shaped body the rest of the gateway speaks. */
export function anthropicToChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const msgs: Msg[] = [];
  const sys = body.system;
  if (typeof sys === "string" && sys.trim()) msgs.push({ role: "system", content: sys });
  else if (Array.isArray(sys)) {
    const t = sys.map(blockText).filter(Boolean).join("\n");
    if (t) msgs.push({ role: "system", content: t });
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as Msg[]) msgs.push(m);
  }
  return {
    ...body,
    messages: msgs,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? 256,
  };
}

/** OpenAI chat.completion → Anthropic message, for /v1/messages callers. */
export function chatToAnthropicMessage(out: Record<string, unknown>, model: string): Record<string, unknown> {
  const choices = (out.choices as Array<{ message?: { content?: unknown }; finish_reason?: string }>) ?? [];
  const text = typeof choices[0]?.message?.content === "string" ? choices[0].message.content : "";
  const { x402, usage, id } = out as { x402?: unknown; usage?: unknown; id?: string };
  return {
    id: id ?? "msg_zoo",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: choices[0]?.finish_reason === "length" ? "max_tokens" : "end_turn",
    usage: usage ?? {},
    x402,
  };
}
