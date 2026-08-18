# x402-tokens

OpenRouter behind [x402](https://x402.org). You do not bring an API key. You pay.

**At most as expensive as OpenRouter, and cheaper the more you use it.** OpenRouter's own
published USD rate is the ceiling — never a multiple of it — converted at the moment the 402
is issued. From there the price only goes down:

- **Volume.** The fraction of direct you pay falls continuously with your trailing 30-day
  spend on this gateway, from 1.0 for your first call toward a floor of 0.25. No tiers, no
  cliff, nothing to sign up for. Every 402 and every receipt carries `extra.volume` so you
  can see where on the curve you are.
- **Context reuse.** When leCore compresses a body — bind once, then ask against the bound
  context — you additionally pay a fraction of what that whole body would have cost you
  direct, because we never forwarded the whole thing.

The two compose, and a hard floor stops any combination from pricing under our own upstream
cost. Tunable without a redeploy: `X402_RATE_FLOOR`, `X402_VOLUME_SCALE_USD`,
`X402_VOLUME_DECAY`, `X402_VOLUME_WINDOW_DAYS` (`X402_VOLUME_DECAY=0` pins everyone at the
ceiling). `X402_MARKUP` now applies only to the per-unit media lane, where there is no
OpenRouter price to be cheaper than.

Today the rail is **yUSDCx** on Solana (wrapped USDC, 6 decimals, treated as $1). A memecoin wrap will use the same USD math at Birdeye spot. It is not listed yet — we are proving the pipe on yUSDCx first.

```
POST /v1/chat/completions     unpaid → 402
                              X-PAYMENT → OpenRouter completion
GET  /                        how to use it, plus a live 402 button
GET  /healthz
GET  /quote
GET  /.well-known/x402.json
```

Facilitator: `https://x402.accrue.fund`  
Fee payer / payTo: `WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb`

## Prove it

```bash
curl -sS https://x402-tokens.fly.dev/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"say hi"}]}'
```

Expect HTTP 402 and an `accepts[]` row for yUSDCx. `scripts/pay.mjs` signs that challenge and reprints the completion.

## Run

```bash
cp .env.example .env   # OPENROUTER_API_KEY required
npm i
npm run build
npm run selftest
node bin/x402-tokens.mjs
```

`scripts/wrap-yusdcx.mjs` wraps USDC → yUSDCx. `scripts/pay.mjs` does the paid call. Both read `~/jjj.json`.

Unaudited. Holds an OpenRouter key, never user funds.
