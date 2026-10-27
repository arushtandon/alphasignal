# US quarterly hedged-short k=5 — build spec (plan only, no code)

Date 2026-10-26. Updated 2026-10-27. Status: **approved, not built.**
Build starts only after 10 consecutive trading days with no bridge outage.
That condition is not met (see the end of this file).

Decisions, 2026-10-27:

- Hedge: **beta-scaled SPY** (option b). Equal-dollar SPY is not this book.
- Composite: **A**. Both A and B were incubation-eligible. A is the one with
  4/4 positive windows. B (t 2.22, 3/4 windows) stays on the shelf.
- Deviations accepted: no survivor re-weighting; 50% per-name disaster cap;
  a name that fails the shortable or borrow check is skipped and not replaced;
  the backtest itself had no stops.

Source trial: F14 "US quarterly comp-A/comp-B k=5 SHORT (hedged)",
`scripts/f14-results.json`, pre-registered in
`docs/fund-program-preregistration-2026-10-25.md`.

| Variant | Quarters | Net | t vs 0 | Alpha t (SPY+QQQ) | Beta | Max DD | Windows + | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| comp-A k=5 hedged | 50 | +241 % | 2.00 | 2.19 | −0.35 | 27.4 % | 4/4 | INCUBATION_ELIGIBLE |
| comp-B k=5 hedged | 50 | +305 % | 2.22 | 2.44 | −0.62 | 25.8 % | 3/4 | INCUBATION_ELIGIBLE |

Neither is VALIDATION_PASS (monthly t < 3; a window with PF < 1.2). Under
`docs/incubation-tier.md` this is an **incubation** book: $10k per position,
inside the 10-slot incubation cap, lowest priority, labelled
"Incubation — not validated". The per-name short legs lose on their own
(comp-A per-trade mean −1.83 %, PF 0.85); the result is the spread against
the hedge. That is the thing being tested live, not stock-picking skill.

## 1. Rule as tested

- Universe: US ever-member file, fundamentals at filing + 45 days.
- Signal at the last session of each calendar quarter: within-sector
  percentile composite (A: 12-1 momentum, quality, value, low vol; B: adds
  1-month reversal). Short the bottom 5 by composite, at most 2 per sector,
  equal dollars.
- Hedge as tested: long index future at **beta × short notional**, beta =
  252-session beta of the short basket (average 1.22–1.27).
- Hold one quarter; rebalance at the next quarter-end: cover what left the
  bottom 5, short what entered, re-size the hedge.
- Costs: US round trip, borrow 1 %/yr (3 % below $5), micro round trip on
  hedge changes. **No stops of any kind.**

## 2. Live specification

### 2.1 Entry batch (quarter-end + 1 session, 06:00 SGT release)

1. Server computes the bottom-5 list and emits five `entry` events with
   `side: 'sell'`, `setupId: 'INCUBATION_US_HEDGED_SHORT_K5'`,
   `setupNotionalUsd: 10000`, `noStop: true`, plus one `hedge` event.
2. **Shortable / borrow gate, in the bridge, before any sell-to-open:**
   - `reqMktData` generic tick 236 → `shortable` (tick 46) and
     `shortableShares` (tick 89). Require `shortable ≥ 2.5` and
     `shortableShares ≥ 2 × order quantity`.
   - Borrow fee from IB's SLB availability file (`usa.txt`, columns
     FEERATE / AVAILABLE; refreshed daily by a small fetcher into
     `DATA_DIR/slb-usa.json`). Require `FEERATE ≤ 5 %`; names between 1 %
     and 5 % are allowed but the fee is written to the row for ledger
     accrual. Missing fee → treat as not shortable.
   - Reg SHO: if the stock is down ≥ 10 % from the prior close at order
     time, do not send a marketable sell; park a limit at the current ask
     for that session only.
   - A name that fails any check is skipped (`skipped: not-shortable|
     borrow-fee|reg-sho`), logged to the capital-pool skips list, **not
     replaced** by the 6th name (replacement would change the tested rule).
3. Orders: US pre-market amendment does not apply to sells; shorts go
   `MKT tif OPG` at the 09:30 auction via the existing US parent path with
   `action: 'SELL'`. Each short occupies one pool slot and one incubation
   slot.
4. **Hedge:** after the opening prints are reconciled (≤ 09:45 NY), buy
   SPY for the **filled** short notional. Two options for approval:
   - (a) **equal-$ SPY** (as requested): simple, but leaves a residual
     short beta of about −0.25 (basket beta ≈ 1.25 vs SPY 1.0); the
     backtest did not carry that residual;
   - (b) **beta × filled notional in SPY**, beta from the same 252-session
     window the signal used, capped at 1.6: matches the tested hedge,
     needs the beta carried on the event.
   Recommendation: (b), because (a) is a different book from the one
   scored. The hedge is one row (`hedge: true`, no stop) and counts as
   one incubation slot.
5. Partial fills: if fewer than 5 shorts fill by 09:45 NY the hedge is
   sized to what filled; unfilled shorts are cancelled, not chased.

### 2.2 Quarterly rebalance (next quarter-end + 1 session)

1. Server recomputes the bottom 5; diff against open rows.
2. Names leaving: `exit` events (`setupTimeExit`, `time_limit`,
   `reason: 'setup-time-exit hedged-short-rebalance'`) → bridge
   buy-to-cover `MKT OPG`.
3. Names entering: new `entry` sells through 2.1 (same gates).
4. Names staying: untouched (no re-weighting of survivors; the backtest
   re-weighted to equal dollars each quarter — stated deviation, keeps
   turnover and cost down; the alternative is a top-up/trim order per
   survivor, which is more code and more cost).
5. Hedge: re-sized to the post-rebalance filled short notional (× beta
   under option b); the difference is traded as one SPY order after the
   cover/short prints are reconciled.

### 2.3 Stops and risk (deviation from the backtest, stated)

- **The backtest had no stops.** Any stop is a deviation and is recorded
  in the book's deviations log. Proposed minimum:
  - per-name disaster cap: buy-to-cover at the next session if a short is
    up **50 %** from fill (unbounded-loss guard, not a trading stop;
    expected to trigger rarely and to cost a little edge);
  - book stop: stop opening new quarters if the hedged-spread drawdown
    exceeds **1.5 × backtest max DD ≈ 40 %**, per the incubation review
    rule;
  - operational: if the hedge cannot be filled within the session the
    shorts are covered the same session (never carry an unhedged basket
    overnight).
- Borrow recall / forced buy-in: handled as an operational exit; the row
  closes with `reason: 'buy-in'` and is not re-shorted that quarter.
- Dividends: dividend-in-lieu on shorts and SPY dividends on the hedge are
  booked to the ledger namespace from IB cash reports (new ledger fields
  `borrowFeeUsd`, `dividendInLieuUsd`).

### 2.4 Gross-cap fit

- Size: 5 × $10k short + $10k–$12.5k SPY = **$60k–$62.5k gross** (option
  a / b). On NLV $457k with gross $410k today (0.90×) the book takes
  gross to ≈ $472k ≈ **1.03×**, well inside the 2× cap and the 15 % excess-
  liquidity floor. It uses 6 of the 10 incubation slots and 6 of the 50
  pool slots.
- Margin: Reg-T short margin 50 % + SPY 50 % ≈ $31k initial on $62k gross;
  the margin gate already prices this through `marginDecision`.
- At the $30k ticket of validated books it would be $180k–$187k gross
  (≈ 1.3× total); not proposed — the tier rules size it at $10k.

### 2.5 P&L view

`SETUP_BOOK:INCUBATION_US_HEDGED_SHORT_K5` with three lines: short leg,
hedge, spread (short + hedge) against zero; plus the incubation review
numbers (expectation from the comp row: 50 quarters, t 2.0–2.2 →
quarterly SD ≈ 7–8 pp).

## 3. Estimate

| Piece | Days |
| --- | ---: |
| Shortable/borrow gate (tick 236/89, SLB fetcher, fee cap, Reg SHO check) | 2 |
| Sell-to-open path audit + cover routing + buy-in handling | 1 |
| Hedge row (size after fills, re-size on rebalance, same-session unwind) | 2 |
| Quarterly diff-and-trade planner + server route + state | 2 |
| Ledger fields (borrow, dividend-in-lieu) + P&L view | 1.5 |
| Tests, dry-runs, docs | 1.5 |
| **Total** | **10 days** + one paper quarter before the review clock starts |

Matches the earlier feasibility note ((b) ≈ 6 days + the subset of (c)
needed when the hedge is SPY shares rather than micro futures).

## 4. Test plan

1. Unit: shortable gate (each failure mode), hedge sizing for options a/b
   with partial fills, rebalance diff (leave/enter/stay), disaster cap,
   same-session unwind when the hedge fails, slot accounting (6 slots),
   priority below Experimental, label on every event.
2. Replay: run the planner over the 50 historical quarter-ends with the
   F14 inputs and assert the picked names equal the F14 trial's names
   (same code path as research or an exact match test).
3. Bridge dry-run (`DRY`): one quarter-end batch against the paper
   gateway with orders logged, not sent; check tick 236/89 responses and
   SLB fees for the five names.
4. Paper quarter: enable with `INCUBATION_US_HEDGED_SHORT_K5_ENABLED=1`
   for the 31 Dec 2026 batch; success = all five gates evaluated and
   logged, hedge sized to filled notional within 15 minutes of the open,
   no unhedged overnight, ledger lines reconcile to IB statements.
5. Review per the incubation rule at 6 months or 30 closed legs.

## 5. Decisions (2026-10-27)

1. Composite **A** (4/4 windows, t 2.00). B stays recorded and unbuilt.
2. Hedge is beta-scaled SPY, sized to filled short notional.
3. Deviations accepted: no survivor re-weighting; 50% disaster cap; skipped
   names are not replaced. The backtest had no stops.

## 6. When building may start

Not yet. The bridge was down 14 Oct 06:59 SGT until 19 Oct, and again from
22 Oct 16:53 SGT until 25 Oct 19:31 SGT. A clean stretch cannot include those
days. There is no start date until 10 consecutive trading days have actually
passed with no outage after this reliability deploy is the one running.
