import type { Config } from "./config.js";

const esc = (x: unknown) =>
  String(x).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));

/** Human chain name for a CAIP-2 network id. */
const chainName = (n: string) =>
  n.startsWith("solana:") ? "Solana" : n === "eip155:8453" ? "Base" : n === "eip155:4663" ? "Robinhood Chain" : n;

/**
 * User-facing copy names the UNDERLYING asset, never the settlement wrap.
 * Wrap tickers follow y<X>x / w<X>x (yUSDCx, wTOKENx, wUSDGx, future w*x
 * twins) — strip the affixes so new wrapped rails read as their own asset
 * automatically when they join accepts[].
 */
const underlyingName = (s: string) => (/^[wy].{1,}x$/.test(s) ? s.slice(1, -1) : s);

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** What you paste into an agent. Keep it imperative and complete. */
export function clankerPrompt(cfg: Config): string {
  const netOf = (a: { network?: string }) => a.network ?? cfg.network;
  const isEvm = (a: { network?: string }) => netOf(a).startsWith("eip155:");
  const rails = cfg.assets.map((a) =>
    `- ${a.symbol}  ${isEvm(a) ? "token" : "mint"} ${a.mint}  ${netOf(a)}  decimals ${a.decimals}  ${a.feeBps}bps tax  price ${a.stableUsd ? `$${a.stableUsd} stable` : `${a.priceSource === "dexscreener" ? "DexScreener" : "Birdeye"} ${a.priceMint} at the 402`}`
  ).join("\n");
  const hasSvm = cfg.assets.some((a) => !isEvm(a));
  const hasEvm = cfg.assets.some(isEvm);
  return `Use ${cfg.publicUrl} as an OpenAI-compatible inference endpoint. There is no API key.

POST ${cfg.publicUrl}/v1/chat/completions
Content-Type: application/json

Body is a normal OpenRouter/OpenAI chat completion:
{"model":"${cfg.defaultModel}","messages":[{"role":"user","content":"..."}],"max_tokens":256}

IMAGE AND VIDEO ARE ALSO SERVED, on their own endpoints. /v1/chat/completions
cannot emit them — do not conclude from a text response that this endpoint has
no media. Same 402 and same rails; billed per image or per clip, not per token.

POST ${cfg.publicUrl}/v1/images/generations
{"model":"${cfg.defaultImageModel}","prompt":"...","width":1024,"height":1024}
  -> {"data":[{"url":"https://..."}]}

POST ${cfg.publicUrl}/v1/videos/generations
{"model":"${cfg.defaultVideoModel}","prompt":"...","seconds":5,"resolution":"720P"}
  -> {"id":"...","status":"in_progress"}     resolution is "720P" or "1080P"

GET  ${cfg.publicUrl}/v1/videos/{id}
  -> {"status":"completed","outputs":{"video_url":"https://..."}}
  Polling is FREE — the render was paid for at submit. Poll until status
  leaves "in_progress"; a failed job explains itself in error.message.

GET /v1/models lists these alongside the text models, tagged kind:"image" or
kind:"video" with the per-unit price. leCore memory does NOT apply to a render
(a prompt that short never spills) — do not claim it improved the output.

You will get HTTP 402. That is the product, not an error.

accepts[] will include one row per offered rail. Pick ONE:
${rails}

Every row carries its OWN network, payTo and decimals. READ THEM OFF THE ROW —
they are NOT the same across rails:
- network: the row's "network" (Solana CAIP-2, or eip155:<chainId>)
- payTo: the row's "payTo". Solana rows carry a base58 address; eip155 rows
  carry a 0x address. They are different addresses. Never reuse one for the other.
- extra.decimals: the raw-unit exponent OF THAT ASSET. It is 6 on some rails and
  18 on others. Do not assume.
- maxAmountRequired: the final amount ALREADY in that asset's raw units, grossed
  up for its transfer tax. Do not reprice it and DO NOT multiply it by
  10^decimals — that is already done. extra.decimals is for display only.
- extra.feePayer: Solana rows only.
- extra.pricing: how the price was formed. "volume" = a fraction of what this body costs
  buying direct, set by your trailing ${cfg.volumeWindowDays}-day spend (extra.volume).
  "counterfactual" = that, times a further leCore compression discount, because we never
  forwarded the whole body. Either way extra.rate is the fraction of direct you paid and
  it is NEVER above 1: this gateway is at most as expensive as OpenRouter, and cheaper the
  more you use it. "markup" only appears on the per-unit media lane.
- facilitator: ${cfg.facilitator}

${hasSvm ? `IF THE ROW YOU PICKED IS A SOLANA ROW — build one legacy Transaction:
1. feePayer = the row's extra.feePayer (${cfg.feePayer}) ← you do not pay SOL.
2. exactly one Token-2022 TransferChecked: your ATA of the chosen mint → payTo's
   ATA, amount = maxAmountRequired (raw, as given),
   decimals = the row's extra.decimals ← read it off the row, do not hardcode
3. you sign as the token owner. leave the feePayer signature empty.
4. serialize requireAllSignatures=false, base64 those bytes

X-PAYMENT header = base64 of this JSON (utf8):
{"x402Version":1,"scheme":"exact","network":"<the row's network>","payload":{"transaction":"<base64-tx>"}}
` : ""}${hasEvm ? `IF THE ROW YOU PICKED IS AN eip155 ROW — sign EIP-3009, send no transaction:
1. you pay NO gas. The facilitator relays your signature and pays it.
2. EIP-712 typed-data sign TransferWithAuthorization with domain
   {name: extra.name, version: extra.version, chainId: <from eip155:chainId>,
    verifyingContract: the row's asset}
   ← name/version come off the ROW. Guessing them recovers a different address
     and the payment is rejected as "signature does not match payer".
3. message = {from: <your address>, to: <the row's payTo>,
              value: maxAmountRequired (raw uint256, VERBATIM — no decimal
              scaling, this is where an agent loses 10^12),
              validAfter: 0, validBefore: <now + maxTimeoutSeconds>,
              nonce: <random 32 bytes, 0x-hex>}

X-PAYMENT header = base64 of this JSON (utf8):
{"x402Version":1,"scheme":"exact","network":"<the row's network>","payload":{"signature":"0x…","authorization":{"from":"0x…","to":"0x…","value":"<maxAmountRequired>","validAfter":"0","validBefore":"<unix>","nonce":"0x…"}}}
` : ""}

POST the SAME body again with X-PAYMENT set. Do not change model/messages/max_tokens after the 402 — the quote is for that body.

On 200 you get a normal chat.completion.

ON SOLANA, raw TOKEN (EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump) and raw USDC will not settle. Wrap first:
- USDC → yUSDCx via FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE escrow 2qLm8aCvn6gQVUFeQ7EC5J62Y95gFzc3vReHzD5d5Gj2
- TOKEN → wTOKENx via the same program, escrow 7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q
Both wraps are Token-2022 with a 20bps transfer tax. Yield is that tax.

ON BASE there is no wrap step — the row is native Circle USDC, held directly.
ON ROBINHOOD CHAIN the row is wUSDGx, an ERC-4626 wrapper over Paxos USDG
(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168): approve the wrapper, then
deposit(uint256,address). See ${cfg.facilitator}/start.
On both eip155 rails you pay no gas — the facilitator relays your signature.

Do not use api.cdp.coinbase.com. This service names ${cfg.facilitator}. GET ${cfg.publicUrl}/.well-known/x402.json and ${cfg.publicUrl}/prompt.txt if you want this text again.`;
}

/**
 * Work pattern: Decide, with a Learn spine.
 * One action — prove the 402 — sits above the explanation.
 * Gold is reserved for money. Teal is the room, not a gradient.
 */
export function renderIndex(cfg: Config): string {
  // Derived from the same asset list that emits the 402 — new rails (e.g. the
  // memecoin twins) appear here the moment they join accepts[], no copy edit.
  const netOf = (a: { network?: string }) => a.network ?? cfg.network;
  const underlyings = uniq(cfg.assets.map((a) => underlyingName(a.symbol)));
  const chains = uniq(cfg.assets.map((a) => chainName(netOf(a))));
  const listOr = (xs: string[]) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " or " + xs[xs.length - 1]);
  const rails = listOr(underlyings);
  const chainList = listOr(chains);
  // HONESTY LINE — "live/settled" is reserved for chains that have actually
  // settled a payment. As of 2026-08-14 all three have: Solana (all day),
  // Robinhood Chain (wUSDGx EIP-3009 batched settle), Base (native USDC
  // EIP-3009 batched settle). A future chain starts OUTSIDE this set and is
  // described as "offered" until its first real settlement.
  const SETTLED = new Set(["Solana", "Base", "Robinhood Chain"]);
  const byChain = new Map<string, string[]>();
  for (const a of cfg.assets) {
    const c = chainName(netOf(a));
    byChain.set(c, uniq([...(byChain.get(c) ?? []), underlyingName(a.symbol)]));
  }
  const railLines = [...byChain.entries()]
    .map(([c, assets]) => {
      const status = SETTLED.has(c)
        ? `<span class=live>settled real payments</span>`
        : `<span class=new>offered · no settlement yet</span>`;
      return `<b>${esc(c)}</b> — ${esc(assets.join(" · "))} · ${status}`;
    })
    .join("<br>");
  const curl = `curl -sS ${cfg.publicUrl}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"${cfg.defaultModel}","messages":[{"role":"user","content":"say hi"}]}'`;
  const clanker = clankerPrompt(cfg);

  return `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>tokens — pay tokens for tokens</title>
<meta name=description content="Every model with holographic memory in front. Long context costs HALF of buying direct, paid in ${esc(rails)} on ${esc(chainList)}, priced at the 402.">
<link rel=icon href=/token.jpg>
<style>
:root{
  color-scheme:dark;
  --bg:oklch(13% .014 165);
  --surface:oklch(17% .017 165);
  --line:oklch(28% .022 165);
  --ink:oklch(95% .012 165);
  --mid:oklch(72% .02 165);
  --dim:oklch(54% .022 165);
  --accent:oklch(84% .19 158);
  --accent-ink:oklch(16% .04 158);
  --money:oklch(85% .15 92);
  --ok:oklch(80% .16 152);
  --bad:oklch(72% .16 25);
  --sans:"Söhne","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  --mono:"Berkeley Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --0:clamp(.88rem,.83rem + .2vw,.97rem);
  --1:clamp(1.05rem,.96rem + .4vw,1.25rem);
  --2:clamp(1.6rem,1.2rem + 1.6vw,2.6rem);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:var(--0)/1.55 var(--sans);
  -webkit-font-smoothing:antialiased;
  padding:clamp(1.25rem,4vw,3.5rem) 1.25rem 6rem;
}
main{max-width:64rem;margin:0 auto;display:grid;gap:2.5rem}
@media(min-width:840px){
  .top{display:grid;grid-template-columns:1fr 16rem;gap:2.5rem;align-items:start}
}
.kicker{font-family:var(--mono);font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
h1{font-size:var(--2);letter-spacing:-.035em;line-height:1.05;margin:.4rem 0 0;max-width:16ch;text-wrap:balance}
h1 em{font-style:normal;color:var(--accent)}
.lede{color:var(--mid);font-size:var(--1);max-width:46ch;margin:.9rem 0 0}
.coin{width:100%;max-width:16rem;border-radius:50%;border:1px solid var(--line);display:block}
.prove{
  border:1px solid var(--line);border-radius:14px;background:var(--surface);
  padding:1.15rem 1.2rem 1.25rem
}
.prove h2{margin:0 0 .35rem;font-size:1rem;letter-spacing:-.02em}
.row{display:flex;flex-wrap:wrap;gap:.5rem;margin:.8rem 0}
button,.copy{
  font:640 .92rem/1 var(--sans);letter-spacing:-.01em;
  border-radius:10px;padding:.75rem 1rem;cursor:pointer;border:1px solid var(--accent);
  background:var(--accent);color:var(--accent-ink)
}
button:hover,.copy:hover{filter:brightness(1.06)}
button:disabled{opacity:.45;cursor:not-allowed}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
button:focus-visible,.copy:focus-visible,a.try:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
a.try{
  display:inline-flex;align-items:center;gap:.4rem;margin-top:1.15rem;
  font:640 var(--1)/1 var(--sans);letter-spacing:-.02em;text-decoration:none;
  border-radius:12px;padding:.9rem 1.15rem;border:1px solid var(--accent);
  background:var(--accent);color:var(--accent-ink)
}
a.try:hover{filter:brightness(1.06);color:var(--accent-ink)}
pre{
  margin:.6rem 0 0;padding:.85rem 1rem;border-radius:10px;overflow:auto;
  background:oklch(11% .014 165);border:1px solid var(--line);
  font: .82rem/1.45 var(--mono);color:var(--money);max-height:28rem
}
pre.err{color:var(--bad)}
.meta{color:var(--dim);font-family:var(--mono);font-size:.75rem;margin-top:.45rem}
ol{margin:.4rem 0 0;padding:0 0 0 1.2rem;max-width:58ch;color:var(--mid)}
li{margin:.45rem 0}
li strong{color:var(--ink)}
code{font-family:var(--mono);color:var(--money);font-size:.92em}
a{color:var(--accent)}
a:hover{color:var(--ink)}
.grid{display:grid;gap:1rem}
@media(min-width:700px){.grid{grid-template-columns:1fr 1fr}}
.card{border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;background:var(--surface)}
.card h3{margin:0 0 .35rem;font-size:.95rem}
.card p{margin:0;color:var(--mid)}
.live{color:var(--ok);font-family:var(--mono);font-size:.75rem}
.new{color:var(--money);font-family:var(--mono);font-size:.75rem}
footer{color:var(--dim);font-size:.85rem}
</style>
<body>
<main>
  <div class=top>
    <div>
      <div class=kicker>x402 · lecore memory · half of direct</div>
      <h1>pay <em>tokens</em> for tokens</h1>
      <p class=lede>Every model, with holographic memory in front. Send a book — we spill it into leCore and the model only ever sees the slice that answers you, so long context costs <em>half of buying direct</em>. No API key. You pay in ${esc(rails)} — on ${esc(chainList)} — and the 402 names the exact amount in USD at that second.</p>
      <a class=try href="https://chat.accrue.fund">try it yourself</a>
    </div>
    <img class=coin src=/token.jpg width=256 height=256 alt="TOKEN transit token">
  </div>

  <section class=prove>
    <div class=kicker>prompt your clanker</div>
    <h2>Dump this into Claude / Grok / Codex. It has everything.</h2>
    <p class=lede style="margin-top:.4rem;font-size:var(--0)">No SDK. No provider key. If it can POST and sign — a Solana <code>TransferChecked</code>, or an <code>EIP-3009</code> authorization on Base or Robinhood Chain — it can buy inference here. Raw prompt also at <a href="/prompt.txt"><code>/prompt.txt</code></a>.</p>
    <div class=row>
      <button id=copyclanker type=button>copy prompt</button>
    </div>
    <pre id=clanker>${esc(clanker)}</pre>
    <div class=meta>pay in ${esc(underlyings.join(" · "))} · on ${esc(chains.join(" · "))} · the 402 names each rail's exact mint, payTo and amount</div>
  </section>

  <section class=prove>
    <div class=kicker>prove it</div>
    <h2>Hit the endpoint. It should 402 you.</h2>
    <p class=lede style="margin-top:.4rem;font-size:var(--0)">No wallet in the browser. This button is a GET-equivalent POST with no <code>X-PAYMENT</code>. If the service is up you get a challenge, not a completion.</p>
    <div class=row>
      <button id=hit type=button>call /v1/chat/completions unpaid</button>
      <button id=copycurl class=ghost type=button>copy curl</button>
    </div>
    <pre id=out>${esc(curl)}</pre>
    <div class=meta id=status>unpaid POST · expect HTTP 402</div>
  </section>

  <!-- MEDIA. The storefront advertised chat only, which stopped being true the
       moment /v1/images and /v1/videos shipped — and agents were reading this
       page, seeing text endpoints, and concluding the zoo could not do media at
       all. Same 402, same rails, different unit of billing. -->
  <section>
    <div class=kicker>pictures and moving pictures</div>
    <h2>It is not only text.</h2>
    <p class=lede style="margin-top:.4rem;font-size:var(--0)">Image and video generate on their own endpoints — same 402, same rails, but billed <strong>per image or per clip</strong>, not per token. <code>GET /v1/models</code> lists them with <code>kind:"image"</code> / <code>kind:"video"</code> and the price per unit.</p>
    <pre>POST /v1/images/generations
{"model":"black-forest-labs/FLUX.1-schnell","prompt":"...","width":1024,"height":1024}
  -> 200 {"data":[{"url":"https://..."}]}

POST /v1/videos/generations
{"model":"Wan-AI/wan2.7-t2v","prompt":"...","seconds":5,"resolution":"720P"}
  -> 200 {"id":"...","status":"in_progress"}

GET  /v1/videos/{id}          # free to poll — the render was paid for at submit
  -> 200 {"status":"completed","outputs":{"video_url":"https://..."}}</pre>
    <div class=meta>video is asynchronous: you pay once at submit, then poll for free until <code>status</code> leaves <code>in_progress</code> · <code>resolution</code> is <code>720P</code> or <code>1080P</code></div>
  </section>

  <section>
    <div class=kicker>for degenerates</div>
    <ol>
      <li><strong>Pick ONE row</strong> from <code>accepts[]</code>. Every row carries its own network, asset, <code>payTo</code> and <code>decimals</code> — read them off the row, they differ per rail.</li>
      <li><strong>Solana rows:</strong> fund with USDC or TOKEN, then pay via the row's settlement mint (raw USDC/TOKEN will not settle — the 402 and <a href="${esc(cfg.facilitator)}/start">${esc(cfg.facilitator)}/start</a> spell out the deposit step). One <code>TransferChecked</code> of <code>maxAmountRequired</code>; the fee payer is sponsored, you need no SOL.</li>
      <li><strong>Base / Robinhood Chain rows:</strong> no transaction at all — EIP-712-sign an EIP-3009 <code>TransferWithAuthorization</code> and the facilitator relays it and pays the gas. Base takes native Circle USDC directly; Robinhood Chain settles USDG (deposit path at <a href="${esc(cfg.facilitator)}/start">/start</a>).</li>
      <li><strong>POST the same body again</strong> with header <code>X-PAYMENT</code> = base64 of the x402 payload for your rail. On 200 you get a normal OpenRouter chat completion. The key never leaves this host.</li>
    </ol>
  </section>

  <div class=grid>
    <div class=card>
      <h3>Price</h3>
      <p><b>Never more than OpenRouter.</b> Every price here is a fraction of what that exact body costs buying direct — <code>extra.directUsd</code>, <code>extra.rate</code> and <code>extra.savedPct</code> ride on the 402, so you can check it. The fraction <b>falls as you talk more</b>: your trailing ${esc(cfg.volumeWindowDays)}-day spend sets it, down to ${esc(Math.round(cfg.volume.rateFloor * 100))}% of direct, continuously and with no tier cliff (<code>extra.volume</code> shows where you are). <b>Long context</b> goes further still — when leCore compresses the body you pay a fraction of a fraction, because we never forwarded the whole thing. USDC and USDG rails are $1 stable. <a href="https://pump.fun/coin/EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump">TOKEN</a> is Birdeye spot <em>at the 402</em>. Rails that settle through a yield wrap take 20bps on transfer — that's the yield, and <code>maxAmountRequired</code> already grosses it up.</p>
    </div>
    <div class=card>
      <h3>Rails today</h3>
      <p>${railLines}</p>
      <p style="margin-top:.4rem">TOKEN is <code>EVULo…pump</code> on <a href="https://pump.fun/coin/EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump">pump.fun</a>. New rails appear in <code>accepts[]</code> the moment they go live — the 402 is the source of truth, not this page.</p>
    </div>
  </div>

  <footer>
    <a href="https://chat.accrue.fund">try it yourself</a>
    · facilitator <a href="${esc(cfg.facilitator)}/supported">${esc(cfg.facilitator)}</a>
    · source <a href="https://github.com/accruedotfund/x402-tokens">accruedotfund/x402-tokens</a>
    · <a href="/prompt.txt">prompt.txt</a>
    · <a href="/.well-known/x402.json">manifest</a>
    · <a href="/healthz">healthz</a>
  </footer>
</main>
<script>
const out = document.getElementById("out");
const status = document.getElementById("status");
const hit = document.getElementById("hit");
const curl = ${JSON.stringify(curl)};
const clanker = ${JSON.stringify(clanker)};
document.getElementById("copyclanker").onclick = async () => {
  await navigator.clipboard.writeText(clanker);
  document.getElementById("copyclanker").textContent = "copied";
  setTimeout(() => document.getElementById("copyclanker").textContent = "copy prompt", 1200);
};
document.getElementById("copycurl").onclick = async () => {
  await navigator.clipboard.writeText(curl);
  document.getElementById("copycurl").textContent = "copied";
  setTimeout(() => document.getElementById("copycurl").textContent = "copy curl", 1200);
};
hit.onclick = async () => {
  hit.disabled = true;
  status.textContent = "calling…";
  out.classList.remove("err");
  try {
    const r = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: ${JSON.stringify(cfg.defaultModel)}, messages: [{ role: "user", content: "say hi" }] }),
    });
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
    status.textContent = "HTTP " + r.status + (r.status === 402 ? " · that's the challenge. pick ONE accepts[] row and pay its maxAmountRequired on its own network." : "");
    if (r.status !== 402) out.classList.add("err");
  } catch (e) {
    out.classList.add("err");
    out.textContent = String(e);
    status.textContent = "failed";
  } finally {
    hit.disabled = false;
  }
};
</script>
`;
}
