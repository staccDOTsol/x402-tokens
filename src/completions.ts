/**
 * Serve a paid /v1/chat/completions call: single-model SSE, JSON, or a
 * first-X-back race. Payment has already settled once before anything here
 * runs.
 */
import type { ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { Quote, UsageHint } from "./quote.js";
import { reconcileQuote, usageFromCompletion } from "./quote.js";
import type { LecoreResult } from "./lecore.js";
import {
  assistantText, pipeSse, providerErrored, readSseText, sseDone, sseEvent,
  sseReceipt, sseStatus, writeAnswerSse, writeSseHead,
} from "./stream.js";
import {
  brainRace, classifyPrompt, judgeModel, parseClassifyScore, parsePairwiseLetter,
  pairwisePrompt, raceReconcile, RACE_EVERY_FAILED, RACE_FAILED_CODE,
  type RaceArrival, type RaceQuote, type RaceResult, type RaceSpec,
} from "./race.js";
import { recordSpend } from "./spend.js";
import { json } from "./httpjson.js";
import { chatToAnthropicMessage } from "./spill.js";

export interface PayInfo {
  paidByCredit: boolean;
  paidBySub?: boolean;
  picked: { asset: string; maxAmountRequired: string };
  settled: { success?: boolean; transaction?: string; payer?: string };
  payer?: string;
}

export interface ReceiptExtras {
  q: Quote;
  lecoreInfo: LecoreResult["info"];
  shouldHaveEngaged?: boolean;
  dedupStripped?: number;
  pay: PayInfo;
  spill?: { sent: number; total: number; context_id?: string };
  /** What the user paid (prepaid quote, never above direct). */
  billedUsd?: number;
  /** Upstream cost of work that actually ran — never the N+judge quote. */
  cogsUsd?: number;
  race?: {
    n: number;
    need: number;
    tier: string;
    models: string[];
    winner?: string;
    statuses?: string[];
    quotedUsd: number;
    actualUsd: number;
    actualCogsUsd: number;
    unusedUsd: number;
  };
  refundUsd?: number;
  refundReason?: string;
}

export function x402Receipt(x: ReceiptExtras): Record<string, unknown> {
  const { q, pay } = x;
  const direct = q.directUsd ?? q.billedUsd;
  const rawBilled = x.billedUsd ?? x.race?.actualUsd ?? q.billedUsd;
  // Never bill above direct. The quote already promised this; reconciliation
  // and the receipt both enforce it so a UI cannot paint COGS>paid from a
  // leftover ceiling.
  const billed = Math.min(Math.max(0, rawBilled), direct);
  const cogs = x.cogsUsd
    ?? x.race?.actualCogsUsd
    ?? (x.race ? x.race.actualUsd : q.openrouterUsd);
  const saves = billed > 0 ? direct / billed : (q.savesVsDirect ?? 1);
  return {
    billedUsd: billed,
    quotedUsd: q.billedUsd,
    pricing: q.pricing,
    directUsd: q.directUsd,
    savesVsDirect: saves,
    rate: q.directUsd && billed > 0 ? Math.min(1, billed / q.directUsd) : q.rate,
    savedPct: q.directUsd && billed >= 0 ? Math.max(0, 1 - billed / q.directUsd) : q.savedPct,
    savedUsd: q.directUsd != null ? Math.max(0, q.directUsd - billed) : q.savedUsd,
    volume: q.volume,
    cogsUsd: cogs,
    markup: q.pricing === "markup" ? q.markup : undefined,
    paid: pay.picked.asset,
    lecore_fail_open: x.shouldHaveEngaged || undefined,
    amount: pay.picked.maxAmountRequired,
    settle: pay.settled,
    lecore: x.lecoreInfo,
    dedup_stripped_chars: x.dedupStripped || undefined,
    credit: pay.paidByCredit ? { covered: q.billedUsd } : undefined,
    subscription: pay.paidBySub ? { covered: q.billedUsd } : undefined,
    refund_credit: x.refundUsd
      ? { usd: x.refundUsd, reason: x.refundReason, note: "auto-applied to your next calls" }
      : undefined,
    race: x.race,
    spill: x.spill,
  };
}

export type CompleteResult = {
  status: number;
  headers: Headers;
  stream: ReadableStream<Uint8Array> | null;
  json?: unknown;
};

export type CallUpstream = (
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
) => Promise<CompleteResult>;

function emptyTruncated(r: CompleteResult): boolean {
  if (r.status < 200 || r.status >= 300) return false;
  const ch = ((r.json as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> })
    ?.choices ?? [])[0];
  return !!ch && ch.finish_reason === "length" && !(ch.message?.content || "").trim();
}

export async function runOneModel(
  callUpstream: CallUpstream,
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal; onDelta?: (chunk: string) => void; allowEmptyRetry?: boolean },
): Promise<{ text: string; out: CompleteResult }> {
  const out = await callUpstream({ ...body, stream: !!opts?.onDelta || body.stream === true }, { signal: opts?.signal });
  if (out.stream) {
    const text = await readSseText(out.stream, opts?.onDelta);
    if (out.status < 200 || out.status >= 300) throw new Error(`HTTP ${out.status}`);
    return { text, out: { ...out, stream: null, json: { choices: [{ message: { role: "assistant", content: text } }] } } };
  }
  if (out.status < 200 || out.status >= 300) {
    const msg = (out.json as { error?: { message?: string } | string } | undefined)?.error;
    throw new Error(typeof msg === "string" ? msg : msg?.message || `HTTP ${out.status}`);
  }
  if (providerErrored(out.json)) {
    const msg = (out.json as { error?: { message?: string } | string }).error;
    throw new Error(typeof msg === "string" ? msg : msg?.message || "provider_error");
  }
  let text = assistantText(out.json);
  if (opts?.allowEmptyRetry !== false && emptyTruncated(out) && Number(body.max_tokens ?? 256) < 512) {
    const retry = await callUpstream({ ...body, stream: false, max_tokens: 1024 }, { signal: opts?.signal });
    if (!emptyTruncated(retry) && retry.status >= 200 && retry.status < 300 && !providerErrored(retry.json)) {
      return { text: assistantText(retry.json), out: retry };
    }
  }
  return { text, out };
}

/**
 * After a 402 settle, a prepaid draw, or a launched racer we keep the money.
 * OpenRouter still bills us for in-flight / settled work — unused racers,
 * 502/503/timeout, and lost races are not grant-backs. Subscription skip-402
 * never minted credit and still does not.
 *
 * Only a call that never left the house (didn't start) skips charging, and
 * that path never reaches here.
 */
export function refundAfterSettle(
  _tenantKey: string,
  _paidBySub: boolean | undefined,
  _quotedUsd: number,
  _actualUsd: number,
  _failed: boolean,
  _reasons: { failed: string; unused: string } = { failed: "race_failed", unused: "race_unused" },
): { refundUsd: number; refundReason: string } | undefined {
  return undefined;
}

/** Prepaid quote, never above going-naked direct. Not a COGS refund. */
export function prepaidBilledUsd(q: Quote): number {
  return Math.min(Math.max(0, q.billedUsd), q.directUsd ?? q.billedUsd);
}

function asUpstreamError(e: unknown): CompleteResult {
  const msg = e instanceof Error ? e.message : String(e || "fetch failed");
  const timedOut = /abort|timeout/i.test(msg);
  return {
    status: timedOut ? 504 : 502,
    headers: new Headers(),
    stream: null,
    json: { error: { message: msg || "fetch failed" } },
  };
}

function finishJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string>,
  anthropicModel?: string,
): void {
  const payload = anthropicModel
    ? chatToAnthropicMessage(body, anthropicModel)
    : body;
  return json(res, status, payload, extraHeaders);
}

export async function serveSingle(
  res: ServerResponse,
  args: {
    cfg: Config;
    prepped: Record<string, unknown>;
    body: Record<string, unknown>;
    wantsStream: boolean;
    callUpstream: CallUpstream;
    tenantKey: string;
    q: Quote;
    extras: Omit<ReceiptExtras, "refundUsd" | "refundReason" | "race">;
    evt: (status: string, extra?: Record<string, unknown>) => void;
    extraHeaders?: Record<string, string>;
    anthropicModel?: string;
  },
): Promise<void> {
  const { callUpstream, prepped, wantsStream, tenantKey, q, extras, evt } = args;
  const extraHeaders = args.extraHeaders ?? {};
  let out: CompleteResult;
  try {
    out = await callUpstream({
      ...prepped,
      stream: wantsStream,
      ...(wantsStream ? { stream_options: { include_usage: true } } : {}),
    });
  } catch (e) {
    out = asUpstreamError(e);
  }

  if (wantsStream && out.stream && out.status >= 200 && out.status < 300) {
    writeSseHead(res, extraHeaders);
    let usage: UsageHint | undefined;
    try {
      usage = await pipeSse(res, out.stream);
    } catch (e) {
      const billedUsd = prepaidBilledUsd(q);
      if (billedUsd > 0) recordSpend(tenantKey, billedUsd, args.cfg.volumeWindowDays);
      const receipt = x402Receipt({ ...extras, billedUsd, cogsUsd: 0 });
      sseEvent(res, "error", { error: { message: (e as Error).message || "stream failed", code: "upstream_error" } });
      sseReceipt(res, receipt);
      sseDone(res);
      res.end();
      evt("paid_upstream_error", {
        payer: extras.pay.payer, upstream: 502, billedUsd, cogsUsd: 0,
        directUsd: q.directUsd, tx: extras.pay.settled.transaction,
      });
      return;
    }
    const rec = reconcileQuote(q, usage);
    const billedUsd = prepaidBilledUsd(q);
    if (billedUsd > 0) recordSpend(tenantKey, billedUsd, args.cfg.volumeWindowDays);
    const receipt = x402Receipt({ ...extras, billedUsd, cogsUsd: rec.cogsUsd });
    sseReceipt(res, receipt);
    sseDone(res);
    res.end();
    evt("paid_200", {
      payer: extras.pay.payer, upstream: out.status, billedUsd,
      cogsUsd: rec.cogsUsd, directUsd: q.directUsd, tx: extras.pay.settled.transaction,
    });
    return;
  }

  let used = out;
  if (!wantsStream) {
    const askedTok = Number((prepped as { max_tokens?: number }).max_tokens ?? 256);
    if (emptyTruncated(used) && askedTok < 512) {
      try {
        const retry = await callUpstream({ ...prepped, stream: false, max_tokens: 1024 });
        if (!emptyTruncated(retry) && retry.status >= 200 && retry.status < 300) used = retry;
      } catch { /* keep the first response */ }
    }
  }

  const errored = providerErrored(used.json) || used.status < 200 || used.status >= 300;
  const rec = errored
    ? { billedUsd: prepaidBilledUsd(q), cogsUsd: 0, unusedUsd: 0 }
    : reconcileQuote(q, usageFromCompletion(used.json));
  const billedUsd = prepaidBilledUsd(q);
  const cogsUsd = rec.cogsUsd;
  if (billedUsd > 0) {
    recordSpend(tenantKey, billedUsd, args.cfg.volumeWindowDays);
  }
  const receipt = x402Receipt({ ...extras, billedUsd, cogsUsd });
  evt(used.status >= 200 && used.status < 300 ? "paid_200" : "paid_upstream_error", {
    payer: extras.pay.payer, upstream: used.status, billedUsd,
    cogsUsd, directUsd: q.directUsd, tx: extras.pay.settled.transaction,
  });

  if (wantsStream) {
    writeSseHead(res, extraHeaders);
    if (errored) {
      sseEvent(res, "error", { error: { message: assistantText(used.json) || "upstream error", code: "upstream_error" } });
    } else {
      writeAnswerSse(res, {
        id: String((used.json as { id?: string })?.id || `chatcmpl-${Date.now()}`),
        model: String((prepped.model as string) || extras.q.model),
        text: assistantText(used.json),
      });
    }
    sseReceipt(res, receipt);
    sseDone(res);
    res.end();
    return;
  }

  return finishJson(res, used.status, { ...(used.json as object), x402: receipt }, extraHeaders, args.anthropicModel);
}

export async function serveRace(
  res: ServerResponse,
  args: {
    cfg: Config;
    prepped: Record<string, unknown>;
    wantsStream: boolean;
    callUpstream: CallUpstream;
    tenantKey: string;
    q: Quote;
    race: RaceSpec;
    raceQuote: RaceQuote;
    models: string[];
    extras: Omit<ReceiptExtras, "refundUsd" | "refundReason" | "race">;
    evt: (status: string, extra?: Record<string, unknown>) => void;
    extraHeaders?: Record<string, string>;
    anthropicModel?: string;
  },
): Promise<void> {
  const { callUpstream, prepped, wantsStream, tenantKey, q, race, raceQuote, models, extras, evt } = args;
  const extraHeaders = args.extraHeaders ?? {};
  const id = `chatcmpl-race-${Date.now().toString(36)}`;
  if (wantsStream) writeSseHead(res, extraHeaders);

  const usageByModel = new Map<string, UsageHint>();
  const run = async (model: string, _onDelta: (chunk: string) => void, signal: AbortSignal) => {
    const { text, out } = await runOneModel(callUpstream, { ...prepped, model, stream: false }, {
      signal,
      allowEmptyRetry: false,
    });
    const u = usageFromCompletion(out.json);
    if (u) usageByModel.set(model, u);
    return text;
  };

  const classify = async (messages: unknown, cand: RaceArrival) => {
    const { text, out } = await runOneModel(callUpstream, {
      model: judgeModel(),
      messages: [{ role: "user", content: classifyPrompt(messages, cand) }],
      max_tokens: 24,
      plugins: [],
      stream: false,
    }, { allowEmptyRetry: false });
    const u = usageFromCompletion(out.json);
    if (u) usageByModel.set(judgeModel(), u);
    return parseClassifyScore(text);
  };

  const pairwise = async (messages: unknown, tied: RaceArrival[]) => {
    const { text, out } = await runOneModel(callUpstream, {
      model: judgeModel(),
      messages: [{ role: "user", content: pairwisePrompt(messages, tied) }],
      max_tokens: 8,
      plugins: [],
      stream: false,
    }, { allowEmptyRetry: false });
    const u = usageFromCompletion(out.json);
    if (u) usageByModel.set(judgeModel(), u);
    return parsePairwiseLetter(text, tied);
  };

  const result: RaceResult = await brainRace({
    messages: prepped.messages,
    models,
    need: race.need,
    run,
    classify,
    pairwise,
    onStatus: wantsStream ? (s) => sseStatus(res, s) : undefined,
  });

  const actual = raceReconcile(raceQuote.parts, result, usageByModel);
  const billedUsd = prepaidBilledUsd(q);
  const unusedUsd = Math.max(0, q.billedUsd - actual.billedUsd);
  if (billedUsd > 0) {
    recordSpend(tenantKey, billedUsd, args.cfg.volumeWindowDays);
  }
  const receipt = x402Receipt({
    ...extras,
    billedUsd,
    cogsUsd: actual.cogsUsd,
    race: {
      n: race.n,
      need: race.need,
      tier: race.tier,
      models,
      winner: result.model || undefined,
      statuses: result.statusLog,
      quotedUsd: q.billedUsd,
      actualUsd: actual.billedUsd,
      actualCogsUsd: actual.cogsUsd,
      unusedUsd,
    },
  });

  evt(result.error ? "paid_upstream_error" : "paid_200", {
    payer: extras.pay.payer,
    billedUsd,
    cogsUsd: actual.cogsUsd,
    quotedUsd: q.billedUsd,
    race: true,
    winner: result.model,
    tx: extras.pay.settled.transaction,
  });

  if (result.error) {
    const err = { error: { message: RACE_EVERY_FAILED, code: RACE_FAILED_CODE } };
    if (wantsStream) {
      sseEvent(res, "error", err);
      sseReceipt(res, receipt);
      sseDone(res);
      res.end();
      return;
    }
    return finishJson(res, 502, { ...err, x402: receipt }, extraHeaders, args.anthropicModel);
  }

  if (wantsStream) {
    writeAnswerSse(res, { id, model: result.model, text: result.text });
    sseReceipt(res, receipt);
    sseDone(res);
    res.end();
    return;
  }

  return finishJson(res, 200, {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    x402: receipt,
  }, extraHeaders, args.anthropicModel);
}
