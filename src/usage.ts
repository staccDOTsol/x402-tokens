/**
 * Usage store + read model. Every `evt` line the server already emits is also
 * kept here so a caller can ASK what they spent instead of grepping Fly logs.
 *
 * WHERE IT LIVES
 *   - always: a bounded in-memory ring (USAGE_RING_MAX events, default 10k)
 *   - when a volume is mounted at USAGE_DIR (default /data): appended to
 *     usage_events.jsonl, rotated at USAGE_MAX_BYTES (one .1 generation kept),
 *     and the tail is read back into the ring on boot.
 * Without the volume the ring is the ONLY store and a restart loses it — every
 * response says which of the two it is (see storeInfo). Nothing here pretends
 * to be complete when it isn't.
 *
 * SHARDING (this is the part that bites)
 *   The app runs more than one Fly machine and each one only ever sees its own
 *   requests, so ANY single machine holds a partial picture. The public
 *   endpoints therefore fan out to the app's other machines over 6PN
 *   (<app>.internal) and merge, and report machines expected vs responded so a
 *   partial answer is visibly partial.
 *
 * PRIVACY
 *   `ip` is already truncated (/24 · /48) where it is captured and is NEVER
 *   returned by any endpoint here. `payer` is a Solana address that is public
 *   on-chain; it is stored in full so a payer can look themselves up, while
 *   the console log line keeps the 8-char form it always had.
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve6 } from "node:dns/promises";

export type UsageEvent = {
  ts: string;
  path?: string;
  status?: string;
  model?: string;
  payer?: string;
  billedUsd?: number;
  tx?: string;
  bodyBytes?: number;
  tokens_before?: number;
  tokens_after?: number;
  spill_tokens?: number;
  recalled?: number;
  corpus_reuse?: boolean;
  upstream?: number;
  http?: number;
  reason?: string;
  /** truncated at capture; never leaves this process */
  ip?: string;
  /** set on rows imported from Fly log retention rather than observed live */
  source?: string;
};

const RING_MAX = Number(process.env.USAGE_RING_MAX || 10_000);
const DIR = process.env.USAGE_DIR || "/data";
const FILE = `${DIR}/usage_events.jsonl`;
const OLD = `${FILE}.1`;
const MAX_BYTES = Number(process.env.USAGE_MAX_BYTES || 32 * 1024 * 1024);
/** how much of the tail to read back at boot — bounded so a 256MB machine can't OOM on it */
const BOOT_TAIL_BYTES = Number(process.env.USAGE_BOOT_TAIL_BYTES || 4 * 1024 * 1024);
const FANOUT_MS = Number(process.env.USAGE_FANOUT_MS || 2500);

const ring: UsageEvent[] = [];
let persisted = false;
let appendsSinceStat = 0;
let bytesOnDisk = 0;
let loadedFromDisk = 0;

export const machineId = process.env.FLY_MACHINE_ID || "local";
const region = process.env.FLY_REGION || "local";
const appName = process.env.FLY_APP_NAME || "";
const selfIp = process.env.FLY_PRIVATE_IP || "";
const port = Number(process.env.PORT || 8787);

/** Read the last `bytes` of a file, dropping the leading partial line. */
function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const len = size - start;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const s = buf.toString("utf8");
    return start === 0 ? s : s.slice(s.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

function pushRing(e: UsageEvent) {
  ring.push(e);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/** Boot: notice the volume and replay the tail of the log into the ring. */
export function initUsage() {
  persisted = existsSync(DIR);
  if (!persisted) return;
  for (const p of [OLD, FILE]) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readTail(p, BOOT_TAIL_BYTES).split("\n")) {
        if (!line.trim()) continue;
        try { pushRing(JSON.parse(line) as UsageEvent); loadedFromDisk += 1; } catch { /* skip a torn line */ }
      }
    } catch { /* an unreadable shard must not stop the server */ }
  }
  ring.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  try { bytesOnDisk = existsSync(FILE) ? statSync(FILE).size : 0; } catch { bytesOnDisk = 0; }
}

function rotateIfBig() {
  try {
    bytesOnDisk = statSync(FILE).size;
    if (bytesOnDisk > MAX_BYTES) {
      renameSync(FILE, OLD); // one generation kept; older history ages out on purpose
      bytesOnDisk = 0;
    }
  } catch { /* nothing to rotate */ }
}

/** Record one event. Telemetry must never fail a request, so this never throws. */
export function record(e: UsageEvent) {
  try {
    pushRing(e);
    recordDaily(e);
    if (!persisted) return;
    const line = JSON.stringify(e) + "\n";
    appendFileSync(FILE, line);
    bytesOnDisk += Buffer.byteLength(line);
    if ((appendsSinceStat += 1) >= 200 || bytesOnDisk > MAX_BYTES) {
      appendsSinceStat = 0;
      rotateIfBig();
    }
  } catch { /* ignore */ }
}

export function storeInfo() {
  const oldest = ring.length ? ring[0].ts : null;
  return {
    machine: machineId,
    region,
    durable: persisted,
    store: persisted
      ? `volume-backed jsonl (${FILE}) + in-memory ring`
      : "in-memory ring ONLY — a restart or redeploy loses every event below",
    retained_events: ring.length,
    ring_max: RING_MAX,
    replayed_from_disk_at_boot: loadedFromDisk,
    oldest_event: oldest,
    caveat: persisted
      ? `history starts when this build first ran on this machine; the file rotates at ${MAX_BYTES} bytes (one older generation kept), and the ring answers with at most ${RING_MAX} events`
      : "history starts at the last restart of this machine and is capped at the ring size",
  };
}

/** Prefix-tolerant payer match — old rows carry an 8-char payer, new rows the full address. */
export function payerMatches(stored: string | undefined, q: string): "exact" | "prefix" | null {
  if (!stored) return null;
  if (stored === q) return "exact";
  const min = 6;
  if (stored.length >= min && q.length >= min && (stored.startsWith(q) || q.startsWith(stored))) return "prefix";
  return null;
}

/** Everything this machine saw for one payer, newest first. */
export function localEventsFor(payer: string, limit: number) {
  const out: UsageEvent[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    if (payerMatches(ring[i].payer, payer)) out.push(ring[i]);
  }
  return out;
}

/** What a caller is allowed to see: no IP, ever. */
export function publicEvent(e: UsageEvent) {
  return {
    ts: e.ts,
    status: e.status,
    model: e.model,
    billedUsd: e.billedUsd,
    tx: e.tx,
    payer: e.payer,
    bodyBytes: e.bodyBytes,
    tokensRead: e.tokens_after ?? e.tokens_before,
    tokensBefore: e.tokens_before,
    spillTokens: e.spill_tokens,
    corpusReuse: e.corpus_reuse,
    upstream: e.upstream,
    reason: e.reason,
    source: e.source,
  };
}

const PAID = new Set(["paid_200", "paid_upstream_error"]);
const round = (n: number) => Number(n.toFixed(8));

export type Shard = {
  machine: string;
  region: string;
  today: string;
  counts: Record<string, number>;
  usdPaidToday: number;
  usdPaidTotal: number;
  /** What the upstream charged US for today's paid calls — revenue minus this
   *  is the real margin. Optional so shards from an older build still merge. */
  cogsToday?: number;
  /** Revenue summed ONLY over calls that also recorded cogs — the correct
   *  denominator for margin. See the note in localSummary. */
  paidWithCogsToday?: number;
  paidWithCogsTotal?: number;
  cogsTotal?: number;
  /** What those same bodies would have cost the caller buying direct, i.e. the
   *  leCore saving. Only present on calls where a counterfactual existed. */
  directToday?: number;
  directTotal?: number;
  callsToday: number;
  callsTotal: number;
  paidToday: number;
  paidTotal: number;
  models: Record<string, number>;
  payersToday: string[];
  payersTotal: string[];
  oldest: string | null;
  newest: string | null;
  retained: number;
  durable: boolean;
};

/** This machine's shard of the aggregate picture. Payers are 8-char prefixes (as the logs always were). */
export function localSummary(): Shard {
  const today = new Date().toISOString().slice(0, 10);
  const counts: Record<string, number> = {};
  const models: Record<string, number> = {};
  const payersToday = new Set<string>();
  const payersTotal = new Set<string>();
  let usdPaidToday = 0, usdPaidTotal = 0, callsToday = 0, paidToday = 0, paidTotal = 0;
  // MARGIN AND THE leCore SAVING, not just revenue. cogsUsd is what the
  // upstream actually charged us and directUsd is what this exact body would
  // have cost the caller buying direct — both come off the quote, so if they
  // are not summed here they cannot be reconstructed later.
  let cogsToday = 0, cogsTotal = 0, directToday = 0, directTotal = 0;
  // LIKE-FOR-LIKE DENOMINATOR. Margin computed as (allPaid - cogs)/allPaid is a
  // lie whenever the window straddles the upgrade that started recording cogs:
  // MEASURED 2026-08-16, $3.90 of pre-upgrade revenue against $0.0000327 of
  // cogs renders 99.999% margin. Sum revenue ONLY over calls that also carry a
  // cogs figure, so the ratio is over the same set of calls.
  let paidWithCogsToday = 0, paidWithCogsTotal = 0;
  for (const e of ring) {
    const isToday = String(e.ts).slice(0, 10) === today;
    const status = e.status || "unknown";
    if (isToday) {
      callsToday += 1;
      counts[status] = (counts[status] || 0) + 1;
      if (e.model) models[e.model] = (models[e.model] || 0) + 1;
      if (e.payer) payersToday.add(e.payer.slice(0, 8));
    }
    if (e.payer) payersTotal.add(e.payer.slice(0, 8));
    if (PAID.has(status)) {
      paidTotal += 1;
      usdPaidTotal += Number(e.billedUsd) || 0;
      const c = Number((e as { cogsUsd?: number }).cogsUsd) || 0;
      cogsTotal += c;
      if (c > 0) paidWithCogsTotal += Number(e.billedUsd) || 0;
      directTotal += Number((e as { directUsd?: number }).directUsd) || 0;
      if (isToday) {
        paidToday += 1;
        usdPaidToday += Number(e.billedUsd) || 0;
        cogsToday += c;
        if (c > 0) paidWithCogsToday += Number(e.billedUsd) || 0;
        directToday += Number((e as { directUsd?: number }).directUsd) || 0;
      }
    }
  }
  return {
    machine: machineId,
    region,
    today,
    counts,
    usdPaidToday: round(usdPaidToday),
    usdPaidTotal: round(usdPaidTotal),
    cogsToday: round(cogsToday),
    paidWithCogsToday: round(paidWithCogsToday),
    paidWithCogsTotal: round(paidWithCogsTotal),
    cogsTotal: round(cogsTotal),
    directToday: round(directToday),
    directTotal: round(directTotal),
    callsToday,
    callsTotal: ring.length,
    paidToday,
    paidTotal,
    models,
    payersToday: [...payersToday],
    payersTotal: [...payersTotal],
    oldest: ring.length ? ring[0].ts : null,
    newest: ring.length ? ring[ring.length - 1].ts : null,
    retained: ring.length,
    durable: persisted,
  };
}

/** Sibling machine 6PN addresses (self excluded) plus how many the app has in total. */
export async function siblings(): Promise<{ peers: string[]; expected: number }> {
  if (!appName) return { peers: [], expected: 1 };
  try {
    const ips = await resolve6(`${appName}.internal`);
    return { peers: ips.filter((ip) => ip !== selfIp), expected: Math.max(ips.length, 1) };
  } catch {
    return { peers: [], expected: 1 };
  }
}

async function askPeer<T>(ip: string, pathAndQuery: string): Promise<T | null> {
  const ctl = AbortSignal.timeout(FANOUT_MS);
  try {
    const r = await fetch(`http://[${ip}]:${port}${pathAndQuery}`, { signal: ctl });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function fanout<T>(pathAndQuery: string): Promise<{ results: T[]; expected: number; responded: number }> {
  const { peers, expected } = await siblings();
  const results = (await Promise.all(peers.map((ip) => askPeer<T>(ip, pathAndQuery)))).filter(Boolean) as T[];
  return { results, expected, responded: results.length + 1 }; // +1 = this machine
}

export function coverage(expected: number, responded: number, extra: Record<string, unknown> = {}) {
  const info = storeInfo();
  return {
    complete: responded >= expected && info.durable,
    machines: { expected, responded },
    durable: info.durable,
    store: info.store,
    retained_events_this_machine: info.retained_events,
    oldest_event_this_machine: info.oldest_event,
    caveat: info.caveat,
    ...(responded < expected
      ? { partial: `${expected - responded} of ${expected} machines did not answer — the numbers above are missing whatever they served` }
      : {}),
    ...extra,
  };
}

export type PublicEvent = ReturnType<typeof publicEvent>;

/** Totals / per-day / per-model rollup over an already-merged event list. */
export function aggregate(events: PublicEvent[]) {
  const byDay = new Map<string, { day: string; calls: number; paid: number; usd: number }>();
  const byModel = new Map<string, { model: string; calls: number; paid: number; usd: number }>();
  let calls = 0, paid = 0, quoted = 0, failed = 0, usd = 0;
  for (const e of events) {
    calls += 1;
    const isPaid = PAID.has(String(e.status));
    if (isPaid) { paid += 1; usd += Number(e.billedUsd) || 0; }
    if (e.status === "402_quoted") quoted += 1;
    if (e.status === "failed_settle" || e.status === "402_invalid") failed += 1;
    const day = String(e.ts).slice(0, 10);
    const d = byDay.get(day) || { day, calls: 0, paid: 0, usd: 0 };
    d.calls += 1; if (isPaid) { d.paid += 1; d.usd += Number(e.billedUsd) || 0; }
    byDay.set(day, d);
    const key = e.model || "(none)";
    const m = byModel.get(key) || { model: key, calls: 0, paid: 0, usd: 0 };
    m.calls += 1; if (isPaid) { m.paid += 1; m.usd += Number(e.billedUsd) || 0; }
    byModel.set(key, m);
  }
  const fix = <T extends { usd: number }>(r: T) => ({ ...r, usd: round(r.usd) });
  return {
    totals: {
      calls,
      paid,
      quoted_not_paid: quoted,
      failed,
      usdPaid: round(usd),
      avgUsdPerPaidCall: paid ? round(usd / paid) : 0,
      firstSeen: events.length ? events[events.length - 1].ts : null,
      lastSeen: events.length ? events[0].ts : null,
    },
    byDay: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)).map(fix),
    byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls).map(fix),
  };
}

/** Sum shards from every machine into one picture. Payer prefixes are unioned, not added. */
export function mergeShards(shards: Shard[]) {
  const counts: Record<string, number> = {};
  const models: Record<string, number> = {};
  const payersToday = new Set<string>();
  const payersTotal = new Set<string>();
  let usdPaidToday = 0, usdPaidTotal = 0, callsToday = 0, callsTotal = 0, paidToday = 0, paidTotal = 0;
  let oldest: string | null = null, newest: string | null = null;
  for (const s of shards) {
    for (const [k, v] of Object.entries(s.counts || {})) counts[k] = (counts[k] || 0) + v;
    for (const [k, v] of Object.entries(s.models || {})) models[k] = (models[k] || 0) + v;
    for (const p of s.payersToday || []) payersToday.add(p);
    for (const p of s.payersTotal || []) payersTotal.add(p);
    usdPaidToday += s.usdPaidToday || 0;
    usdPaidTotal += s.usdPaidTotal || 0;
    callsToday += s.callsToday || 0;
    callsTotal += s.callsTotal || 0;
    paidToday += s.paidToday || 0;
    paidTotal += s.paidTotal || 0;
    if (s.oldest && (!oldest || s.oldest < oldest)) oldest = s.oldest;
    if (s.newest && (!newest || s.newest > newest)) newest = s.newest;
  }
  const topModels = Object.entries(models)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([model, calls]) => ({ model, calls }));
  return {
    today: {
      day: shards[0]?.today ?? new Date().toISOString().slice(0, 10),
      calls: callsToday,
      paid: paidToday,
      quoted_not_paid: counts["402_quoted"] || 0,
      failed_settle: counts["failed_settle"] || 0,
      free: counts.free || 0,
      usdPaid: round(usdPaidToday),
      avgUsdPerPaidCall: paidToday ? round(usdPaidToday / paidToday) : 0,
      distinctPayers: payersToday.size,
      byStatus: counts,
      // THE THREE NUMBERS THAT MATTER TOGETHER, never revenue alone:
      //   usdPaid  what callers paid us
      //   usdCogs  what the upstream charged us for the same work
      //   usdDirect what those bodies would have cost buying direct (leCore off)
      // marginPct is only meaningful when usdPaid > 0; savedVsDirect only when
      // a counterfactual actually existed, so both are null rather than 0.
      usdCogs: round(shards.reduce((n, x) => n + (Number((x as { cogsToday?: number }).cogsToday) || 0), 0)),
      usdPaidWithCogs: round(shards.reduce((n, x) => n + (Number((x as { paidWithCogsToday?: number }).paidWithCogsToday) || 0), 0)),
      usdDirect: round(shards.reduce((n, x) => n + (Number((x as { directToday?: number }).directToday) || 0), 0)),
    },
    retained_window: {
      calls: callsTotal,
      paid: paidTotal,
      usdPaid: round(usdPaidTotal),
      distinctPayers: payersTotal.size,
      oldest,
      newest,
    },
    topModels,
    perMachine: shards.map((s) => ({
      machine: s.machine, region: s.region, retained: s.retained, durable: s.durable,
      callsToday: s.callsToday, paidToday: s.paidToday, usdPaidToday: s.usdPaidToday,
    })),
  };
}

export const usageRingSize = () => ring.length;

/* ------------------------------------------------------------------------- *
 * DAILY ROLLUPS
 *
 * The event ring holds 10,000 events — MEASURED at one point as a 1h39m
 * window — and `today` resets at UTC midnight, so nothing here could answer
 * "how did last week go". A stats page built on the raw endpoint would have
 * had to snapshot it from outside and hope. Instead we fold each day into a
 * durable row as it happens: small, append-safe, and it survives restarts and
 * deploys on the same volume the event log already uses.
 * ------------------------------------------------------------------------- */

const DAILY_FILE = `${DIR}/usage_daily.json`;

export type DayRow = {
  day: string;
  calls: number;
  paid: number;
  free: number;
  quoted_not_paid: number;
  failed_settle: number;
  usdPaid: number;
  usdCogs: number;
  usdDirect: number;
  /** 8-char payer prefixes seen that day; a Set on disk would not round-trip */
  payers: string[];
};

let daily: Record<string, DayRow> = {};
let dailyDirty = false;

function blankDay(day: string): DayRow {
  return { day, calls: 0, paid: 0, free: 0, quoted_not_paid: 0, failed_settle: 0,
    usdPaid: 0, usdCogs: 0, usdDirect: 0, payers: [] };
}

export function initDaily() {
  if (existsSync(DAILY_FILE)) {
    try { daily = JSON.parse(readFileSync(DAILY_FILE, "utf8")) as Record<string, DayRow>; }
    catch { daily = {}; }   // a torn file loses history, never the server
  }
  // SEED FROM THE EVENT LOG, self-healingly. Rollups shipped after the event
  // log already held real traffic, so a day counted only from the moment of
  // deploy read 0 paid / $0 while that same day had genuinely settled calls.
  // initUsage() has already replayed the persisted tail into the ring, so
  // rebuild each day the ring covers and keep whichever row is HIGHER.
  //
  // Higher-wins matters: a stored row that was live-counted for a full day is
  // more complete than the bounded ring, but a row created moments ago is not.
  // The ring can never legitimately exceed a true total, so taking the max
  // repairs the second case without corrupting the first. Recorded events
  // only — nothing here is estimated.
  if (ring.length) {
    const fromRing: Record<string, DayRow> = {};
    const target = daily;
    daily = fromRing;
    for (const e of ring) recordDaily(e);
    daily = target;
    for (const [day, ringRow] of Object.entries(fromRing)) {
      const cur = daily[day];
      if (!cur || ringRow.paid > cur.paid || ringRow.calls > cur.calls) {
        (ringRow as DayRow & { seeded?: boolean }).seeded = true;
        daily[day] = ringRow;
        dailyDirty = true;
      }
    }
  }
}

/** Fold one event into its day. Never throws — telemetry must not fail a request. */
export function recordDaily(e: UsageEvent) {
  try {
    const day = String(e.ts).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const row = (daily[day] ||= blankDay(day));
    row.calls += 1;
    const status = e.status || "unknown";
    if (status === "free") row.free += 1;
    if (status === "402_quoted") row.quoted_not_paid += 1;
    if (status === "failed_settle") row.failed_settle += 1;
    if (PAID.has(status)) {
      row.paid += 1;
      row.usdPaid += Number(e.billedUsd) || 0;
      row.usdCogs += Number((e as { cogsUsd?: number }).cogsUsd) || 0;
      row.usdDirect += Number((e as { directUsd?: number }).directUsd) || 0;
    }
    if (e.payer) {
      const p = e.payer.slice(0, 8);
      if (!row.payers.includes(p)) row.payers.push(p);
    }
    dailyDirty = true;
  } catch { /* never fail a request over stats */ }
}

/** Flush at most once per interval — one small whole-file write, not per event. */
export function flushDaily() {
  if (!dailyDirty || !persisted) return;
  try {
    writeFileSync(DAILY_FILE, JSON.stringify(daily));
    dailyDirty = false;
  } catch { /* disk trouble must not take down serving */ }
}

const pct = (now: number, prev: number): number | null =>
  prev > 0 ? Math.round(((now - prev) / prev) * 1000) / 10 : null;
const roundTo = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function shapeDay(r: DayRow) {
  const quoted = r.quoted_not_paid;
  return {
    day: r.day,
    calls: r.calls,
    paid: r.paid,
    free: r.free,
    quoted_not_paid: quoted,
    failed_settle: r.failed_settle,
    usdPaid: roundTo(r.usdPaid, 6),
    usdCogs: roundTo(r.usdCogs, 6),
    usdDirect: roundTo(r.usdDirect, 6),
    distinctPayers: r.payers.length,
    // Computed HERE, not in the browser, so the site and the in-app HUD can
    // never disagree about margin or the saving multiple.
    marginPct: r.usdPaid > 0 ? roundTo(((r.usdPaid - r.usdCogs) / r.usdPaid) * 100, 1) : null,
    lecoreSavingX: r.usdPaid > 0 ? roundTo(r.usdDirect / r.usdPaid, 2) : null,
    conversionPct: r.paid + quoted > 0 ? roundTo((r.paid / (r.paid + quoted)) * 100, 1) : null,
    // true when this day was reconstructed from the bounded event ring at boot
    // rather than counted live — the totals are a floor, not a full day.
    partial: (r as DayRow & { seeded?: boolean }).seeded === true || undefined,
  };
}

export function statsPayload(topModels: { model: string; calls: number }[]) {
  const days = Object.keys(daily).sort().map((d) => shapeDay(daily[d]));
  const today = days[days.length - 1] ?? shapeDay(blankDay(new Date().toISOString().slice(0, 10)));
  const prev = days.length >= 2 ? days[days.length - 2] : null;

  // null, never 0, when there is not enough history — a zero would render as a
  // flat line and read as "no growth" rather than "no data".
  const dayOverDay = prev ? {
    calls: pct(today.calls, prev.calls),
    paid: pct(today.paid, prev.paid),
    usdPaid: pct(today.usdPaid, prev.usdPaid),
    distinctPayers: pct(today.distinctPayers, prev.distinctPayers),
  } : null;

  const sum = (rows: typeof days, k: "calls" | "paid" | "usdPaid") =>
    rows.reduce((a, r) => a + (r[k] as number), 0);
  const last7 = days.slice(-7);
  const prev7 = days.slice(-14, -7);
  const trailing7 = last7.length ? {
    calls: sum(last7, "calls"),
    paid: sum(last7, "paid"),
    usdPaid: roundTo(sum(last7, "usdPaid"), 6),
    avgDailyUsd: roundTo(sum(last7, "usdPaid") / last7.length, 6),
  } : null;
  const weekOverWeek = prev7.length === 7 && last7.length === 7 ? {
    calls: pct(sum(last7, "calls"), sum(prev7, "calls")),
    paid: pct(sum(last7, "paid"), sum(prev7, "paid")),
    usdPaid: pct(sum(last7, "usdPaid"), sum(prev7, "usdPaid")),
  } : null;

  return {
    app: "x402-tokens",
    today,
    days,
    growth: { dayOverDay, weekOverWeek, trailing7 },
    topModels,
    coverage: {
      days: days.length,
      since: days[0]?.day ?? null,
      complete: true,
      caveat: "daily rows are folded from live events and persisted to the machine volume; "
        + "history starts the day this rollup shipped and is never backfilled",
      identifying: "none — payer counts are distinct 8-char prefixes, never full addresses or IPs",
    },
  };
}
