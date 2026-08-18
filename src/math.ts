/** Pure quote maths. No I/O — selftest hits these. */

export function estimateTokens(messages: unknown): number {
  const s = typeof messages === "string" ? messages : JSON.stringify(messages ?? "");
  return Math.max(1, Math.ceil(s.length / 4));
}

export function openrouterUsd(promptPrice: number, completionPrice: number, promptTokens: number, maxOut: number): number {
  const usd = promptTokens * promptPrice + maxOut * completionPrice;
  if (!Number.isFinite(usd) || usd < 0) throw new Error("bad openrouter price");
  return usd;
}

/** Ceiling conversion of a USD bill into raw token units at a USD spot.
 *
 *  DONE IN BIGINT, not float64. The previous version computed
 *  `(usd / tokenUsd) * 10 ** decimals` as a double and rejected anything past
 *  Number.MAX_SAFE_INTEGER as "amount overflow". That holds for 6-decimal
 *  Solana mints, and breaks the moment an 18-decimal EVM token is cheap:
 *  MEASURED, $0.010686 of ODDBALLER at $5.712e-8 is 1.87e23 raw units, ~2e7x
 *  past 2^53. It was never an overflow, it was the wrong number type — and a
 *  payment rail that throws on a legitimate quote silently drops that asset.
 *
 *  USD and spot are carried at 1e12 fixed point (ample for sub-nano prices);
 *  a spot that rounds to zero there fails closed rather than dividing by it. */
const FX = 1_000_000_000_000n; // 1e12

export function usdToRaw(usd: number, tokenUsd: number, decimals: number): bigint {
  if (!(tokenUsd > 0) || !Number.isFinite(tokenUsd)) throw new Error("no spot");
  if (!(usd >= 0) || !Number.isFinite(usd)) throw new Error("bad usd");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("bad decimals");
  const spotFx = BigInt(Math.round(tokenUsd * Number(FX)));
  if (spotFx <= 0n) throw new Error("spot rounds to zero at 1e-12 — refusing to price");
  const usdFx = BigInt(Math.round(usd * Number(FX)));
  const num = usdFx * 10n ** BigInt(decimals);
  const raw = (num + spotFx - 1n) / spotFx; // ceiling
  return raw > 0n ? raw : 1n;
}

/**
 * VOLUME CURVE — the fraction of OpenRouter's OWN direct price a tenant pays,
 * as a function of what that tenant has already spent here in the trailing
 * window.
 *
 *     rate(S) = clamp( rateMax / (1 + S/scaleUsd)^decay , rateFloor, rateMax )
 *
 * The pricing contract is two sentences, and both of them are properties of
 * this shape rather than of a table of hand-written tiers:
 *
 *   1. NEVER MORE THAN OPENROUTER. rate(0) = rateMax = 1, and the curve is
 *      bounded above by rateMax, so the most expensive call anyone can ever
 *      buy here is exactly what buying it direct would have cost. The old
 *      flat 3x is gone: there is no expression in this file that can produce
 *      a number above 1.
 *
 *   2. TALK MORE, PAY LESS. dr/dS <= 0 everywhere and the curve is
 *      CONTINUOUS — no tier cliff, so there is no spend level at which one
 *      more dollar moves the unit price discontinuously. (Same no-cliff law
 *      quote.ts already enforces across body size; a pricing surface with a
 *      step in it is a pricing surface someone games.)
 *
 * A power law rather than an exponential because spend is scale-free: the
 * interesting range spans $0.001 to $10,000 and an exponential either does
 * nothing at the bottom or saturates instantly at the top. With the shipped
 * defaults (scale $10, decay 0.25, floor 0.25):
 *
 *      trailing 30d spend      rate      vs direct
 *      $0                      1.000     par
 *      $1                      0.977     2% off
 *      $10                     0.841     16% off
 *      $100                    0.549     45% off
 *      $1,000                  0.315     68% off
 *      $2,550+                 0.250     75% off (floor)
 *
 * `rateFloor` is a policy floor, not a safety floor: quote.ts additionally
 * refuses to price under our own forwarded cost, and that cost floor always
 * wins. See quoteRequest.
 */
export interface VolumeCurve {
  /** ceiling, 1 = OpenRouter's own price. Nothing may exceed this. */
  rateMax: number;
  /** policy floor on the fraction of direct a tenant can reach. */
  rateFloor: number;
  /** spend, in USD, at which the curve has moved one unit of `decay`. */
  scaleUsd: number;
  /** exponent. 0 disables the curve (everyone pays rateMax). */
  decay: number;
}

/**
 * The curve is optional at the call site on purpose. A missing or half-filled
 * curve must degrade to "everyone pays the ceiling", never throw: this runs
 * inside quoteRequest, and an exception here does not mis-price a call, it
 * turns the 402 into a 500 and takes the gateway down for everyone.
 */
export function volumeRate(spendUsd: number, c?: Partial<VolumeCurve>): number {
  if (!c) return 1;
  const max = Number.isFinite(c.rateMax) && (c.rateMax as number) > 0 ? Math.min(c.rateMax as number, 1) : 1;
  const floor = Number.isFinite(c.rateFloor) ? Math.min(Math.max(c.rateFloor as number, 0), max) : max;
  const scale = Number.isFinite(c.scaleUsd) && (c.scaleUsd as number) > 0 ? (c.scaleUsd as number) : 0;
  const decay = Number.isFinite(c.decay) && (c.decay as number) > 0 ? (c.decay as number) : 0;
  // A non-finite or negative spend is a bug upstream, never a discount: fall
  // back to the ceiling rather than pricing off garbage.
  const s = Number.isFinite(spendUsd) && spendUsd > 0 ? spendUsd : 0;
  if (!scale || !decay) return max;
  const r = max / Math.pow(1 + s / scale, decay);
  if (!Number.isFinite(r)) return floor;
  return Math.min(max, Math.max(floor, r));
}

/**
 * Token-2022 transfer-fee gross-up. `feeBps` is out of 10_000.
 * Sign `gross` so the destination receives `net` after withhold.
 */
export function grossUp(net: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return net;
  if (feeBps >= 10_000) throw new Error("fee bps >= 100%");
  return (net * 10_000n + BigInt(10_000 - feeBps) - 1n) / BigInt(10_000 - feeBps);
}
