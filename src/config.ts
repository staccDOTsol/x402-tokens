/** Env-driven config. Secrets never live in the repo. */
import type { VolumeCurve } from "./math.js";
import { normalizeMemeRail } from "./wrapspec.js";

export interface Asset {
  symbol: string;
  mint: string;
  decimals: number;
  /** CAIP-2 network this asset settles on. Defaults to cfg.network (Solana).
   *  Robinhood Chain is eip155:4663 — assets are no longer all one chain. */
  network?: string;
  /** Where spotUsd looks. Birdeye has no Robinhood Chain; DexScreener does. */
  priceSource?: "birdeye" | "dexscreener";
  /** DexScreener chain slug, e.g. "robinhood". */
  priceChain?: string;
  /** Token-2022 transfer-fee basis points (out of 10_000). */
  feeBps: number;
  /**
   * Where THIS asset is paid. A payee address is chain-shaped: the Solana
   * base58 payTo is not a valid `to` for an EIP-3009 authorization, and an
   * EVM row carrying it makes every Base/RH payment unsignable. Defaults to
   * cfg.payTo (Solana) when unset.
   */
  payTo?: string;
  /**
   * EIP-712 domain for EVM assets. The payer signs
   * `TransferWithAuthorization` against `{name, version, chainId,
   * verifyingContract}`; the facilitator recovers with the domain it reads
   * off the token. A guessed name/version recovers a DIFFERENT address and
   * the payment is rejected as "signature does not match payer".
   *
   * Read from chain, never assumed:
   *   Base USDC  -> name "USD Coin",           version "2"
   *   RH wUSDGx  -> name "Wrapped USDG (x402)", version "1"
   */
  eip712?: { name: string; version: string };
  /**
   * Mint Birdeye should price. For yUSDCx this is USDC (NAV ≈ $1).
   * For the memecoin wrap this is the underlying pump mint — the wrap
   * usually has no market of its own.
   */
  priceMint: string;
  /** If set, treat as $1 stable and skip Birdeye. */
  stableUsd?: number;
}

export interface Config {
  port: number;
  publicUrl: string;
  facilitator: string;
  solanaRpc: string;
  network: string;
  payTo: string;
  /** Payee for every eip155 row. Separate from `payTo` because that one is a
   *  Solana base58 address and cannot receive an ERC-20 transfer. */
  evmPayTo: string;
  feePayer: string;
  /**
   * UNITS/MEDIA MARKUP ONLY. This no longer touches the text price path.
   *
   * Text is priced off OpenRouter's own direct rate (ceiling 1x, decreasing
   * with usage — see `volume` below and math.ts volumeRate), so there is
   * nothing here for a markup to multiply. What remains on this field is the
   * per-unit media lane (Together image/video), where there IS no OpenRouter
   * price to be "no more expensive than" — the vendor bills per generation
   * and the comparison the text ceiling is built on does not exist.
   *
   * Credit top-ups are explicitly NOT priced through it any more: /v1/credits
   * passes markup 1 so face value is structural rather than an arithmetic
   * cancellation that silently breaks if this number ever changes.
   */
  markup: number;
  /** Extra discount off direct when leCore actually compressed the body.
   *  Composes multiplicatively with the volume rate. */
  discount: number;
  /** Hard cost floor: never price under our own forwarded cost x this.
   *  Always subordinate to the 1x-direct ceiling. */
  floorMultiple: number;
  /** Usage-decreasing price curve. See math.ts volumeRate. */
  volume: VolumeCurve;
  /** Trailing window, in days, over which tenant spend is accumulated for
   *  the volume curve. */
  volumeWindowDays: number;
  openrouterKey: string;
  openrouterUrl: string;
  birdeyeKey: string;
  /** Media upstream (image/video). Empty -> the media routes 503 and the
   *  gateway is text-only, exactly as it was before they existed. */
  togetherKey: string;
  togetherUrl: string;
  /** Video lives on a DIFFERENT api version than images — v2, and on
   *  api.together.ai. Separate field because the /v1 video route exists,
   *  accepts requests, and fails every model. */
  togetherVideoUrl: string;
  /** Kept for env compat. x-ai/* is no longer routed here — every text
   *  completion meters through OpenRouter so there is one bill and one
   *  COGS path. Empty or set, it does not change routing. */
  xaiKey: string;
  xaiUrl: string;
  defaultModel: string;
  defaultImageModel: string;
  /** Web search for EVERY model, on by default. OpenRouter's web plugin is
   *  model-agnostic middleware, so there is no "unsupported model" case to
   *  route around. Flat $0.007/request upstream — priced into the 402. */
  webSearchDefault: boolean;
  webMaxResults: number;
  defaultVideoModel: string;
  lecoreUrl: string;
  lecoreKey: string;
  lecoreTenant: string;
  lecoreSpillTokens: number;
  /** leCore's OWN service (/tools + /invoke) — a SEPARATE app from the HRR
   *  sidecar on purpose: constructing the full faculty surface pulls ~510
   *  faculties and has OOM'd the sidecar mid-bind on 20MB chunks. Discovery
   *  and invoke must never share a process with bind/recall. */
  lecoreFrontUrl: string;
  lecoreFrontKey: string;
  lecoreTopK: number;
  /** Chunks in the referenced context, learned at bind time. Drives the
   *  coverage note; undefined = unknown, which the note handles. */
  lecoreCorpusChunks?: number;
  lecoreTailChars: number;
  lecoreChunkChars: number;
  lecoreQueryChars: number;
  lecoreChunkOverlap: number;
  lecoreTimeoutMs: number;
  lecoreRequired: boolean;
  /**
   * Require X-Openzoo-Namespace to carry a valid wallet signature
   * (X-Openzoo-Namespace-Sig/-Signer/-Ts) before it is trusted for tenant
   * isolation. Unset/0 (default): unsigned namespaces still work exactly as
   * before (soft launch — see nsauth.ts / tenantFor in server.ts), a valid
   * signature is preferred when present, and an invalid signature just logs
   * and falls through to the legacy unsigned path. "1": an unsigned or
   * invalid namespace claim falls back to the shared BASE tenant rather than
   * 401 — these are documented free passthroughs (/v1/hrr/bind etc.) and a
   * hard failure here would break that for every caller who has not
   * upgraded yet.
   */
  lecoreRequireSignedNamespace: boolean;
  /** Replay window for a signed namespace claim's timestamp. */
  lecoreNamespaceSigWindowMs: number;
  assets: Asset[];
}

const req = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const opt = (k: string, d: string) => process.env[k] || d;

export function loadConfig(): Config {
  const yusdcx: Asset = {
    symbol: "yUSDCx",
    mint: opt("YUSDCX_MINT", "6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv"),
    decimals: 6,
    feeBps: Number(opt("YUSDCX_FEE_BPS", "20")),
    priceMint: opt("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    stableUsd: 1,
  };

  const assets: Asset[] = [yusdcx];

  // Payee for eip155 rows. Verified against the operator's own prior x402
  // settlement on eip155:4663 (themes.oddballer.fun, 2026-08-11).
  const EVM_PAY_TO = opt("X402_PAY_TO_EVM", "0x3C4ec546e47471321aED2956925E9f0942beB260");

  // --- Base rail (eip155:8453) --------------------------------------------
  // Native Circle USDC. Every precondition for settlement verified on-chain
  // 2026-08-14 rather than assumed:
  //   - EIP-3009: authorizationState(...) answers, so the facilitator's
  //     transferWithAuthorization path applies (its ONLY EVM settle path).
  //   - EIP-712 domain: name "USD Coin", version "2", decimals 6, read live.
  //   - Facilitator allowlists it (GET /supported, eip155:8453) and its gas
  //     signer 0xEA55E489a825319Fad7A537F31d661d391696cC4 held 0.009 ETH on
  //     Base, ready:true.
  // No NAV twin here on purpose: the pricing path only needs `decimals` and a
  // USD figure, so a plain stable prices exactly like yUSDCx does. The payer
  // signs; the facilitator pays the gas.
  if (opt("BASE_RAILS", "0") === "1") {
    assets.push({
      symbol: "USDC",
      mint: opt("BASE_USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      decimals: 6,
      feeBps: 0, // native USDC has no transfer fee
      priceMint: opt("BASE_USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      stableUsd: 1,
      network: opt("BASE_NETWORK", "eip155:8453"),
      payTo: EVM_PAY_TO,
      eip712: { name: "USD Coin", version: "2" },
    });
  }

  // --- Robinhood Chain rails (eip155:4663) --------------------------------
  // wUSDGx is the ONLY asset on this chain the facilitator can actually
  // settle: verified on-chain 2026-08-14, it is 6-decimal and answers
  // authorizationState (EIP-3009), and it is in the facilitator's
  // assetsByChainId["4663"] allowlist. Domain read live: name
  // "Wrapped USDG (x402)", version "1". RH gas signer was funded and ready.
  //
  // Priced as a $1 stable: it is a NAV-up ERC-4626 wrapper over Paxos USDG,
  // so a share is worth >= $1 of USDG. Underlying is USDG in all user-facing
  // copy; the wrapper ticker is plumbing.
  if (opt("RH_RAILS", "0") === "1") {
    assets.push({
      symbol: "wUSDGx",
      mint: opt("RH_WUSDGX", "0x9bdD78296f758af1b048E14E101c90Daa511ADC5"),
      decimals: 6,
      feeBps: Number(opt("RH_WUSDGX_FEE_BPS", "20")), // transferFeePpm 200
      priceMint: opt("RH_WUSDGX", "0x9bdD78296f758af1b048E14E101c90Daa511ADC5"),
      stableUsd: 1,
      network: opt("RH_NETWORK", "eip155:4663"),
      payTo: EVM_PAY_TO,
      eip712: { name: "Wrapped USDG (x402)", version: "1" },
    });
  }

  // --- Robinhood Chain MEMECOIN rails (eip155:4663) -----------------------
  // Verified on-chain 2026-08-14 against rpc.mainnet.chain.robinhood.com:
  // all three are ERC-20, 18 decimals, no transfer fee. Priced by DexScreener
  // (chain slug "robinhood"); Birdeye does not index this chain.
  //
  // ⚠️ THIN LIQUIDITY, and it is why this rail is OPT-IN. At add time the pools
  // held ODDBALLER $317 / IOU $3,380 / ROBINHOODS $5,200. A quote is only as
  // real as the depth behind it: taking payment in a token you cannot sell is
  // taking payment in nothing.
  //
  // ✅ SETTLEABLE VIA X402WRAPPER TWINS since 2026-08-14. The raw memecoins
  // have no EIP-3009, so each row settles through its X402Wrapper twin
  // (repo /Users/stacc/x402-wrappers, deploy record there): an ERC-4626-shaped
  // vault + EIP-3009 that mirrors wUSDGx exactly (entry 100ppm, exit 100ppm,
  // transfer fee 200ppm = 2bps deducted from the value, ceil). All three twins
  // are in the facilitator's assetsByChainId["4663"] allowlist (verified via
  // GET /supported) and answer authorizationState. EIP-712 domains read live
  // off each twin: name "Wrapped <SYM> (x402)", version "1", decimals 18
  // (twins mirror the 18-decimal underlyings).
  //
  // USER-FACING COPY NAMES ONLY THE UNWRAPPED MEMECOIN (standing directive:
  // symbol stays ODDBALLER/IOU/ROBINHOODS; the twin mint is plumbing). Priced
  // by the UNDERLYING's DexScreener pool — the twin has no market of its own,
  // and NAV >= 1 underlying per share (entry fee accrues to the vault), so the
  // underlying spot is an honest floor for the share.
  //
  // A payer holding only the raw memecoin acquires the twin at payment time:
  // approve + deposit(uint256,address) — the openzoo shim does this
  // automatically (lib/wrap.js EVM path), spending the payer's own RH ETH gas.
  if (opt("RH_MEME_RAILS", "0") === "1") {
    const RH_NETWORK = opt("RH_NETWORK", "eip155:4663");
    const rh = (symbol: string, twin: string, underlying: string): Asset => ({
      symbol, // unwrapped name only — the twin ticker never reaches the user
      mint: twin,
      decimals: 18,
      feeBps: Number(opt("RH_TWIN_FEE_BPS", "2")), // transferFeePpm 200 = 2bps, ceil-safe with grossUp()
      priceMint: underlying,
      network: RH_NETWORK,
      priceSource: "dexscreener",
      priceChain: opt("RH_CHAIN_SLUG", "robinhood"),
      payTo: EVM_PAY_TO,
      eip712: { name: `Wrapped ${symbol} (x402)`, version: "1" },
    });
    assets.push(rh("ODDBALLER", opt("RH_WODDBALLERX", "0x1AE410a93C8b05c872D2FE2718e9BB66392AF903"), "0x923eb7BD5B84a1a114CB57212cE2F2e87AE60E2A"));
    assets.push(rh("IOU", opt("RH_WIOUX", "0x90c2B5DA6097DbbB3632469108A38F4F91eD0434"), "0xf391999FACbEE613D4024191Dd31060540BF0bEd"));
    assets.push(rh("ROBINHOODS", opt("RH_WROBINHOODSX", "0xD906653C147cF35329161665a4AaaAd3bc118743"), "0xC42cF61C16aaC797b991cf9C1ac8Ae70bA74A286"));
  }
  // Wrapped memecoin is OFF until the mint exists and the facilitator
  // allowlists it. Setting MEME_MINT is what turns the rail on.
  if (process.env.MEME_MINT) {
    const meme = normalizeMemeRail(process.env.MEME_MINT, opt("MEME_SYMBOL", "wTOKENx2"));
    assets.push({
      symbol: meme.symbol,
      mint: meme.mint,
      decimals: Number(opt("MEME_DECIMALS", "6")),
      feeBps: Number(opt("MEME_FEE_BPS", "20")),
      priceMint: opt("MEME_UNDERLYING", meme.mint),
    });
  }
  // LEOS, on the same terms as TOKEN. Off until LEOS_MINT is set, exactly like
  // the rail above — the entry is meaningless without the wrapped twin, which
  // is minted by scripts/create-leos.mjs.
  //
  // NINE decimals, not six. wLEOSx takes the UNDERLYING's decimals because the
  // deployed wrap program reads mint_decimals() at runtime, so defaulting to 6
  // here would mis-scale every transfer_checked on this rail. Priced off the
  // UNDERLYING (LEOS) — the twin has no market of its own.
  if (process.env.LEOS_MINT) {
    assets.push({
      symbol: opt("LEOS_SYMBOL", "wLEOSx"),
      mint: process.env.LEOS_MINT,
      decimals: Number(opt("LEOS_DECIMALS", "9")),
      feeBps: Number(opt("LEOS_FEE_BPS", "20")),
      priceMint: opt("LEOS_UNDERLYING", "5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e"),
    });
  }

  return {
    port: Number(opt("PORT", "8787")),
    publicUrl: opt("PUBLIC_URL", "http://localhost:8787").replace(/\/$/, ""),
    facilitator: opt("X402_FACILITATOR", "https://x402.accrue.fund").replace(/\/$/, ""),
    // Solana RPC — only used by /v1/pay/build, to read mint info (decimals +
    // token program) and a recent blockhash. Settlement never touches it; the
    // facilitator owns that. Public mainnet is fine for two cheap reads, and
    // mint info is cached, but set SOLANA_RPC to a private endpoint if this
    // ever gets hot.
    solanaRpc: opt("SOLANA_RPC", "https://api.mainnet-beta.solana.com").replace(/\/$/, ""),
    network: opt("X402_NETWORK", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
    payTo: opt("X402_PAY_TO", "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb"),
    evmPayTo: EVM_PAY_TO,
    feePayer: opt("X402_FEE_PAYER", "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb"),
    // MEDIA/UNITS ONLY — the text lane no longer multiplies anything by this.
    markup: Number(opt("X402_MARKUP", "3")),
    // counterfactual pricing: fraction of what buying this body direct would cost
    discount: Number(opt("X402_DISCOUNT", "0.5")),
    // never price under our own forwarded cost x this
    floorMultiple: Number(opt("X402_FLOOR_MULTIPLE", "1.5")),
    // THE PRICING CONTRACT, and every knob in it is env-tunable so it can be
    // moved without a redeploy of the image:
    //   X402_RATE_MAX=1     -> never more expensive than OpenRouter direct
    //   X402_RATE_FLOOR     -> most a heavy tenant can ever get off (0.25 = 75% off)
    //   X402_VOLUME_SCALE_USD / X402_VOLUME_DECAY -> how fast it gets there
    // Setting X402_VOLUME_DECAY=0 pins everyone at the ceiling (1x direct)
    // without changing any other behaviour — the kill switch for the curve.
    volume: {
      rateMax: Number(opt("X402_RATE_MAX", "1")),
      rateFloor: Number(opt("X402_RATE_FLOOR", "0.25")),
      scaleUsd: Number(opt("X402_VOLUME_SCALE_USD", "10")),
      decay: Number(opt("X402_VOLUME_DECAY", "0.25")),
    },
    volumeWindowDays: Number(opt("X402_VOLUME_WINDOW_DAYS", "30")),
    openrouterKey: req("OPENROUTER_API_KEY"),
    openrouterUrl: opt("OPENROUTER_URL", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    birdeyeKey: opt("BIRDEYE_API_KEY", ""),
    // MEDIA LANE. OpenRouter serves no video at all and only 9 image models,
    // so image/video ride a separate upstream. Unset -> /v1/images/* and
    // /v1/videos/* answer 503 and nothing else changes.
    togetherKey: opt("TOGETHER_API_KEY", ""),
    togetherUrl: opt("TOGETHER_URL", "https://api.together.xyz/v1").replace(/\/$/, ""),
    xaiKey: opt("XAI_API_KEY", ""),
    xaiUrl: opt("XAI_URL", "https://api.x.ai/v1").replace(/\/$/, ""),
    togetherVideoUrl: opt("TOGETHER_VIDEO_URL", "https://api.together.ai/v2").replace(/\/$/, ""),
    defaultModel: opt("DEFAULT_MODEL", "google/gemini-2.5-flash"),
    // cheap + fast (measured 0.14s), so an unspecified image request still
    // returns something rather than erroring on a missing field
    webSearchDefault: opt("WEB_SEARCH_DEFAULT", "1") === "1",
    webMaxResults: Number(opt("WEB_MAX_RESULTS", "3")),
    defaultImageModel: opt("DEFAULT_IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell"),
    defaultVideoModel: opt("DEFAULT_VIDEO_MODEL", "Wan-AI/wan2.7-t2v"),
    // leCore in front: HRR sidecar that spills long bodies before the 402 is
    // priced. Unset -> plain passthrough, byte-identical to today.
    lecoreUrl: opt("LECORE_HRR_URL", "").replace(/\/$/, ""),
    lecoreKey: opt("LECORE_HRR_KEY", ""),
    lecoreTenant: opt("LECORE_TENANT", "zoo"),
    lecoreSpillTokens: Number(opt("LECORE_SPILL_TOKENS", "8000")),
    lecoreFrontUrl: opt("LECORE_FRONT_URL", "https://lecore-front.fly.dev").replace(/\/$/, ""),
    lecoreFrontKey: opt("LECORE_FRONT_KEY", ""),
    lecoreTopK: Number(opt("LECORE_TOP_K", "8")),
    // tail = the actual ask kept verbatim; chunk = passage size for the head
    lecoreTailChars: Number(opt("LECORE_TAIL_CHARS", "2000")),
    lecoreChunkChars: Number(opt("LECORE_CHUNK_CHARS", "1200")),
    // the retrieval QUERY is the ask alone, not the whole forwarded tail
    lecoreQueryChars: Number(opt("LECORE_QUERY_CHARS", "400")),
    // overlap >= the longest fact you expect, or boundary-straddling facts vanish
    lecoreChunkOverlap: Number(opt("LECORE_CHUNK_OVERLAP", "300")),
    lecoreTimeoutMs: Number(opt("LECORE_TIMEOUT_MS", "10000")),
    lecoreRequired: opt("LECORE_REQUIRED", "0") === "1",
    lecoreRequireSignedNamespace: opt("LECORE_REQUIRE_SIGNED_NAMESPACE", "0") === "1",
    lecoreNamespaceSigWindowMs: Number(opt("LECORE_NAMESPACE_SIG_WINDOW_MS", "300000")), // 5 min
    assets,
  };
}
