/** 100-turn / huge-char spill: short tail + context id, even when x-hrr-context is already set. */
import {
  applySpillCut,
  createSpillStats,
  hudDollarX,
  spillTranscript,
  _resetSessionMemo,
} from "./spill.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

_resetSessionMemo();

const turn = (i: number) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `turn ${i} ` + "context padding ".repeat(40),
});

const hundred = Array.from({ length: 100 }, (_, i) => turn(i));
const book = {
  model: "m",
  messages: [
    { role: "system", content: "you are a helpful zoo" },
    ...hundred,
  ],
};

const binds: Array<{ items: number; ctx?: string }> = [];
const bind = async (items: Array<{ text: string }>, contextId?: string) => {
  binds.push({ items: items.length, ctx: contextId });
  return { context_id: contextId && contextId.startsWith("ctx_") ? contextId : "ctx_NEW" };
};

// 1. Claude-CLI shape: no header, huge body → bind + send ~3/N
{
  binds.length = 0;
  const r = await spillTranscript(book, { bind, sessionKey: "sid:cli" });
  ok(!!r, "CLI-shaped 100-turn body spills");
  ok(r!.engaged, "CLI spill engaged");
  ok(r!.total === 101, `total turns include system (got ${r!.total})`);
  ok(r!.sent <= 8 && r!.sent >= 2, `CLI sends a short tail (got ${r!.sent}/${r!.total})`);
  ok(r!.sent < r!.total, "CLI does not forward the whole transcript");
  ok(r!.contextId === "ctx_NEW", `CLI bind minted a context id (got ${r!.contextId})`);
  ok(binds.length >= 1 && !binds[0].ctx, "first CLI bind has no prior id");
  const fwd = r!.body.messages as Array<{ role?: string; content?: string }>;
  ok(fwd[0].role === "system", "system prompt stays");
  ok(fwd[fwd.length - 1].content === hundred[99].content, "live ask survives");
  ok(/sending \d+\/101 turns/.test(r!.log), `log names sent/total (got ${r!.log})`);
  console.log("   ", r!.log);
}

// 2. Header already set (grokui): STILL cut, APPEND/reuse the id
{
  binds.length = 0;
  const r = await spillTranscript(book, { bind, headerCtx: "ctx_GROK", sessionKey: "sid:grok" });
  ok(!!r && r.engaged, "header-already-set still spills");
  ok(r!.contextId === "ctx_GROK", `reuses the caller id (got ${r!.contextId})`);
  ok(r!.reused, "reuse flag set when header supplied");
  ok(r!.sent <= 8, `header-set still forwards a short tail (got ${r!.sent})`);
  ok(binds.some((b) => b.ctx === "ctx_GROK"), "bind was told to append to the existing id");
  const chars = JSON.stringify(r!.body.messages).length;
  ok(chars < JSON.stringify(book.messages).length / 4, `cut body is much smaller (${chars} vs ${JSON.stringify(book.messages).length})`);
}

// 3. Huge-char single ask (850k-class), with header already set
{
  binds.length = 0;
  const huge = "NEEDLE-in-haystack ".repeat(50_000); // ~1M chars
  const r = await spillTranscript(
    { model: "m", messages: [{ role: "user", content: huge + "\n\nwho is jarett?" }] },
    { bind, headerCtx: "ctx_FAT" },
  );
  ok(!!r && r.engaged, "huge single message spills");
  ok(r!.contextId === "ctx_FAT", "huge body with header reuses the id");
  const last = (r!.body.messages as Array<{ content?: string }>).slice(-1)[0];
  ok(String(last.content).length < 8_000, `huge ask forwarded as a short tail (${String(last.content).length} chars)`);
  ok(String(last.content).includes("who is jarett?"), "the ask survives the huge cut");
  ok(r!.prefixChars > 100_000, `prefix bound was large (got ${r!.prefixChars})`);
}

// 4. Bind failure still cuts — never fail-open to the book
{
  const dead = async () => { throw new Error("sidecar down"); };
  const r = await spillTranscript(book, { bind: dead, headerCtx: "ctx_DEAD" });
  ok(!!r, "bind failure still returns a cut");
  ok(r!.sent <= 8, `fail-open still sends a short tail (got ${r!.sent})`);
  ok((r!.body.messages as unknown[]).length < 20, "fail-open did not forward 101 turns");
}

// 5. Dollar HUD: sum dollars, never sum savesVsDirect
{
  const stats = createSpillStats();
  stats.noteQuote({ directUsd: 10, spentUsd: 1 });
  stats.noteQuote({ directUsd: 4, spentUsd: 2 });
  const snap = stats.snapshot();
  ok(snap.direct === 14 && snap.spend === 3, "HUD sums dollars");
  ok(snap.savingX === 14 / 3, `savingX is direct/spent (${snap.savingX})`);
  ok(snap.savedUsd === 11, "savedUsd is direct - spent");
  // The wrong method: sum of per-call multiples 10/1 + 4/2 = 12, which is not 14/3.
  const summedMultiples = 10 / 1 + 4 / 2;
  ok(Math.abs((snap.savingX ?? 0) - summedMultiples) > 1, "HUD is not the sum of savesVsDirect multiples");
  ok(hudDollarX({ directUsd: 10, spentUsd: 2 }) === 5, "hudDollarX is direct/spent");
  ok(hudDollarX({ spillDirect: 8, spillSpend: 2 }) === 4, "hudDollarX reads spill dollars");
}

// 6. applySpillCut: 100 user/assistant turns → last few
{
  const got = applySpillCut(hundred, { knobs: { keepTail: 3, minTurns: 2, budget: 6000 } });
  ok(got.cut > 0, "cut is inside the transcript");
  const tail = hundred.length - got.cut;
  ok(tail <= 8 && tail >= 2, `applySpillCut keeps a short tail (${tail})`);
}

console.log("\nspill selftest OK");
