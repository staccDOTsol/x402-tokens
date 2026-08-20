/**
 * Client-facing wrap copy must describe the post-exploit 9-account Wrap.
 * A 5-account + TransferChecked recipe has been dying 0x6a since 2026-08-18.
 */
import { challenge, requirements, underlyingNames } from "./x402.js";
import { clankerPrompt, underlyingName } from "./page.js";
import type { Config } from "./config.js";
import type { Quote } from "./quote.js";
import {
  WRAP_NAV_PROGRAM,
  WRAP_STEP_NOTE,
  WTOKENX2_ACQUIRE,
  WTOKENX2_MINT,
  WTOKENX_DRAINED_MINT,
  YUSDCX_ACQUIRE,
  YUSDCX_MINT,
  acquireForMint,
  isStaleTransferThenWrapSteps,
  normalizeMemeRail,
  solanaWrap402Help,
  wrapClientInstructions,
} from "./wrapspec.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

const stale = [
  "prices the deposit off the escrow balance BEFORE it lands",
  "wrap BEFORE deposit",
  "send USDC to the escrow — the program prices",
  "exactly 5 accounts",
];

const howTo = wrapClientInstructions();
for (const s of [
  "9 accounts",
  "0x6a",
  WRAP_NAV_PROGRAM,
  "[1] ++ u64 amount LE ++ [bump]",
  "No separate TransferChecked",
]) ok(howTo.includes(s), `howto has ${s.slice(0, 40)}`);
for (const s of stale) ok(!howTo.includes(s), `howto omits stale "${s}"`);
ok(howTo.includes("account 8 = unwrapped token program"), "howto names unwrap account 8");
ok(howTo.includes("wTOKENx2"), "howto points TOKEN at the post-drain mint");
ok(howTo.includes("FXYkw"), "howto names the live wTOKENx2 mint");
ok(howTo.includes("outdated client"), "howto calls a 5-account Wrap an outdated client");
ok(howTo.includes("openzoo@0.49.5"), "howto names the min openzoo");
ok(howTo.includes("1.5.82"), "howto names the min grokui");
ok(!howTo.includes("TOKEN → wTOKENx via the same program, escrow 7j682"), "howto does not send TOKEN to the drained escrow as current");
ok(!/TOKEN → wTOKENx[^2]/.test(howTo), "howto does not teach TOKEN → wTOKENx as current");
ok(howTo.includes("is not current"), "howto labels drained wTOKENx / 7j682 as not current");

const note = WRAP_STEP_NOTE;
ok(note.includes("need(accounts, 9)"), "step note cites need(accounts, 9)");
ok(!note.includes("BEFORE it lands"), "step note is not the pre-exploit pricing line");
ok(isStaleTransferThenWrapSteps([{ instruction: "TransferChecked" }]), "detects stale TransferChecked step");
ok(!isStaleTransferThenWrapSteps([{ instruction: "Wrap" }]), "9-account Wrap-only steps are not stale");

const y = acquireForMint(YUSDCX_MINT, "yUSDCx");
ok(!!y && y.steps.length === 1, "yUSDCx acquire is one Wrap step");
ok(y!.steps[0].instruction === "Wrap", "yUSDCx step is Wrap");
ok(!y!.steps.some((s) => (s as { instruction: string }).instruction === "TransferChecked"), "yUSDCx has no TransferChecked step");
ok(y!.escrow === YUSDCX_ACQUIRE.escrow, "yUSDCx escrow");
ok(y!.unwrap.accounts === 9, "unwrap is 9 accounts");

const fxy = normalizeMemeRail(WTOKENX2_MINT, "wTOKENx");
ok(fxy.mint === WTOKENX2_MINT && fxy.symbol === "wTOKENx2", "normalize: FXYkw + wTOKENx → wTOKENx2");
ok(normalizeMemeRail(WTOKENX2_MINT, "wTOKEN").symbol === "wTOKENx2", "normalize: FXYkw + wTOKEN → wTOKENx2");
const bo7x = normalizeMemeRail(WTOKENX_DRAINED_MINT, "wTOKENx");
ok(bo7x.mint === WTOKENX2_MINT && bo7x.symbol === "wTOKENx2", "normalize: Bo7x + wTOKENx → FXYkw / wTOKENx2");
ok(normalizeMemeRail(WTOKENX_DRAINED_MINT, "anything").mint === WTOKENX2_MINT, "normalize: Bo7x + anything remaps mint");
ok(normalizeMemeRail(WTOKENX_DRAINED_MINT, "anything").symbol === "wTOKENx2", "normalize: Bo7x + anything remaps symbol");

const help = solanaWrap402Help("USDC on Solana", "https://x402.accrue.fund");
ok(help.includes("9-account Wrap"), "402 help names 9-account Wrap");
ok(help.includes("0x6a"), "402 help names 0x6a");
ok(help.includes("wTOKENx2"), "402 help names wTOKENx2");
ok(help.includes("FXYkw"), "402 help names the live mint");
ok(help.includes("outdated client"), "402 help calls 5-account an outdated client");
ok(help.includes("openzoo@0.49.5"), "402 help names openzoo@0.49.5");
ok(help.includes("1.5.82"), "402 help names grokui 1.5.82");
ok(!help.includes("BEFORE it lands"), "402 help omits pre-exploit deposit-first note");
ok(!/TOKEN → wTOKENx[^2]/.test(help), "402 help does not teach TOKEN → wTOKENx as current");
ok(!help.includes("7j682"), "402 help does not offer drained escrow 7j682 as current");

ok(underlyingName("wTOKENx2") === "TOKEN", "page underlyingName: wTOKENx2 → TOKEN");
ok(underlyingName("wTOKENx") === "TOKEN", "page underlyingName: wTOKENx → TOKEN");
ok(underlyingName("yUSDCx") === "USDC", "page underlyingName: yUSDCx → USDC");

const drainedAcquire = acquireForMint(WTOKENX_DRAINED_MINT, "wTOKENx");
ok(drainedAcquire?.escrow === WTOKENX2_ACQUIRE.escrow, "drained Bo7x mint acquires the live wTOKENx2 escrow");
ok(drainedAcquire?.escrow !== "7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q", "never attach drained 7j682 escrow");

const cfg = {
  assets: [{
    symbol: "yUSDCx",
    mint: YUSDCX_MINT,
    decimals: 6,
    feeBps: 20,
    priceMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    stableUsd: 1,
  }],
  facilitator: "https://x402.accrue.fund",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  payTo: "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb",
  feePayer: "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb",
  publicUrl: "http://localhost:8787",
  defaultModel: "m",
  volumeWindowDays: 30,
} as unknown as Config;

const q = {
  model: "m",
  promptTokensEst: 1,
  maxOut: 1,
  markup: 1,
  pricedAt: "t",
  pricing: "volume",
  billedUsd: 0.01,
  openrouterUsd: 0.01,
  accepts: [{
    symbol: "yUSDCx",
    mint: YUSDCX_MINT,
    decimals: 6,
    network: cfg.network,
    netRaw: "1000",
    grossRaw: "1000",
    billedUsd: 0.01,
    tokenUsd: 1,
    pricedAt: "t",
    feeBps: 20,
  }],
} as unknown as Quote;

const chal = challenge(cfg, q, "http://localhost/v1/chat/completions");
ok(String(chal.help).includes("9-account Wrap"), "challenge.help is 9-account");
ok(String(chal.help).includes("0x6a"), "challenge.help names 0x6a");
ok(!String(chal.help).includes("BEFORE it lands"), "challenge.help is not deposit-first");
const reqs = requirements(cfg, q, "http://localhost/v1/chat/completions");
ok(reqs[0].extra.acquire?.method === "spl-token-wrap", "402 extra.acquire is spl-token-wrap");
ok(reqs[0].extra.acquire?.steps.length === 1, "402 extra.acquire.steps is one Wrap");
ok(reqs[0].extra.acquire?.steps[0].note.includes("NINE accounts") === true, "402 acquire.steps note is 9-account");
ok(!(reqs[0].extra.acquire?.steps.some((s) => (s.instruction as string) === "TransferChecked")), "402 acquire.steps has no TransferChecked");
ok(String(chal.help).includes("wTOKENx2") && String(chal.help).includes("FXYkw"), "challenge.help names wTOKENx2 mint");
ok(String(chal.help).includes("outdated client"), "challenge.help calls 5-account outdated client");
ok(String(chal.help).includes("openzoo@0.49.5") && String(chal.help).includes("1.5.82"), "challenge.help names min client");

const tokenCfg = {
  ...cfg,
  assets: [{
    symbol: "wTOKENx2",
    mint: WTOKENX2_MINT,
    decimals: 6,
    feeBps: 20,
    priceMint: "EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump",
  }],
} as unknown as Config;
ok(underlyingNames(tokenCfg).includes("TOKEN on Solana"), "underlyingNames: wTOKENx2 → TOKEN");
ok(underlyingNames({ ...tokenCfg, assets: [{ ...tokenCfg.assets[0], symbol: "wTOKENx" }] }).includes("TOKEN on Solana"), "underlyingNames: wTOKENx → TOKEN");
ok(!underlyingNames(tokenCfg).includes("wTOKENx2 on"), "underlyingNames does not leak the wrap ticker");

const tokenQ = {
  ...q,
  accepts: [{
    ...q.accepts[0],
    symbol: "wTOKENx2",
    mint: WTOKENX2_MINT,
  }],
} as unknown as Quote;
const tokenReqs = requirements(tokenCfg, tokenQ, "http://localhost/v1/chat/completions");
ok(tokenReqs[0].extra.symbol === "wTOKENx2", "TOKEN 402 extra.symbol is wTOKENx2");
ok(tokenReqs[0].asset === WTOKENX2_MINT, "TOKEN 402 asset is FXYkw");
ok(tokenReqs[0].extra.acquire?.escrow === WTOKENX2_ACQUIRE.escrow, "TOKEN 402 acquire escrow is live wTOKENx2");
ok(tokenReqs[0].extra.acquire?.steps.length === 1 && tokenReqs[0].extra.acquire?.steps[0].instruction === "Wrap", "TOKEN 402 acquire is a single 9-account Wrap");
ok(tokenReqs[0].extra.acquire?.escrow !== "7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q", "TOKEN 402 does not offer drained escrow");

const mislabeled = {
  ...tokenQ,
  accepts: [{ ...tokenQ.accepts[0], symbol: "wTOKENx", mint: WTOKENX2_MINT }],
} as unknown as Quote;
const remapped = normalizeMemeRail(mislabeled.accepts[0].mint, mislabeled.accepts[0].symbol);
ok(remapped.symbol === "wTOKENx2" && remapped.mint === WTOKENX2_MINT, "Fly MEME_SYMBOL=wTOKENx on FXYkw still labels wTOKENx2");

const prompt = clankerPrompt(cfg);
ok(prompt.includes("NINE accounts") || prompt.includes("9 accounts"), "clanker prompt lists 9 accounts");
ok(prompt.includes("0x6a"), "clanker prompt names 0x6a");
ok(!prompt.includes("prices the deposit off the escrow balance BEFORE it lands"), "clanker prompt is not deposit-first");

console.log("wrapspec ok");
