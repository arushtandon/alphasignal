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
- Evidence (gating, instrument): F12-A "FTSE 100 via ISF.L −1..+3": 202 trades,
  net +21.3 %, **t 0.91**, 3/4 windows, max DD 17.7 % → **FAIL** (t < 1.5).
  Index row (^FTSE −1..+3): net +68.2 %, t 2.09, 3/4, DD 13.0 % → eligible.
- Status 2026-10-26: **ineligible on the executable instrument.** Built and
  dry-runnable; emits nothing until the evidence basis is changed by decision.

### INCUBATION_HK_TOM — 2800.HK, −1..+3

- Same rule and order path (SEHK `OPG` at the open; closing-window exit at
  16:00 HKT). HK ETFs are stamp-exempt (cost model updated as above).
- Evidence (gating, instrument): post-hoc diagnostic 2026-10-26 running the
  F12-A procedure on 2800.HK (not a pre-registered instrument; Yahoo history
  from 2016-11): 120 trades, net +33.9 %, **t 1.26**, 3/4 windows, DD 18.8 %
  → **FAIL**. Index row (^HSI −1..+3): t 1.16 → FAIL. The only eligible Hang
  Seng row in F12-A is −1..+1 (t 1.86), and 2800.HK −1..+1 post hoc is t 1.49
  with 1/4 windows → FAIL.
- Status 2026-10-26: **ineligible on both bases for −1..+3.**

### INCUBATION_US_LONG_P6 — 12-1 momentum, Piotroski ≥ 6, k=1, 6-month hold

- Rule: at the first session of each month rank US universe names with a
  point-in-time Piotroski score ≥ 6 (statement filing/accepted date + 45 days)
  by 12-1 return; buy the top name not already held; sell each sleeve after six
  months. $10k per sleeve, up to 6 sleeves. Buy only, no stop, US pre-market
  amendment applies (LMT-PRE from 04:00 NY, OPG from 09:25 NY).
- Evidence (gating): momentum rescore `US__long__12-1__piotroski6` k1 vs SPY,
  152 months: excess +965.7 pp, t 2.17, 3/4 windows, DD 28.8 % → **eligible**.
- Data: the planner reads `data/research/fmp/us-universe.json` and
  `data/research/fmp/US/<symbol>/{income,balance,cashflow}.json`. That cache is
  gitignored and exists only on the research machine. **On Render it is
  absent**, so the dry-run reports `piotroski-data-missing` / `universe-missing`
  and the book cannot run there until the cache is published to the persistent
  disk (`FMP_RESEARCH_DIR`) or a monthly on-Render statement fetch is built.
- Status 2026-10-26: eligible, not enabled, blocked on Render by the data gap.

## Deviations log

- none
