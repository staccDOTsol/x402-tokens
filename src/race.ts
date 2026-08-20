/**
 * First-X-back model racing for POST /v1/chat/completions.
 *
 * Locked policy: first X *countable* answers back out of Y, then a cheap
 * classifier compares those X. If none clear the bar, take the last of those
 * X. Do NOT wait until X pass a bar.
 *
 * Countable = real assistant text. Empty, HTTP/pay/timeout notes, TypeError
 * `fetch failed`, `(model failed: …)`, and any arrival with `.error` do not
 * count. Failed racers are abandoned. If every racer fails, one race-level
 * error — never `(seed-2.0-code failed: fetch failed)` as the answer.
 *
 * This is grokui's race, orchestrated here so every client (and anyone hitting
 * this door) gets it without N parallel payments. It is not grokui's SPAWN /
 * PING agent protocol.
 */
import type { Config } from "./config.js";
import type { Quote, UsageHint } from "./quote.js";
import { mergeQuotes, quoteLive, reconcileQuote } from "./quote.js";
import { listModels } from "./openrouter.js";

export const RACE_EVERY_FAILED = "(race: every model failed — no reply)";
export const RACE_FAILED_CODE = "race_failed";
export const RACE_MIN_SCORE = Number(process.env.RACE_MIN_SCORE || 6);
export const RACE_MAX = Number(process.env.RACE_MAX || 8);
export const RACE_RACER_TIMEOUT_MS = Number(process.env.RACE_RACER_TIMEOUT_MS || 45_000);

export type RaceTier = "cheap" | "medium" | "expensive";

export interface RaceSpec {
  n: number;
  need: number;
  tier: RaceTier;
}

export interface RaceArrival {
  model: string;
  text: string;
  error?: unknown;
  score?: number;
}

export interface RaceResult {
  text: string;
  model: string;
  error: boolean;
  statusLog: string[];
  judgeUsed: boolean;
  launched: string[];
  countable: string[];
  failed: string[];
  aborted: string[];
  usedModels: string[];
}

const RACE_HTTP_NOTE = /^\((?:upstream error|request failed|payment failed|rate limited|stream timed out|stream stalled)/i;
const RACE_MODEL_FAILED = /^\([^)]+ (?:failed:|returned nothing)/i;
const RACE_FETCH_FAILED = /^(?:typeerror:\s*)?fetch failed$/i;

export function isRaceCountable(textOrArrival: unknown): boolean {
  const arrival: RaceArrival = textOrArrival && typeof textOrArrival === "object" && !Array.isArray(textOrArrival)
    ? textOrArrival as RaceArrival
    : { model: "", text: String(textOrArrival ?? "") };
  if (arrival.error) return false;
  const s = String(arrival.text || "").trim();
  if (!s) return false;
  if (RACE_FETCH_FAILED.test(s)) return false;
  if (RACE_HTTP_NOTE.test(s)) return false;
  if (RACE_MODEL_FAILED.test(s)) return false;
  return true;
}

export function raceLastShip(arrivals: RaceArrival[]): RaceArrival {
  const last = [...arrivals].reverse().find((a) => isRaceCountable(a));
  if (last) return { ...last, text: String(last.text) };
  return { model: "", text: RACE_EVERY_FAILED, error: true };
}

export function parseClassifyScore(text: string): number {
  const s = String(text || "");
  const tagged = /SCORE\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  const lone = tagged || /\b(10|[0-9])(?:\s*\/\s*10)?\b/.exec(s);
  if (!lone) return 0;
  const n = Number(lone[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

export function pickRaceWinner(cands: RaceArrival[], minScore = RACE_MIN_SCORE): {
  winner: RaceArrival | null;
  reason: "empty" | "fallback-last" | "score" | "tie";
  tied: RaceArrival[];
} {
  const list = Array.isArray(cands) ? cands.filter(Boolean) : [];
  if (!list.length) return { winner: null, reason: "empty", tied: [] };
  const passing = list.filter((c) => (Number(c.score) || 0) >= minScore);
  if (!passing.length) {
    return { winner: list[list.length - 1], reason: "fallback-last", tied: [] };
  }
  let max = -Infinity;
  for (const c of passing) {
    const sc = Number(c.score) || 0;
    if (sc > max) max = sc;
  }
  const tied = passing.filter((c) => (Number(c.score) || 0) === max);
  if (tied.length === 1) return { winner: tied[0], reason: "score", tied };
  return { winner: null, reason: "tie", tied };
}

export function formatRaceStatus(back: number, need: number): string {
  const b = Math.max(0, Number(back) || 0);
  const n = Math.max(1, Number(need) || 1);
  return `racing ${b}/${n} back…`;
}

const DEFAULT_POOLS: Record<RaceTier, string[]> = {
  cheap: [
    "google/gemini-2.5-flash",
    "google/gemini-3.7-flash",
    "deepseek/deepseek-chat",
    "qwen/qwen-2.5-7b-instruct",
    "meta-llama/llama-3.3-70b-instruct",
    "mistralai/mistral-small",
  ],
  medium: [
    "google/gemini-2.5-pro",
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o-mini",
    "qwen/qwen-2.5-72b-instruct",
    "deepseek/deepseek-chat",
    "google/gemini-2.5-flash",
  ],
  expensive: [
    "anthropic/claude-opus-4",
    "openai/gpt-4o",
    "google/gemini-2.5-pro",
    "x-ai/grok-3",
    "anthropic/claude-sonnet-4",
  ],
};

export function judgeModel(): string {
  return process.env.RACE_JUDGE_MODEL || "google/gemini-2.5-flash";
}

export function poolFor(tier: RaceTier): string[] {
  const env = process.env[`RACE_POOL_${tier.toUpperCase()}`];
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_POOLS[tier];
}

export function parseRace(body: { race?: unknown; race_need?: unknown; tier?: unknown }): RaceSpec | null {
  if (body.race === undefined || body.race === null) return null;
  let n: number;
  if (body.race === true) n = 4;
  else n = Math.floor(Number(body.race));
  if (!Number.isFinite(n) || n < 2) {
    throw new Error("race must be an integer >= 2 (omit it for single-model)");
  }
  n = Math.min(n, RACE_MAX);
  let need = body.race_need === undefined || body.race_need === null
    ? Math.min(2, n)
    : Math.floor(Number(body.race_need));
  if (!Number.isFinite(need) || need < 1) throw new Error("race_need must be an integer >= 1");
  need = Math.min(need, n);
  const raw = String(body.tier || "cheap").toLowerCase();
  const tier: RaceTier = raw === "medium" || raw === "expensive" ? raw : "cheap";
  return { n, need, tier };
}

export async function resolveRaceModels(cfg: Config, spec: RaceSpec): Promise<string[]> {
  const catalog = await listModels(cfg.openrouterUrl, cfg.openrouterKey);
  const picked: string[] = [];
  for (const id of poolFor(spec.tier)) {
    if (catalog.byId.has(id) && !picked.includes(id)) picked.push(id);
    if (picked.length >= spec.n) break;
  }
  return picked;
}

export interface RaceQuote {
  q: Quote;
  parts: Array<{ model: string; q: Quote; role: "racer" | "judge" }>;
}

export async function quoteRaceCeiling(
  cfg: Config,
  body: { model?: string; messages?: unknown; max_tokens?: number; plugins?: unknown },
  models: string[],
  counterfactualTokens: number | undefined,
  tenantSpendUsd: number,
): Promise<RaceQuote> {
  const judge = judgeModel();
  const racerQuotes = await Promise.all(models.map(async (model) => ({
    model,
    role: "racer" as const,
    q: await quoteLive(cfg, { ...body, model }, counterfactualTokens, tenantSpendUsd),
  })));
  const judgeQ = await quoteLive(
    cfg,
    { ...body, model: judge, max_tokens: 24, plugins: [] },
    undefined,
    tenantSpendUsd,
  );
  const parts = [...racerQuotes, { model: judge, role: "judge" as const, q: judgeQ }];
  return { q: mergeQuotes(cfg, parts.map((p) => p.q), `race:${models.length}x${judge}`), parts };
}

function raceQuestion(messages: unknown): string {
  const list = Array.isArray(messages) ? messages as Array<{ role?: string; content?: unknown }> : [];
  const asked = [...list].reverse().find((m) => m.role === "user")?.content;
  return typeof asked === "string" ? asked : "(see candidates)";
}

export async function brainRace(opts: {
  messages: unknown;
  models: string[];
  need: number;
  run: (model: string, onDelta: (chunk: string) => void, signal: AbortSignal) => Promise<string>;
  classify?: (messages: unknown, cand: RaceArrival) => Promise<number>;
  pairwise?: (messages: unknown, tied: RaceArrival[]) => Promise<RaceArrival | null>;
  minScore?: number;
  onStatus?: (status: string) => void;
  onDelta?: (text: string, meta?: { replace?: boolean; model?: string }) => void;
}): Promise<RaceResult> {
  const list = (opts.models || []).filter(Boolean).slice(0, RACE_MAX);
  const want = Math.max(1, Math.min(Number(opts.need) || 1, list.length));
  const minScore = opts.minScore != null ? Number(opts.minScore) : RACE_MIN_SCORE;
  const statusLog: string[] = [];
  const onStatus = (s: string) => {
    statusLog.push(s);
    opts.onStatus?.(s);
  };

  if (list.length < 2) {
    const ac = new AbortController();
    const model = list[0] || "";
    try {
      const text = await opts.run(model, (c) => opts.onDelta?.(c, { model }), ac.signal);
      const arrival = { model, text };
      if (!isRaceCountable(arrival)) {
        return {
          text: RACE_EVERY_FAILED, model: "", error: true, statusLog, judgeUsed: false,
          launched: model ? [model] : [], countable: [], failed: model ? [model] : [],
          aborted: [], usedModels: [],
        };
      }
      return {
        text, model, error: false, statusLog, judgeUsed: false,
        launched: [model], countable: [model], failed: [], aborted: [], usedModels: [model],
      };
    } catch {
      return {
        text: RACE_EVERY_FAILED, model: "", error: true, statusLog, judgeUsed: false,
        launched: model ? [model] : [], countable: [], failed: model ? [model] : [],
        aborted: [], usedModels: [],
      };
    }
  }

  const controllers = new Map<string, AbortController>();
  const arrivals: RaceArrival[] = [];
  const done: RaceArrival[] = [];
  const launched: string[] = [...list];
  const failed: string[] = [];
  const aborted: string[] = [];
  let back = 0;
  let finished = 0;
  let release: () => void = () => {};
  const enough = new Promise<void>((r) => { release = r; });

  onStatus(formatRaceStatus(0, want));

  const attempts = list.map((m) => {
    const ac = new AbortController();
    controllers.set(m, ac);
    const timer = setTimeout(() => ac.abort(), RACE_RACER_TIMEOUT_MS);
    return opts.run(m, (chunk) => opts.onDelta?.(chunk, { model: m }), ac.signal)
      .finally(() => clearTimeout(timer))
      .then((text) => {
        const raw = text == null ? "" : String(text);
        const arrival: RaceArrival = { model: m, text: raw };
        arrivals.push(arrival);
        if (isRaceCountable(arrival)) {
          done.push(arrival);
          back += 1;
          onStatus(formatRaceStatus(back, want));
        } else {
          failed.push(m);
        }
      })
      .catch((e) => {
        arrivals.push({ model: m, text: "", error: (e as Error)?.message || "error" });
        failed.push(m);
      })
      .finally(() => {
        finished += 1;
        if (done.length >= want || finished === list.length) release();
      });
  });
  for (const p of attempts) p.catch(() => {});

  await enough;
  const cands = done.slice(0, want);
  const leftover = list.filter((m) => !cands.some((c) => c.model === m) && !failed.includes(m));
  for (const m of leftover) {
    if (done.some((c) => c.model === m)) continue;
    const ac = controllers.get(m);
    if (ac && !ac.signal.aborted) {
      ac.abort();
      aborted.push(m);
    }
  }

  const ship = (cand: RaceArrival | undefined, judgeUsed: boolean, used: string[]): RaceResult => {
    const out = cand && isRaceCountable(cand) ? cand : raceLastShip(arrivals);
    return {
      text: out.error ? RACE_EVERY_FAILED : String(out.text || "").trim() || RACE_EVERY_FAILED,
      model: out.error ? "" : out.model,
      error: !!out.error || !isRaceCountable(out),
      statusLog,
      judgeUsed,
      launched,
      countable: done.map((d) => d.model),
      failed,
      aborted,
      usedModels: used,
    };
  };

  if (!cands.length) return ship(undefined, false, []);
  if (cands.length === 1) return ship(cands[0], false, [cands[0].model]);

  onStatus("judging…");
  const classify = opts.classify;
  const scored = await Promise.all(cands.map(async (c) => {
    let score = 0;
    if (classify) {
      try { score = Number(await classify(opts.messages, c)) || 0; } catch { score = 0; }
    }
    return { ...c, score };
  }));

  let picked = pickRaceWinner(scored, minScore);
  if (picked.reason === "tie" && picked.tied.length > 1 && opts.pairwise) {
    let broken: RaceArrival | null = null;
    try { broken = await opts.pairwise(opts.messages, picked.tied); } catch { /* last of the tie */ }
    const usable = broken && isRaceCountable(broken);
    picked = {
      winner: usable ? broken : picked.tied[picked.tied.length - 1],
      reason: "score",
      tied: picked.tied,
    };
  }
  const winner = picked.winner || scored[scored.length - 1];
  return ship(winner, true, [...cands.map((c) => c.model), judgeModel()]);
}

export function classifyPrompt(messages: unknown, cand: RaceArrival): string {
  return "Score this answer to one question from 0 to 10.\n\n"
    + "QUESTION:\n" + String(raceQuestion(messages)).slice(0, 4000) + "\n\n"
    + "ANSWER:\n" + String(cand?.text || "").slice(0, 6000) + "\n\n"
    + "Judge on: correctness first, then completeness, then whether it actually did what was asked. "
    + "Ignore length and confidence of tone.\n"
    + "Reply with exactly: SCORE <n>";
}

export function pairwisePrompt(messages: unknown, tied: RaceArrival[]): string {
  const letters = tied.map((_, i) => String.fromCharCode(65 + i));
  return "You are judging answers to one question. Pick the single best one.\n\n"
    + "QUESTION:\n" + String(raceQuestion(messages)).slice(0, 4000) + "\n\n"
    + tied.map((c, i) => "ANSWER " + letters[i] + ":\n" + String(c.text || "").slice(0, 6000)).join("\n\n")
    + "\n\nJudge on: correctness first, then completeness, then whether it actually did what was asked. "
    + "Ignore length and confidence of tone.\n"
    + "Reply with ONE letter and nothing else: " + letters.join(" or ") + ".";
}

export function parsePairwiseLetter(verdict: string, tied: RaceArrival[]): RaceArrival | null {
  const hit = String(verdict).toUpperCase().split("").find((ch) => {
    const n = ch.charCodeAt(0) - 65;
    return n >= 0 && n < tied.length;
  });
  if (!hit) return null;
  return tied[hit.charCodeAt(0) - 65];
}

/** True when this race part actually ran (and so has a real cost). Failed /
 *  aborted racers that never produced a countable answer are unused. */
export function racePartConsumed(
  p: { model: string; role: "racer" | "judge" },
  result: RaceResult,
): boolean {
  if (p.role === "judge") return result.judgeUsed;
  if (result.failed.includes(p.model) && !result.countable.includes(p.model)) return false;
  if (result.aborted.includes(p.model) && !result.countable.includes(p.model) && !result.usedModels.includes(p.model)) return false;
  if (result.launched.includes(p.model) && (result.countable.includes(p.model) || result.usedModels.includes(p.model))) return true;
  // Launched and finished with a 2xx (even if not in the first-X set): still consumed.
  return result.launched.includes(p.model) && !result.failed.includes(p.model) && !result.aborted.includes(p.model);
}

/** USD actually consumed from a race ceiling, for the unused-credit refund. */
export function raceActualUsd(
  parts: Array<{ model: string; q: Quote; role: "racer" | "judge" }>,
  result: RaceResult,
): number {
  return parts.filter((p) => racePartConsumed(p, result)).reduce((s, p) => s + p.q.billedUsd, 0);
}

/** Upstream cost of the racers (and judge) that actually ran — never the
 *  prepaid N+judge quote ceiling. That ceiling is what we settle; this is
 *  what we spent. Painting the ceiling as cogsUsd makes every unused-racer
 *  refund look like COGS > paid. */
export function raceActualCogsUsd(
  parts: Array<{ model: string; q: Quote; role: "racer" | "judge" }>,
  result: RaceResult,
): number {
  return parts.filter((p) => racePartConsumed(p, result)).reduce((s, p) => s + p.q.openrouterUsd, 0);
}

/** Reprice each consumed part against tokens/cost the model emitted. */
export function raceReconcile(
  parts: Array<{ model: string; q: Quote; role: "racer" | "judge" }>,
  result: RaceResult,
  usageByModel?: Map<string, UsageHint>,
): { billedUsd: number; cogsUsd: number } {
  let billedUsd = 0;
  let cogsUsd = 0;
  for (const p of parts) {
    if (!racePartConsumed(p, result)) continue;
    const rec = reconcileQuote(p.q, usageByModel?.get(p.model));
    billedUsd += rec.billedUsd;
    cogsUsd += rec.cogsUsd;
  }
  return { billedUsd, cogsUsd };
}
