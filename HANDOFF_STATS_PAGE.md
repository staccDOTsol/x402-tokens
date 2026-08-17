# Handoff — `/stats` page for the openzoo site

Build a public stats page at the `stats` slug: spend, margin, leCore saving,
call volume, payers, and growth over time.

**You do not need to solve data collection.** The gateway serves a purpose-built
stats API with real daily history and pre-computed growth. Call it and render.

---

## 1. The endpoint

```
GET https://x402-tokens.fly.dev/v1/stats
```

Public, no auth, no payment, CORS enabled — a browser or webview can call it
directly. Refresh client-side every 30–60s; it is cheap.

Response:

```jsonc
{
  "app": "x402-tokens",
  "today": {
    "day": "2026-08-17",
    "calls": 10000,            // ALL requests: free + quoted-not-paid + paid
    "paid": 148,               // calls that actually settled
    "free": 3271,
    "quoted_not_paid": 3173,   // got a 402, never returned
    "failed_settle": 29,
    "usdPaid": 7.34,           // what users paid us
    "usdCogs": 2.64,           // what we paid upstream
    "usdDirect": 390.01,       // same work WITHOUT leCore (counterfactual)
    "distinctPayers": 3,
    "marginPct": 64.0,
    "lecoreSavingX": 53.2,     // usdDirect / usdPaid
    "conversionPct": 4.5       // paid / (paid + quoted_not_paid)
  },

  "days": [                    // one row per UTC day, oldest first
    { "day": "2026-08-16", "calls": …, "paid": …, "usdPaid": …, "usdCogs": …,
      "usdDirect": …, "distinctPayers": …, "marginPct": …, "lecoreSavingX": … },
    { "day": "2026-08-17", … }
  ],

  "growth": {                  // null until there are ≥2 complete days
    "dayOverDay":  { "calls": 12.4, "paid": 8.1, "usdPaid": 15.2, "distinctPayers": 0 },
    "weekOverWeek": null,      // null until ≥14 days
    "trailing7":   { "calls": …, "paid": …, "usdPaid": …, "avgDailyUsd": … }
  },

  "topModels": [ { "model": "google/gemini-2.5-flash", "calls": 772 } ],
  "coverage": { "days": 1, "since": "2026-08-17", "complete": true, "caveat": "…" }
}
```

All percentages are numbers already computed server-side — do not recompute
margin or the saving multiple in the browser, so the site and the in-app HUD
cannot disagree.

`growth.*` fields are **percent change**, and are `null` (not `0`) when there
is not enough history. Render "collecting" for null, never a zero or a flat
line.

---

## 2. Page shape (suggested, not binding)

- **Hero row** — paid (metered), our cost, margin, direct-would-be, leCore
  saving. Mirror the in-app HUD wording so the two surfaces read the same.
- **Volume** — calls / paid / free / quoted-not-paid + conversion %.
- **Growth** — day-over-day and trailing-7 from `growth`; hide any card whose
  value is `null` rather than rendering an empty chart.
- **Series** — line/bar over `days` for usdPaid, paid, distinctPayers.
- **Top models** — bar list from `topModels`.
- **Footer** — `coverage.caveat` verbatim and `coverage.since`.

---

## 3. Honesty rules — these are money figures

Being wrong here is worse than being sparse.

- **`usdDirect` is a counterfactual**, not a bill anyone received. Label it
  "what this would have cost without openzoo". Never call it "saved" bare.
- **The saving multiple is not a constant.** It scales with corpus size: a
  small input genuinely prices *worse* than sending it directly — MEASURED
  0.56x on a 64KB corpus, 174x on 27MB. If `lecoreSavingX` is below 1, show it
  as-is and say plainly that small inputs cost more. Do not floor it at 1x.
- **`calls` is not paid usage.** 10,000 calls with 148 paid is mostly free and
  quoted-not-paid traffic. Show both. Leading with "10,000 calls" alone is
  misleading.
- **`distinctPayers` is 3.** Do not present a 3-payer day as adoption.
- Payer identity is an 8-char prefix by design. Nothing that resembles a full
  wallet address should ever reach the page.
- History starts the day the rollup shipped (`coverage.since`). Do not
  backfill, estimate, or imply earlier data exists.

---

## 4. Verified facts (checked 2026-08-17 — do not re-derive)

- CORS is live on the gateway: `OPTIONS` → **204**, `access-control-allow-origin`
  echoes the caller, `x-payment-response` is exposed.
- `/v1/stats` needs no auth and no payment.
- Daily rows are persisted to the Fly volume and survive restarts and deploys.
- The gateway runs on **one** machine deliberately (the credit ledger is
  machine-local). A single entry under `perMachine` in the older
  `/v1/usage/summary` is expected, not an error.
- `/v1/usage/summary` still exists and is unchanged — it is the raw/live view.
  Prefer `/v1/stats` for this page; it is the one with history.
