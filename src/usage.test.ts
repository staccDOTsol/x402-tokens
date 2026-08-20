/** Usage store: the ring stays bounded, the jsonl survives a "restart",
 *  rotation caps the file, and no read path ever emits an IP. */
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

const dir = mkdtempSync(join(tmpdir(), "usage-"));
process.env.USAGE_DIR = dir;
process.env.USAGE_RING_MAX = "50";
process.env.USAGE_MAX_BYTES = "4096";

const u = await import("./usage.js");
u.initUsage();

const ev = (i: number, extra: Record<string, unknown> = {}) => ({
  ts: new Date(Date.UTC(2026, 7, 14, 0, 0, i)).toISOString(),
  path: "/v1/chat/completions",
  status: "402_quoted",
  model: "openai/gpt-4o-mini",
  bodyBytes: 100,
  ip: "18.212.131.x",
  ...extra,
});

for (let i = 0; i < 120; i++) u.record(ev(i));
ok(u.usageRingSize() === 50, "ring stays at USAGE_RING_MAX (50) after 120 events");

const file = join(dir, "usage_events.jsonl");
ok(existsSync(file), "events are appended to usage_events.jsonl when the dir exists");
ok(statSync(file).size <= 4096 * 2, "the live file is rotated near USAGE_MAX_BYTES");
ok(existsSync(file + ".1"), "one older generation is kept");

// paid rows carry the FULL payer + tx; the public projection drops the ip
const PAYER = "HLyPVoGK3yxkUoCybWQiHXETEPA8KxPdpQ1Q9pVGGhku";
// paid rows use ts=NOW: paidToday counts the CURRENT utc day, and hardcoded
// event dates rotted this test two days after it was written
u.record({ ...ev(200, { status: "paid_200", payer: PAYER, billedUsd: 0.0002, tx: "SIG1", upstream: 200 }), ts: new Date().toISOString() });
u.record({ ...ev(201, { status: "paid_200", payer: PAYER, billedUsd: 0.0004, tx: "SIG2", upstream: 200 }), ts: new Date(Date.now() + 1000).toISOString() });

const mine = u.localEventsFor(PAYER, 10);
ok(mine.length === 2, "localEventsFor finds both paid rows for the exact address");
ok(u.localEventsFor(PAYER.slice(0, 8), 10).length === 2, "an 8-char prefix matches the full stored address");
ok(u.localEventsFor("QQQQQQQQ", 10).length === 0, "a different payer matches nothing");
ok(u.payerMatches(PAYER, "HLy") === null, "a <6 char prefix is refused, so payers can't be enumerated by one letter");

const pub = mine.map(u.publicEvent);
ok(!JSON.stringify(pub).includes("18.212"), "publicEvent never returns an ip, not even a truncated one");
ok(pub[0].tx === "SIG2" && pub[0].payer === PAYER, "public rows keep the on-chain tx + payer");

const roll = u.aggregate(pub);
ok(roll.totals.paid === 2, "aggregate counts both paid calls");
ok(roll.totals.usdPaid === 0.0006, `aggregate sums usd to 0.0006 (got ${roll.totals.usdPaid})`);
ok(roll.totals.avgUsdPerPaidCall === 0.0003, "average per paid call is usd/paid");
const today = new Date().toISOString().slice(0, 10);
ok(roll.byDay[0].day === today && roll.byDay[0].paid === 2, "byDay buckets on the UTC day");
ok(roll.byModel[0].model === "openai/gpt-4o-mini", "byModel names the model");

const merged = u.mergeShards([u.localSummary(), { ...u.localSummary(), machine: "other", callsToday: 3, paidToday: 1, usdPaidToday: 0.001, payersToday: [PAYER.slice(0, 8)], payersTotal: [PAYER.slice(0, 8)] }]);
ok(merged.today.paid === 3, "shard paid counts add up across machines");
ok(merged.today.distinctPayers === 1, "the same payer on two machines is ONE distinct payer, not two");
ok(merged.perMachine.length === 2, "perMachine lists every shard that answered");

// a restart: fresh module instance, same dir, replay from disk
const fresh = await import(`./usage.js?rev=${Date.now()}`);
fresh.initUsage();
ok(fresh.usageRingSize() > 0, "a restart replays the tail of the jsonl into the ring");
ok(fresh.localEventsFor(PAYER, 10).length === 2, "the paid rows survive the restart");
ok(fresh.storeInfo().durable === true, "storeInfo says durable when the volume dir exists");

const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
ok(lines.every((l) => JSON.parse(l).ts), "every persisted line is parseable json with a ts");

ok(u.dollarSavingX(14, 3) === 4.67, "HUD savingX is direct/spent, rounded");
ok(u.dollarSavingX(10, 1) === 10, "a single call's multiple is fine");
ok(Math.abs((u.dollarSavingX(14, 3) ?? 0) - (10 + 2)) > 1, "HUD is not the sum of per-call savesVsDirect multiples");

console.log("usage store ok");
