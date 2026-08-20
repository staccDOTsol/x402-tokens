/** First-X-back policy: countable answers, last-of-X fallback, race-level fail. */
import {
  brainRace, isRaceCountable, parseClassifyScore, parseRace, pickRaceWinner,
  raceLastShip, RACE_EVERY_FAILED,
} from "./race.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

ok(!isRaceCountable(""), "empty is not countable");
ok(!isRaceCountable("fetch failed"), "fetch failed string is not countable");
ok(!isRaceCountable("TypeError: fetch failed"), "TypeError fetch failed is not countable");
ok(!isRaceCountable({ text: "ok", error: "boom" }), "arrival.error is not countable");
ok(!isRaceCountable("(seed-2.0-code failed: fetch failed)"), "model-failed note is not countable");
ok(!isRaceCountable("(upstream error — HTTP 503, try again)"), "http note is not countable");
ok(isRaceCountable("hello"), "real text is countable");

ok(raceLastShip([{ model: "a", text: "", error: "x" }, { model: "b", text: "fetch failed" }]).text === RACE_EVERY_FAILED,
  "all-fail last-ship is the race-level error");
ok(raceLastShip([{ model: "a", text: "one" }, { model: "b", text: "two" }]).text === "two",
  "last countable wins the fallback ship");

ok(parseClassifyScore("SCORE 9") === 9, "SCORE 9");
ok(parseClassifyScore("score: 3") === 3, "score: 3");
ok(pickRaceWinner([{ model: "a", text: "x", score: 2 }, { model: "b", text: "y", score: 3 }], 6).reason === "fallback-last",
  "nobody clears the bar → last of the X");
ok(pickRaceWinner([{ model: "a", text: "x", score: 2 }, { model: "b", text: "y", score: 3 }], 6).winner?.text === "y",
  "fallback last is the last candidate");
ok(pickRaceWinner([{ model: "a", text: "x", score: 9 }, { model: "b", text: "y", score: 7 }], 6).winner?.model === "a",
  "highest passing score wins");

const spec = parseRace({ race: 4, race_need: 2, tier: "cheap" });
ok(!!spec && spec.n === 4 && spec.need === 2 && spec.tier === "cheap", "parse race 4 need 2");
ok(parseRace({}) === null, "omit race → single-model");
const def = parseRace({ race: true });
ok(!!def && def.n === 4 && def.need === 2, "race:true defaults first 2 of 4");

function scripted(specMap: Record<string, { text?: string; err?: Error; empty?: boolean; at: number }>) {
  return async (model: string) => {
    const s = specMap[model];
    if (!s) throw new Error("unexpected " + model);
    await sleep(s.at);
    if (s.err) throw s.err;
    if (s.empty) return "";
    return s.text ?? "";
  };
}

{
  const classified: string[] = [];
  const text = await brainRace({
    messages: [{ role: "user", content: "q" }],
    models: ["boom", "a", "b", "late"],
    need: 2,
    run: scripted({
      boom: { err: Object.assign(new TypeError("fetch failed"), { name: "TypeError" }), at: 5 },
      a: { text: "real-one", at: 15 },
      b: { text: "real-two", at: 30 },
      late: { text: "should-not-enter", at: 200 },
    }),
    classify: async (_m, c) => {
      classified.push(c.text);
      return c.text === "real-two" ? 9 : 7;
    },
  });
  ok(text.text === "real-two", "fetch-failed racer dropped; two real answers classify");
  ok(!/failed: fetch failed/.test(text.text), "winner is not a fetch-failed string");
  ok(classified.slice().sort().join(",") === "real-one,real-two", "only the first two countable are judged");
  ok(text.error === false, "a real answer is not a race-level error");
}

{
  const text = await brainRace({
    messages: [{ role: "user", content: "q" }],
    models: ["a", "b", "c", "d"],
    need: 2,
    run: scripted({
      a: { err: new TypeError("fetch failed"), at: 4 },
      b: { err: new TypeError("fetch failed"), at: 8 },
      c: { err: new TypeError("fetch failed"), at: 12 },
      d: { err: new TypeError("fetch failed"), at: 16 },
    }),
    classify: async () => { throw new Error("classify must not run"); },
  });
  ok(text.error === true, "all fail → race-level error");
  ok(text.text === RACE_EVERY_FAILED, "all fail ships the race-level message");
  ok(!/mistral|seed-2.0|failed: fetch failed/.test(text.text), "not a per-model failure string");
}

{
  const statuses: string[] = [];
  await brainRace({
    messages: [{ role: "user", content: "q" }],
    models: ["a", "b"],
    need: 2,
    run: scripted({ a: { text: "one", at: 10 }, b: { text: "two", at: 20 } }),
    classify: async () => 1,
    onStatus: (s) => statuses.push(s),
  });
  ok(statuses.includes("racing 0/2 back…"), "status starts at 0/2");
  ok(statuses.includes("racing 1/2 back…"), "status 1/2");
  ok(statuses.includes("racing 2/2 back…"), "status 2/2");
  ok(statuses.includes("judging…"), "status judging");
}

console.log("race policy ok");
