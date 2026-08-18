import { estimateTokens, grossUp, openrouterUsd, usdToRaw, volumeRate } from "./math.js";

const CURVE = { rateMax: 1, rateFloor: 0.25, scaleUsd: 10, decay: 0.25 };

let fails = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  const ok = Object.is(a, b) || a === b;
  if (!ok) {
    fails++;
    console.log(`FAIL ${m}: got ${a} want ${b}`);
  }
};

eq(estimateTokens("abcd"), 1, "4 chars = 1 token");
eq(estimateTokens("abcdefgh"), 2, "8 chars = 2 tokens");

const usd = openrouterUsd(0.00000015, 0.0000006, 100, 50);
eq(Number(usd.toFixed(10)), 0.000045, "openrouter usd");
// the CEILING is OpenRouter's own rate: a quote may never exceed 1x this.
eq(Number((usd * 1).toFixed(10)), 0.000045, "1x direct is the ceiling");
eq(volumeRate(0, CURVE), 1, "a fresh tenant pays exactly the ceiling");
eq(volumeRate(1e9, CURVE), 0.25, "a heavy tenant bottoms out at the rate floor");

eq(usdToRaw(1, 1, 6), 1_000_000n, "$1 of a $1/6dp token");
eq(usdToRaw(0.000045, 1, 6), 45n, "tiny bill in yUSDCx");
eq(usdToRaw(0.003, 0.001, 6), 3_000_000n, "$0.003 of a $0.001 token");

eq(grossUp(10000n, 0), 10000n, "no fee");
eq(grossUp(10000n, 20), 10021n, "20 bps gross-up");
eq(grossUp(1n, 20), 2n, "1 raw still grosses");

if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log("selftest ok");
