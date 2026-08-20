/**
 * OpenAI-shaped SSE for /v1/chat/completions.
 *
 * Desktop openzoo already sniffs a trailing comment `: x402 {…}` for the
 * receipt (billedUsd, directUsd, savesVsDirect as a multiple, lecore).
 * Comments are discarded by compliant clients; the receipt must still ride
 * the stream or every spend figure goes to zero the moment we stop buffering
 * a JSON blob.
 */
import type { ServerResponse } from "node:http";

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

export function writeSseHead(res: ServerResponse, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(200, { ...SSE_HEADERS, ...extra });
}

export function sseData(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

export function sseEvent(res: ServerResponse, event: string, obj: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}

export function sseComment(res: ServerResponse, name: string, obj: unknown): void {
  res.write(`: ${name} ${JSON.stringify(obj)}\n\n`);
}

export function sseStatus(res: ServerResponse, status: string): void {
  sseEvent(res, "openzoo.status", { status });
  sseComment(res, "status", { status });
}

export function sseReceipt(res: ServerResponse, receipt: unknown): void {
  sseComment(res, "x402", receipt);
}

export function sseDone(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
}

export function completionChunk(opts: {
  id: string;
  model: string;
  created?: number;
  content?: string;
  role?: boolean;
  finish?: string | null;
}): Record<string, unknown> {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const delta: Record<string, unknown> = {};
  if (opts.role) delta.role = "assistant";
  if (opts.content != null) delta.content = opts.content;
  return {
    id: opts.id,
    object: "chat.completion.chunk",
    created,
    model: opts.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: opts.finish === undefined ? null : opts.finish,
    }],
  };
}

/** Emit a finished answer as spec-shaped chat.completion.chunk events. */
export function writeAnswerSse(res: ServerResponse, opts: {
  id: string;
  model: string;
  text: string;
  created?: number;
}): void {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  sseData(res, completionChunk({ id: opts.id, model: opts.model, created, role: true }));
  if (opts.text) {
    sseData(res, completionChunk({ id: opts.id, model: opts.model, created, content: opts.text }));
  }
  sseData(res, completionChunk({ id: opts.id, model: opts.model, created, finish: "stop" }));
}

export async function pipeSse(
  res: ServerResponse,
  stream: ReadableStream<Uint8Array>,
): Promise<{ prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let pending = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) res.write(value);
      pending += dec.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "");
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data) as { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
          if (obj.usage && typeof obj.usage === "object") usage = obj.usage;
        } catch { /* keep-alive or non-JSON */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return usage;
}

/** Pull assistant text out of an OpenRouter / OpenAI JSON completion. */
export function assistantText(json: unknown): string {
  const ch = (json as { choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }> } | undefined)
    ?.choices?.[0];
  const raw = ch?.message?.content ?? ch?.delta?.content ?? "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  }
  return raw == null ? "" : String(raw);
}

export function providerErrored(json: unknown): boolean {
  return !!(json as { error?: unknown } | undefined)?.error
    && !((json as { choices?: unknown[] })?.choices?.length);
}

/** Read an OpenRouter SSE body into assistant text, forwarding token deltas. */
export async function readSseText(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let pending = "";
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "");
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> };
          const piece = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content ?? "";
          if (piece) {
            text += piece;
            onDelta?.(piece);
          }
        } catch { /* keep-alive or non-JSON */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return text;
}
