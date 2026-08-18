# Handoff: gateway pricing model v2 (2026-08-15)

> **SUPERSEDED 2026-08-18 — read this as history, not as the current model.**
> The `markup * baseUsd` ceiling described below is gone. Price is now a
> FRACTION of OpenRouter's own direct rate (ceiling 1x, never above), falling
> with the tenant's trailing spend. `X402_MARKUP` survives only on the
> per-unit media lane. The current model lives in `src/quote.ts` (quoteRequest),
> `src/math.ts` (volumeRate) and `src/spend.ts`; the invariants are asserted in
> `src/pricing.test.ts`. Everything below about the output clamp, the attach
> cost basis and the adjacent defects still stands.

For whoever picks this up (fresh session, other agent, human): everything below was
measured today on the ttfx goldrun; nothing is hypothetical. **Do not deploy while a
benchmark run is mid-flight** (standing rule), and note neither GitHub account can
push to `accruedotfund/x402-tokens` — push a fork and PR (wiki L602).

## Where the money leaks (the bug this handoff exists to fix)

`src/quote.ts` prices a call as:

```
markupUsd = baseUsd * cfg.markup            // markup = 3
billed    = counterfactual
            ? min(max(direct * 0.1, floorUsd), markupUsd)   // floor = 1.5 * baseUsd
            : markupUsd
```

**CORRECTED 2026-08-15 (late): attach precedes the quote, so baseUsd DOES see
post-attach tokens. The real leak is the output clamp — `maxOut = min(max_tokens,
4096)` — while reasoning models bill 16-19k completion tokens. Fixed in quote.ts
(clamp -> 32768). The paragraph below stands as the original (wrong) diagnosis.**

**`baseUsd` and `direct` are computed from the PRE-ATTACH request body.** When leCore
engages, the upstream call carries the attached context — measured on a real call:
`tokensBefore: 17 → tokensAfter: 8719`. The floor therefore protects a cost basis
~500x smaller than the real one on small-prompt + fat-attach traffic.

Measured damage (v3 goldrun, OURS = actual upstream tokens at OR rates):

| model            | billed | our upstream cost | margin |
|------------------|--------|-------------------|--------|
| gpt-5.6-sol-pro  | $2.07  | $10.66            | -$8.59 |
| claude-fable-5   | $3.61  |  $8.03            | -$4.41 |
| deepseek-v4-pro  | $0.14  |  $0.16            | -$0.02 |
| claude-sonnet-4  | $4.63  |  $3.38            | +$1.25 |

Cheap models roughly break even; expensive models bleed. The pattern is exactly
"floor never sees the attach".

## The fix (smallest correct version)

Base the floor and ceiling on the **post-attach** upstream estimate:

1. The 402 quote is issued before serving, but the attach size is known at quote
   time: `top_k x avg_chunk_tokens(context)` + body tokens. The sidecar's manifest
   knows avg chunk size per context; expose it (or cache last-attach size per
   context id, which the gateway already logs as `tokensAfter`).
2. `floorUsd = 1.5 * estUpstreamUsd(post_attach_tokens, model)`.
3. Keep the counterfactual VALUE price (10% of the user's no-zoo direct cost) as the
   headline — it is the product's story — but it must clamp against the REAL floor.
   `billed = min(max(direct * 0.1, floorUsd), markup * estUpstream)`.
4. On settle, log `est vs realized` upstream tokens (realized is in the OR response
   usage) so drift is visible in analytics. If p50 drift > 20%, revisit.

## Adjacent defects to fix in the same pass (all measured today)

- **No-settle on provider error**: gateway settled $0.088 on-chain for an xAI
  "Incorrect API key" error body. If upstream returns `error` and no `choices`,
  do not settle — void the payment. (grok bought ~$1 of error JSON today.)
- **Paid-for-silence**: empty content with `finish_reason: length` still bills.
  The retry guard exists (bounded, asked<512 only) but the QUOTE should carry it:
  reasoning models (deepseek, grok) need output floors — deepseek emitted 0 chars
  at 8k max_tokens, fine at 24k; grok pinned ct at exactly 16000.
- **Counterfactual "direct" reference prices shift Aug 16 16:00 UTC** (DeepSeek
  peak/off-peak). The counterfactual auto-adjusts; any hand-quoted "N× cheaper"
  copy does not (wiki L163).

## Reference numbers for regression tests

- Cache reality (measured, /tmp/ttfx_nozoo_measured.json): OpenAI warm=0.536x cold;
  Anthropic warm=1.0x (no cache without explicit cache_control); DeepSeek-via-OR
  warm=1.0x, cached_tokens=0. Do NOT assume 0.1x cache anywhere.
- xAI billing: `cost_in_usd_ticks * 1e-8` is ~50x HIGH vs the xAI console.
  Tokens x catalog rate ($6/$18 per M for grok-4.6) matches the console.
- leCore attach magnitude: 17 -> 8,719 tokens at top_k=32 on the ttfx corpus
  (600-char chunks). A quote model that estimates attach at
  `top_k * 170 tokens` would have been within 40% today.

## Files

- `src/quote.ts` — pricing core (floor/ceiling/counterfactual)
- `src/server.ts` — attach path; logs tokensBefore/tokensAfter; settle plumbing
- Deploy: fly (x402-tokens), two iad machines, Dockerfile ships prebuilt dist/
  (wiki L527 — build before deploy or the image serves stale code)
