# Omitted-geography rescue rerun preregistration

Frozen: 25 September 2026, before the corrected rerun.

## Correction and scope

This rerun uses the standalone, price-only mean-reversion (MR) entry from
`backtest-mean-reversion-winrate.js`: 200-day structural gate; benchmark and
sector tide gates; RSI(2), lower-Bollinger, or Williams %R trigger; next-open
entry; ATR stop/target/time exits; and the existing research cost model.

It does **not** use `backtestSignal`, production scores, FMP quality, current
fundamentals, or any live recommendation logic. It is buy-only and covers the
same standalone-MR horizons as the prior MR study: short and medium. No
long-horizon MR model is invented in this rerun.

## Holdout status

No clean 126-session holdout exists: previous studies consumed test and
validation windows through 24 September 2026, while current data has at most
one later session. This rerun therefore reserves the most recent 126-session
fold as holdout, but labels every result `OVERLAP_RISK` and makes no model
promotable regardless of metrics. The result remains useful as a corrected,
price-only diagnostic only.

## Eligible cells and data constraints

- France: CAC 40 only. SBF 120 is `BLOCKED_ON_DATED_CONSTITUENTS`; a current
  member list cannot be used for historical signals.
- Germany: DAX only. HDAX is `BLOCKED_ON_DATED_CONSTITUENTS`.
- Commodities: existing symbols plus the listed liquid continuous contracts and
  ETFs in the result JSON.
- UK short and HK short: standalone MR baseline and standalone MR plus a
  top-decile trailing-20-session dollar-volume filter.
- All price-only cells use the frozen 108 short / 72 medium MR candidate grid
  from `docs/mean-reversion-winrate-preregistration.md`.
- HK Southbound/A-H, UK overseas revenue/GBP, and earnings overlays are
  deferred: they require external point-in-time data and are out of scope.

## Diagnostic gates

Metrics and safeguards are unchanged: win rate >=60%, PF >=1.3, positive PnL,
Benjamini-Hochberg control, and at least two qualifying development folds.
`FULL` requires holdout n >=30. `THIN` requires n 15–29, exact one-sided
binomial p<0.05, PF >=1.6, positive PnL, and two qualifying development folds.

Because the holdout is overlap-risk, passing metrics are reported as
`CANDIDATE_ONLY_OVERLAP_RISK`, never `PROMOTABLE`.
