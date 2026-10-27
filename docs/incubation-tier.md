# Incubation tier — not validated

Created 2026-10-26. Rules here are enforced by `lib/strategy/incubation-tier.js`
and the modules that import it (`setup-book-execution.js`, `momentum-book.js`,
`tom-book.js`, `server.js` `emitTradeEvent`, `ibkr-bridge/bridge.js` sizing).
Every number below is read from code, not retyped; if the doc and the code
disagree, the code is wrong and should be fixed to match this page.

## Purpose

A paper-money holding pen for pre-registered books that cleared the
`INCUBATION_ELIGIBLE` bar but failed `VALIDATION_PASS`. They trade small, sit
at the bottom of the capital queue, are labelled so nobody mistakes them for
validated books, and are reviewed against their own backtest expectation.
Nothing in this tier is evidence of edge; it is a cheap way to learn whether
the live path reproduces the backtest.

## Eligibility (gate 1)

A book is eligible only if all of the following hold for the evidence row it
is registered on:

| Rule | Threshold | Code |
| --- | --- | --- |
| Pre-registered | spec committed before the run | `INCUBATION_BOOKS[id].preRegistered` |
| Full-sample net excess | > 0 pp | `netExcessPp > 0` |
| Positive windows | ≥ 3 of 4 | `positiveWindows >= 3` |
| Excess t-stat | ≥ 1.5 | `excessT >= 1.5` |
| Max drawdown | < 50 % | `maxDrawdownPct < 50` |

`incubationEligibility(id)` returns `{ eligible, failReasons[] }`. The evidence
row is the **executable instrument** by default (`evidenceBasis: 'instrument'`).
Index-level rows are stored alongside for reference but do not gate. Switching
a book to `evidenceBasis: 'index'` is a deviation and must be recorded in this
file with the date and the reason.

## Enable (gate 2)

Eligibility alone does not trade. Each book also needs
`<SETUP_ID>_ENABLED=1` in the serving environment (Render for emission). The
server's `emitTradeEvent` refuses incubation entries that fail either gate, so
a planner bug cannot leak an order. Dry-runs (`/api/setup-book/momentum-run`
with `dryRun:true`) show the candidate order and the gate reason without the
flag.

## Sizing, capacity, priority, label

| Item | Value | Code |
| --- | --- | --- |
| Ticket | $10,000 per position | `INCUBATION_TICKET_USD`; `setupTicketUsd()`; bridge `ticketNotionalUsd` |
| Slots | at most 10 incubation positions, counted inside the 50-slot pool | `INCUBATION_MAX_SLOTS`; `evaluateCapitalPool` → `capacity / incubation-slots` |
| Gross cap | shares the 2× gross-leverage cap and the 15 % excess-liquidity floor with every other book | unchanged `leverageDecision` / `marginDecision` |
| Priority | tier 4 → priority 40, below Experimental (30) and every evidence tier | `evidenceTier()`; `compareSetupEntries` |
| Label | `Incubation — not validated` in `tier`, `experimentalLabel`, order events, P&L view | `INCUBATION_LABEL` |
| Tag / ledger | `SETUP_BOOK:<id>` | `setupTag`, `ledgerNamespace` |
| P&L view | `/api/setup-book/status` → `pnl[<id>]` with `benchmark` | `setupBookPnlViews` (enumerates `SETUPS`) |
| Status | `/api/setup-book/status` → `incubation.books[]` (eligibility, enabled) and `capital.incubation` (slots) | server status route |

## Review (6 months or 30 trades, whichever first)

`incubationReview(id, { monthsLive, closedTrades, liveExcessPct, liveMaxDrawdownPct })`:

- **promote** when live excess vs benchmark is positive and within 1 SD of the
  backtest expectation scaled to the live sample;
- **stop** when live excess is more than 1 SD below expectation, or live
  drawdown exceeds 1.5 × the backtest max drawdown (checked at any time, not
  only at review);
- **hold** otherwise (not positive but not >1 SD worse; or >1 SD better —
  check tags/data before promoting).

Expectation and SD come from the evidence row: per-trade mean and
`SD = mean·√n / t` for trade-based books, monthly for the momentum book.
Promotion means re-running the full validation standard, not a label change.

## Books

### INCUBATION_UK_TOM — ISF.L, −1..+3

- Rule: long from the close of the last trading day of the month, executed at
  the open of the first session of the new month, sold in the closing window
  (last 20 min) of trading day +3. Buy only, no stop, $10k.
- Order path: existing momentum no-stop path → LSE `LMT-OPEN` at the open,
  server `setup-time-exit` (`time_limit`) → bridge flatten.
- Cost model: `lib/research/cost-model.js` now exempts `ISF.L` (and listed
  UK/HK ETFs, or `etf:true`) from the 50 bp SDRT; the F12 run already used
  0.10 % round trip for ISF.L.
- Evidence (gating, instrument): F12-A on ISF.L, rescored 2026-10-27 with
  `scripts/score-incubation-tom.js`. None of the three variants clears t ≥ 1.5.

  | Variant | Trades | Net | t | Windows | Max DD | Eligible |
  | --- | ---: | ---: | ---: | ---: | ---: | --- |
  | −1..+3 | 202 | +21.30% | 0.91 | 3/4 | 17.7% | no |
  | −1..+1 | 202 | −8.44% | −0.66 | 3/4 | 23.2% | no |
  | −2..+3 | 201 | +14.34% | 0.62 | 4/4 | 22.9% | no |

- Index row (^FTSE −1..+3) is t 2.09 and would be eligible. The book is gated
  on the ETF, not the index.
- Status 2026-10-27: **disabled. No variant qualifies on ISF.L.**

### INCUBATION_HK_TOM — 2800.HK, −1..+3

- Same rule and order path (SEHK `OPG` at the open; closing-window exit at
  16:00 HKT). HK ETFs are stamp-exempt (cost model updated as above).
- Evidence (gating, instrument): `scripts/score-incubation-tom.js` on 2026-10-27,
  F12-A procedure from sample start. None of the three pre-registered variants
  is incubation-eligible on 2800.HK, so the book stays disabled.

  | Variant | Trades | Net | t | Windows | Max DD | Eligible |
  | --- | ---: | ---: | ---: | ---: | ---: | --- |
  | −1..+3 | 202 | +24.62% | 0.84 | 3/4 | 37.2% | no |
  | −1..+1 | 202 | +24.24% | 1.40 | 1/4 | 9.0% | no |
  | −2..+3 | 201 | +36.25% | 1.04 | 3/4 | 27.5% | no |

- Index row (^HSI −1..+3) was t 1.16. The only eligible Hang Seng index row in
  F12-A is −1..+1 (t 1.86); the ETF does not clear that variant either.
- Status 2026-10-27: **disabled. No variant qualifies on 2800.HK.**

### INCUBATION_US_LONG_P6 — 12-1 momentum, Piotroski ≥ 6, k=1, 6-month hold

- Rule: at the first session of each month rank US universe names with a
  point-in-time Piotroski score ≥ 6 (statement filing/accepted date + 45 days)
  by 12-1 return; buy the top name not already held; sell each sleeve after six
  months. $10k per sleeve, up to 6 sleeves. Buy only, no stop, US pre-market
  amendment applies (LMT-PRE from 04:00 NY, OPG from 09:25 NY).
- Evidence (gating): momentum rescore `US__long__12-1__piotroski6` k1 vs SPY,
  152 months: excess +965.7 pp, t 2.17, 3/4 windows, DD 28.8 % → **eligible**.
- Membership is the same current S&P 500 + Nasdaq-100 list the live scan
  uses (`universe.js` `fetchUSConstituents`). It does not read
  `us-universe.json`. Scores still use the statement cache under
  `DATA_DIR/research/fmp` (`/var/data/research/fmp` on Render), at filing
  date + 45 days. The web service refreshes those statements for current
  members monthly (1st UTC, and on boot if the cache is missing or older
  than 35 days).
- Report: the P&L view's `benchmark` is SPY and `hurdle` is QQQ (the rescore
  alpha is SPY+QQQ). Live excess versus each is the incubation review input;
  the book is not enabled.
- Status 2026-10-27: eligible, **not enabled**. Dry-run for 30 Nov is below.

## Deviations log

- 2026-10-27: scored −1..+3, −1..+1 and −2..+3 on ISF.L and 2800.HK with the
  F12-A procedure (`scripts/score-incubation-tom.js`). No variant is
  incubation-eligible on the traded instrument. Both books stay disabled.
  The earlier 2800.HK note (t 1.26 from 2016) was a shorter sample; the
  full sample from 2010 is t 0.84 on −1..+3.
