import type { Asset, Config } from "./config.js";
import { estimateTokens, grossUp, openrouterUsd, usdToRaw, volumeRate } from "./math.js";
import { getModel } from "./openrouter.js";

export interface QuoteLine {
  symbol: string;
  mint: string;
  network: string;
  decimals: number;
  tokenUsd: number;
  billedUsd: number;
  netRaw: string;
  grossRaw: string;
  feeBps: number;
  pricedAt: string;
  /** Chain-correct payee for this row (EVM rows cannot use the Solana payTo). */
  payTo?: string;
  /** EIP-712 domain for EVM rows, so the payer signs the domain the
   *  facilitator will recover against. */
  eip712?: { name: string; version: string };
  /** true when the price API was down/rate-limited and this line was priced
   *  from the last known spot (bounded by SPOT_STALE_MAX_MS). pricedAt then
   *  names when that spot was actually fetched, not now. */
  priceStale?: boolean;
}

export interface Quote {
  model: string;
  promptTokensEst: number;
  maxOut: number;
  openrouterUsd: number;
  markup: number;
  billedUsd: number;
  pricedAt: string;
  accepts: QuoteLine[];
  /**
   * How this price was formed.
   *   "volume"         — a fraction of OpenRouter's own direct rate, set by
   *                      the tenant's trailing spend. The default text lane.
   *   "counterfactual" — same, times the extra leCore compression discount,
   *                      because we forwarded far fewer tokens than the caller
   *                      would have bought direct.
   *   "markup"         — units/media only (Together per-image / per-clip), and
   *                      credit top-ups at markup 1. There is no OpenRouter
   *                      price for a diffusion job to be cheaper than.
   */
  pricing: "markup" | "counterfactual" | "volume";
  directUsd?: number;
  discount?: number;
  /**
   * How many TIMES cheaper than buying direct this call was: directUsd /
   * billedUsd. Under the pricing contract it is now always >= 1 — the ceiling
   * makes billedUsd <= directUsd by construction — so it can be read as a
   * "Nx cheaper" multiple without a sign check.
   *
   * It used to be able to come out BELOW 1 (0.3333 on every straight-3x
   * markup call), which meant a UI printing "saves 0.33x" was reporting a 3x
   * OVERCHARGE as a saving. That ambiguity is why the two unambiguous fields
   * below exist; prefer them in new clients.
   */
  savesVsDirect?: number;
  /** Fraction of direct actually paid, in [0,1]. billedUsd / directUsd. */
  rate?: number;
  /** Fraction of direct NOT paid, in [0,1]. 1 - rate. "45% off". */
  savedPct?: number;
  /** Absolute USD kept vs buying direct. directUsd - billedUsd, never < 0. */
  savedUsd?: number;
  /** Why the rate is what it is, so a caller can see the curve rather than
   *  infer it. */
  volume?: {
    /** trailing-window spend this tenant had BEFORE this call */
    spendUsd: number;
    /** the usage rate alone, before the leCore discount and the cost floor */
    rate: number;
    /** the best rate this curve can ever reach */
    rateFloor: number;
    windowDays: number;
  };
  flooredAtCost?: boolean;
  /** Media only. Names HOW the upstream cost was derived ("per-image",
   *  "per-megapixel", "per-clip-block") because for image/video it is an
   *  estimate against a vendor example rather than a metered token count —
   *  the caller should be able to see that distinction in the 402. */
  priceModel?: string;
}

/**
 * WEB SEARCH IS A FLAT SURCHARGE, AND IT IS NOT SMALL.
 *
 * OpenRouter's `web` plugin is search-then-inject middleware, so it works on
 * EVERY model — there is no such thing as a model here that "cannot" search,
 * and nothing needs routing to a search-native model. What it is not is free.
 *
 * MEASURED 2026-08-16 against google/gemini-2.5-flash, twice, exact to 6dp:
 *   max_results=1 -> total $0.007174, tokens $0.000174, web portion $0.007000
 *   max_results=3 -> total $0.0072551, tokens $0.0002551, web portion $0.007000
 * Flat per request, NOT per result. Left unpriced it is ruinous on cheap
 * models: that first call's tokens are worth $0.000255, so quoting from tokens
 * alone would have billed ~28x under our own cost — and we settle before the
 * upstream call, so every one of those is a straight loss.
 */
export const WEB_PLUGIN_USD = Number(process.env.WEB_PLUGIN_USD || 0.007);

/** True when this body will make OpenRouter run a web search — either the
 *  `web` plugin, or the `:online` model shorthand which implies it. */
export function usesWebSearch(body: { model?: string; plugins?: unknown }): boolean {
  if (typeof body.model === "string" && body.model.endsWith(":online")) return true;
  const plugins = body.plugins;
  if (!Array.isArray(plugins)) return false;
  return plugins.some((p) => p && typeof p === "object" && (p as { id?: string }).id === "web");
}

/** `:online` is an OpenRouter routing shorthand, not a catalog id — the model
 *  list has no "…:online" row, so pricing must look up the bare model while the
 *  suffix still ships upstream. */
export function baseModelId(id: string): string {
  return id.endsWith(":online") ? id.slice(0, -":online".length) : id;
}

export async function quoteRequest(
  cfg: Config,
  body: { model?: string; messages?: unknown; max_tokens?: number; plugins?: unknown },
  counterfactualTokens?: number,
  /** This tenant's spend in the trailing volume window, BEFORE this call.
   *  0 / omitted = a brand-new tenant, who pays the ceiling. */
  tenantSpendUsd = 0,
): Promise<Quote> {
  const modelId = body.model || cfg.defaultModel;
  const model = await getModel(cfg.openrouterUrl, cfg.openrouterKey, baseModelId(modelId));
  const webUsd = usesWebSearch(body) ? WEB_PLUGIN_USD : 0;
  const promptTokens = estimateTokens(body.messages);
  // MEASURED (ttfx goldrun, 2026-08-15): reasoning models BILL their thinking.
  // Callers asked 8k-32k max_tokens and providers charged 16-19k completion
  // tokens per ask, but this clamp priced at most 4,096 of output — the floor
  // protected $0.37 of a $1.62 upstream completion and sol/fable ran at
  // negative margin for hours. The clamp exists to stop absurd quotes on
  // absurd asks; 32k covers every real reasoning budget we have seen.
  const maxOut = Math.min(Math.max(1, Number(body.max_tokens ?? 256)), 32768);
  // web surcharge rides on the UPSTREAM cost, so it flows through markup, the
  // counterfactual floor and every rail conversion exactly like token cost
  const baseUsd = openrouterUsd(model.prompt, model.completion, promptTokens, maxOut) + webUsd;

  // THE PRICING CONTRACT (2026-08-18): OPENROUTER IS THE CEILING, AND THE
  // PRICE FALLS AS A TENANT TALKS MORE.
  //
  // What this replaced: a flat `billedUsd = baseUsd * 3`. On every call where
  // leCore did not compress anything — which is MOST calls, since short bodies
  // never reach the spill threshold — that meant the caller paid 3x what the
  // identical request costs at openrouter.ai. There is no story in which that
  // survives someone opening a calculator, and it made the gateway strictly
  // worse than the thing it sits in front of for the entire small-body regime.
  //
  // The replacement has exactly two rules:
  //
  //   CEILING.  billedUsd <= directUsd, always. `directUsd` is what buying
  //             this same body from OpenRouter costs; when leCore did not
  //             engage that is literally our own cost, so the ceiling is also
  //             the honest at-cost price. Nothing below can breach it: the
  //             final Math.min is unconditional.
  //
  //   DECREASE. The fraction of direct a tenant pays is volumeRate(spend),
  //             which is 1.0 for their first call and decays monotonically
  //             toward cfg.volume.rateFloor as their trailing-window spend
  //             grows. Continuous, so no tier cliff.
  //
  // DECREASING IN WHAT, AND WHY THAT AXIS: trailing 30-day BILLED SPEND per
  // tenant, not call count and not token count. Call count is free to
  // manufacture (a thousand one-token pings would buy the floor rate for a
  // dollar); tokens are free to manufacture in the other direction (pad the
  // body). Spend is the one axis where gaming it costs exactly what it buys.
  //
  // WHERE THE DISCOUNT COMES FROM, honestly: it is funded by leCore. A bind is
  // the expensive event and later asks against the same bound context are
  // near-free (MEASURED: a $0.021372 direct call cost $0.000367 to serve), so
  // the tenants who talk most are precisely the tenants whose calls are
  // cheapest for us to serve. The curve pays that back. On a call where leCore
  // did nothing our cost IS the direct price, the cost floor binds, and the
  // caller pays the 1x ceiling — we cannot discount margin that does not
  // exist, and we do not pretend otherwise.
  const usageRate = volumeRate(tenantSpendUsd, cfg.volume);

  // COUNTERFACTUAL PRICING. A markup on the tokens we forward is
  // anti-correlated with a product whose whole job is to forward fewer tokens:
  // MEASURED on a 60k needle, leCore cut a $0.021372 direct call to $0.000367 of
  // real cost, so the same 3x markup that earned $0.042744/call without leCore
  // earned $0.000734 WITH it -- shipping the feature cut revenue 58x. Charging
  // 2x post-spill makes it worse, not better.
  //
  // So when leCore engaged we price against what the caller WOULD have paid
  // buying this body direct (counterfactualTokens = pre-spill), discounted.
  // At discount 0.5 the caller pays half of list and we clear ~14x today's
  // margin. This is value-based pricing and the storefront must say so in those
  // words -- "half the price of buying direct", never "3x provider take", which
  // becomes a lie the moment someone computes the real token spend.
  //
  // The floor exists because a discount on a pathological body could otherwise
  // price under our own cost.
  const direct = counterfactualTokens && counterfactualTokens > promptTokens
    ? openrouterUsd(model.prompt, model.completion, counterfactualTokens, maxOut)
    : null;
  const counterfactual = direct !== null && cfg.discount > 0;
  const floorUsd = baseUsd * cfg.floorMultiple;
  // The price everything is now quoted against. When leCore compressed, that
  // is the pre-compression body's direct cost; when it did not, `direct` is
  // null and the body we forwarded IS the body they would have bought, so
  // baseUsd is the like-for-like direct price. Never undefined — see the
  // like-for-like note on directUsd below.
  const directUsd = direct ?? baseUsd;
  // Compression discount composes with the volume rate rather than replacing
  // it, so a heavy user gets their volume rate ON TOP of the leCore discount
  // instead of having to choose. The cost floor two lines down is what stops
  // the composition from walking under our own spend.
  const effectiveRate = usageRate * (counterfactual ? cfg.discount : 1);
  // NO CLIFF. The two modes used to be exclusive, which made price
  // NON-MONOTONIC in body size: MEASURED on the live gateway, 40,000 chars
  // billed $0.096426 (markup) while 42,000 chars billed $0.047421
  // (counterfactual) — sending MORE data cost HALF. That is not just ugly, it
  // is exploitable: the rational move is to pad every body past the spill
  // threshold, which wastes the caller's bandwidth and OUR upstream tokens to
  // buy a discount. It also punishes exactly the careful user who trims their
  // prompt.
  //
  // So there is ONE expression, and it is monotone: everything is a rate off
  // the like-for-like direct price. Below the spill threshold directUsd is
  // baseUsd and the rate is the volume rate; above it directUsd is the
  // pre-compression cost and the rate additionally picks up cfg.discount.
  // Nothing steps, so padding a body past the spill threshold can no longer
  // buy a cheaper price than trimming it.
  //
  // Read outward-in: a rate off direct, lifted to our own cost floor, then
  // capped — unconditionally — at direct itself. The cap is last on purpose.
  // It is the whole contract, and no floor, discount or curve may outrank it.
  const billedUsd = Math.min(Math.max(directUsd * effectiveRate, floorUsd), directUsd);
  const pricedAt = new Date().toISOString();

  const accepts: QuoteLine[] = [];
  for (const a of cfg.assets) {
    const tokenUsd = a.stableUsd ?? 1;
    const net = usdToRaw(billedUsd, tokenUsd, a.decimals);
    const gross = grossUp(net, a.feeBps);
    accepts.push({
      symbol: a.symbol,
      mint: a.mint,
      network: a.network ?? cfg.network,
      decimals: a.decimals,
      tokenUsd,
      billedUsd,
      netRaw: net.toString(),
      grossRaw: gross.toString(),
      feeBps: a.feeBps,
      pricedAt,
      payTo: a.payTo,
      eip712: a.eip712,
    });
  }
  return {
    model: modelId,
    promptTokensEst: promptTokens,
    maxOut,
    openrouterUsd: baseUsd,
    // THE EFFECTIVE multiple over our own forwarded cost, not cfg.markup —
    // which no longer participates in this lane at all. Reporting the config
    // number here would claim a 3x that nothing charged.
    markup: baseUsd > 0 ? billedUsd / baseUsd : 1,
    billedUsd,
    pricedAt,
    accepts,
    pricing: counterfactual ? "counterfactual" : "volume",
    // LIKE-FOR-LIKE DENOMINATOR (same bug class the margin fix caught): when
    // leCore's compression never engaged, "what this would cost buying direct"
    // is trivially what it DID cost (baseUsd) -- not undefined/0. Leaving it
    // undefined here means usage.ts's sum (Number(e.directUsd)||0) only counts
    // the handful of compressed calls while cogsToday/paidWithCogsToday sum
    // every paid call, so "leCore saving" divides mismatched populations and
    // renders as a fake LOSS (direct << paid) instead of "no saving on this call".
    directUsd,
    discount: counterfactual ? cfg.discount : undefined,
    savesVsDirect: billedUsd > 0 ? directUsd / billedUsd : 1,
    // The two unambiguous readings of the same number. savesVsDirect is a
    // MULTIPLE (2 = half price); rate/savedPct are FRACTIONS (0.5 / 0.5).
    // Clamped into [0,1] rather than trusted, so a UI can render savedPct as
    // a progress bar without defending against a negative.
    rate: directUsd > 0 ? Math.min(1, billedUsd / directUsd) : 1,
    savedPct: directUsd > 0 ? Math.max(0, 1 - billedUsd / directUsd) : 0,
    savedUsd: Math.max(0, directUsd - billedUsd),
    volume: {
      spendUsd: tenantSpendUsd,
      rate: usageRate,
      rateFloor: cfg.volume.rateFloor,
      windowDays: cfg.volumeWindowDays,
    },
    flooredAtCost: directUsd * effectiveRate < floorUsd,
  };
}

/** Live USD from DexScreener, picking the DEEPEST pool. Fail-closed.
 *
 *  Deepest, not first: a token can quote on two DEXes at different prices with
 *  wildly different depth (measured at add time: ROBINHOODS was $0.000005463 on
 *  a $5,200 uniswap pool and $0.000005531 on a $71 pancakeswap pool). Pricing a
 *  payment off the $71 pool is pricing off noise. */
export async function dexScreenerUsd(a: Asset): Promise<number> {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${a.priceMint}`);
  if (!r.ok) throw new Error(`dexscreener ${r.status} for ${a.symbol}`);
  const j = (await r.json()) as { pairs?: Array<{ chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }> };
  const pools = (j.pairs ?? []).filter(
    (p) => (!a.priceChain || p.chainId === a.priceChain) && Number(p.priceUsd) > 0,
  );
  if (!pools.length) throw new Error(`dexscreener has no ${a.priceChain ?? ""} pool for ${a.symbol}`);
  pools.sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0));
  const best = pools[0];
  const usd = Number(best.priceUsd);
  if (!(usd > 0)) throw new Error(`dexscreener gave no usable price for ${a.symbol}`);
  return usd;
}

/** Live USD for a non-stable. Fail-closed on every source. */
export async function spotUsd(cfg: Config, a: Asset): Promise<number> {
  if (a.stableUsd) return a.stableUsd;
  if (a.priceSource === "dexscreener") {
    try {
      return await dexScreenerUsd(a);
    } catch (e) {
      // FALL BACK, don't fail closed on one aggregator's coverage gap. A token
      // with no DexScreener pool is not a token with no price: IOU lost its
      // pool and its row vanished from every 402, while Birdeye still quoted
      // it. Only a token BOTH sources refuse is genuinely unpriceable.
      if (!cfg.birdeyeKey) throw e;
      console.error(`quote: ${a.symbol} dexscreener miss (${(e as Error).message}) — trying birdeye`);
    }
  }
  if (!cfg.birdeyeKey) throw new Error("BIRDEYE_API_KEY required to price " + a.symbol);
  const u = new URL("https://public-api.birdeye.so/defi/price");
  u.searchParams.set("address", a.priceMint);
  // CHAIN COMES FROM THE ASSET. This was hardcoded to "solana", which meant a
  // non-Solana asset could never be priced by Birdeye no matter what its
  // priceSource said — IOU on Robinhood Chain silently had no usable source and
  // its row was dropped from every live 402.
  const r = await fetch(u, {
    headers: { "X-API-KEY": cfg.birdeyeKey, "x-chain": a.priceChain ?? "solana" },
  });
  if (!r.ok) throw new Error(`birdeye ${r.status}`);
  const j = (await r.json()) as { success?: boolean; data?: { value?: number } };
  const v = j.data?.value;
  if (!j.success || !(typeof v === "number") || !(v > 0)) throw new Error("birdeye gave no price for " + a.priceMint);
  return v;
}

/**
 * Spot cache + soft-stale fallback. Quoting must survive a rate-limited price
 * API: MEASURED under load-test, 16 concurrent quotes on a Birdeye-priced
 * asset 429'd and turned 5/60 quotes into HTTP 500 — the first thing that
 * breaks at launch traffic, and it takes down quoting for every asset holder.
 * A meme-coin spot a minute old is a rounding error; a 500 quote is a lost
 * user. So: fresh within SPOT_TTL_MS, and when the fetch fails, serve the
 * last-known price up to SPOT_STALE_MAX_MS old (marked priceStale, pricedAt
 * = when the spot was actually fetched). Past the bound we fail closed,
 * exactly as before — never price off a price we no longer believe.
 */
const spotCache = new Map<string, { at: number; usd: number }>();
const spotTtlMs = () => Number(process.env.SPOT_TTL_MS || 45_000);
const spotStaleMaxMs = () => Number(process.env.SPOT_STALE_MAX_MS || 600_000);

/** Test hook. */
export function _clearSpotCache() { spotCache.clear(); }

export async function spotUsdCached(cfg: Config, a: Asset): Promise<{ usd: number; at: number; stale: boolean }> {
  const now = Date.now();
  const hit = spotCache.get(a.mint);
  if (hit && now - hit.at < spotTtlMs()) return { usd: hit.usd, at: hit.at, stale: false };
  try {
    const usd = await spotUsd(cfg, a);
    spotCache.set(a.mint, { at: now, usd });
    return { usd, at: now, stale: false };
  } catch (e) {
    if (hit && now - hit.at < spotStaleMaxMs()) return { usd: hit.usd, at: hit.at, stale: true };
    throw e;
  }
}

/**
 * MEDIA QUOTE. An image or a video has no prompt/completion tokens to price,
 * so the token path above cannot express it: the upstream charges per
 * generation (or per megapixel, or per clip-block) and that number arrives
 * already in USD. This builds the same Quote shape from a flat upstream cost
 * so the whole 402 machinery — requirements(), challenge(), verify(),
 * settle() — works unchanged on media routes.
 *
 * Markup only, never the counterfactual discount: the discount exists because
 * leCore makes us forward FEWER tokens than the caller would have bought
 * direct, and there is no such saving on a diffusion job. Applying it here
 * would be charging half price for work we pay full price for.
 */
export function quoteUnits(
  cfg: Config,
  modelId: string,
  upstreamUsd: number,
  priceModel: string,
  /**
   * FACE-VALUE HOOK. Defaults to cfg.markup so media is unchanged, and
   * /v1/credits/topup passes 1.
   *
   * Top-ups used to be written `quoteUnits(cfg, "credit", usd / cfg.markup)`
   * and relied on the divide cancelling the multiply. That is correct
   * arithmetic and a fragile contract: it silently sells credit at the wrong
   * price the moment cfg.markup is 0, non-finite, or (as of this change)
   * means something different than it did. Passing markup 1 and the raw USD
   * makes "credit is sold at FACE VALUE" a property of the call site instead
   * of a cancellation nobody can see from the receipt.
   */
  markup: number = cfg.markup,
): Quote {
  if (!(upstreamUsd >= 0) || !Number.isFinite(upstreamUsd)) throw new Error("bad media cost");
  if (!(markup > 0) || !Number.isFinite(markup)) throw new Error("bad markup");
  const billedUsd = upstreamUsd * markup;
  const pricedAt = new Date().toISOString();
  const accepts: QuoteLine[] = [];
  for (const a of cfg.assets) {
    const tokenUsd = a.stableUsd ?? 1;
    const net = usdToRaw(billedUsd, tokenUsd, a.decimals);
    accepts.push({
      symbol: a.symbol,
      mint: a.mint,
      network: a.network ?? cfg.network,
      decimals: a.decimals,
      tokenUsd,
      billedUsd,
      netRaw: net.toString(),
      grossRaw: grossUp(net, a.feeBps).toString(),
      feeBps: a.feeBps,
      pricedAt,
      payTo: a.payTo,
      eip712: a.eip712,
    });
  }
  return {
    model: modelId,
    promptTokensEst: 0,
    maxOut: 0,
    openrouterUsd: upstreamUsd,
    markup,
    billedUsd,
    pricedAt,
    accepts,
    pricing: "markup",
    priceModel,
  };
}

/** Live-spot every non-stable row, dropping any we cannot price. Shared by the
 *  token and media quote paths so a media 402 can never advertise a rail on a
 *  stale or invented price that the text path would have rejected. */
async function applyLiveSpots(cfg: Config, q: Quote): Promise<Quote> {
  // An asset with no believable price DROPS OUT of accepts[] rather than
  // killing the whole 402 or shipping an invented number. One dead pool must
  // not take down every other rail; equally, a row without a live spot is a
  // price we made up — never emit it. (Observed: IOU's DexScreener pool
  // vanished 2026-08-14 — pairs list empty — while ODDBALLER/ROBINHOODS
  // still quote.)
  const unpriceable = new Set<string>();
  for (const line of q.accepts) {
    const a = cfg.assets.find((x) => x.mint === line.mint);
    if (!a || a.stableUsd) continue;
    let spot;
    try {
      spot = await spotUsdCached(cfg, a);
    } catch (e) {
      console.error(`quote: dropping ${a.symbol} row — no live price (${(e as Error).message})`);
      unpriceable.add(line.mint);
      continue;
    }
    const net = usdToRaw(q.billedUsd, spot.usd, a.decimals);
    line.tokenUsd = spot.usd;
    line.netRaw = net.toString();
    line.grossRaw = grossUp(net, a.feeBps).toString();
    if (spot.stale) {
      line.priceStale = true;
      line.pricedAt = new Date(spot.at).toISOString();
    }
  }
  if (unpriceable.size) q.accepts = q.accepts.filter((l) => !unpriceable.has(l.mint));
  return q;
}

export async function quoteLive(
  cfg: Config,
  body: { model?: string; messages?: unknown; max_tokens?: number },
  counterfactualTokens?: number,
  tenantSpendUsd = 0,
): Promise<Quote> {
  return applyLiveSpots(cfg, await quoteRequest(cfg, body, counterfactualTokens, tenantSpendUsd));
}

/** Media equivalent of quoteLive: flat upstream cost in, fully-priced 402 out. */
export async function quoteMediaLive(cfg: Config, modelId: string, upstreamUsd: number, priceModel: string, markup?: number): Promise<Quote> {
  return applyLiveSpots(cfg, quoteUnits(cfg, modelId, upstreamUsd, priceModel, markup));
}
