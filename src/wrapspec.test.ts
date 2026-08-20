/**
 * Client-facing wrap copy must describe the post-exploit 9-account Wrap.
 * A 5-account + TransferChecked recipe has been dying 0x6a since 2026-08-18.
 */
import { challenge, requirements } from "./x402.js";
import { clankerPrompt } from "./page.js";
import type { Config } from "./config.js";
import type { Quote } from "./quote.js";
import {
  WRAP_NAV_PROGRAM,
  WRAP_STEP_NOTE,
  YUSDCX_ACQUIRE,
  YUSDCX_MINT,
  acquireForMint,
  isStaleTransferThenWrapSteps,
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
ok(!howTo.includes("TOKEN → wTOKENx via the same program, escrow 7j682"), "howto does not send TOKEN to the drained escrow as current");

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

const help = solanaWrap402Help("USDC on Solana", "https://x402.accrue.fund");
ok(help.includes("9-account Wrap"), "402 help names 9-account Wrap");
ok(help.includes("0x6a"), "402 help names 0x6a");
ok(!help.includes("BEFORE it lands"), "402 help omits pre-exploit deposit-first note");

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

const prompt = clankerPrompt(cfg);
ok(prompt.includes("NINE accounts") || prompt.includes("9 accounts"), "clanker prompt lists 9 accounts");
ok(prompt.includes("0x6a"), "clanker prompt names 0x6a");
ok(!prompt.includes("prices the deposit off the escrow balance BEFORE it lands"), "clanker prompt is not deposit-first");

console.log("wrapspec ok");
