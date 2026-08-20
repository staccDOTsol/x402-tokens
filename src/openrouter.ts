export interface ModelPrice {
  id: string;
  prompt: number;
  completion: number;
  context?: number;
}

interface Cache {
  at: number;
  byId: Map<string, ModelPrice>;
}

let cache: Cache | null = null;
const TTL = 10 * 60_000;

/** Test hook — drop the catalog so the next listModels hits the mock. */
export function _clearModelCache(): void { cache = null; }

export async function getModel(base: string, key: string, id: string): Promise<ModelPrice> {
  const all = await listModels(base, key);
  const m = all.byId.get(id);
  if (!m) throw new Error(`unknown model ${id}`);
  return m;
}

export async function listModels(base: string, key: string): Promise<Cache> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`openrouter /models ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string }; context_length?: number }> };
  const byId = new Map<string, ModelPrice>();
  for (const m of j.data ?? []) {
    byId.set(m.id, {
      id: m.id,
      prompt: Number(m.pricing?.prompt ?? 0),
      completion: Number(m.pricing?.completion ?? 0),
      context: m.context_length,
    });
  }
  cache = { at: Date.now(), byId };
  return cache;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  if (!(ms > 0) || !Number.isFinite(ms)) return signal;
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, t]);
  const c = new AbortController();
  const kill = () => c.abort();
  if (signal.aborted || t.aborted) { c.abort(); return c.signal; }
  signal.addEventListener("abort", kill, { once: true });
  t.addEventListener("abort", kill, { once: true });
  return c.signal;
}

export async function complete(
  base: string,
  key: string,
  body: unknown,
  referer: string,
  opts?: { signal?: AbortSignal },
): Promise<{ status: number; headers: Headers; stream: ReadableStream<Uint8Array> | null; json?: unknown }> {
  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 120_000);
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "http-referer": referer,
      "x-title": "x402-tokens",
    },
    body: JSON.stringify(body),
    signal: withTimeout(opts?.signal, timeoutMs),
  });
  const ctype = r.headers.get("content-type") ?? "";
  if (ctype.includes("text/event-stream") && r.body) {
    return { status: r.status, headers: r.headers, stream: r.body };
  }
  const json = await r.json().catch(() => ({ error: `openrouter ${r.status}` }));
  return { status: r.status, headers: r.headers, stream: null, json };
}
