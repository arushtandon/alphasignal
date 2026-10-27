# Mean-reversion win-rate study preregistration

Date frozen: 25 September 2026

## Scope and non-production guardrail

This is a backtest-only study. It neither changes the production recommendation
engine nor changes current brackets or the paused medium/long sell books.

It tests a parallel long-only mean-reversion book at short and medium horizons
in the US, Hong Kong, Japan, UK, Germany, France, and commodities. The live
trend-long exit experiment is a diagnostic-only separate section.

## Data and execution assumptions

- Daily Yahoo OHLCV, up to 80 sufficiently long-history names per geography.
- Benchmark tide: SPY, EWH, EWJ, EWU, EWG, EWQ, and DBC respectively.
- Sector tide: the same sector proxy used by the existing research harness,
  falling back to the geography benchmark.
- Entry: next daily open after the signal.
- Costs and borrow: existing research cost model, $10,000 fixed notional.
- Same-bar stop/target conflict: stop first.
- Same-symbol positions cannot overlap.
- Four date-aligned walk-forward folds: 504 train, 126 validation, 126 test.
- Embargo: 20 bars for short and 63 for medium.
- First three folds select the candidate; the final fold is untouched holdout.

## Common mean-reversion structural gates

Every candidate must meet all of the following at the signal close:

1. Close is above its 200-day SMA.
2. Benchmark is not in a confirmed downtrend according to the existing live
   market-tide map.
3. Sector proxy is not below its own 200-day SMA with a declining 50-day SMA.
4. A valid next-open entry, 14-day ATR, and positive target distance exist.

## Frozen candidate registry

All candidates are buy-only. Each trigger is combined with every listed exit
parameter, creating 108 short candidates and 72 medium candidates:

- Trigger: `rsi2_lt_5`, `close_below_lower_bb20_2`, or
  `williams_r10_lt_minus_95`.
- Fast target: previous close, entry plus one ATR, or 20-day SMA touch.
- Protective stop: 2.0 or 2.5 ATR below entry.
- Short time stop: 3, 5, or 10 bars.
- Medium time stop: 10 or 21 bars.
- Realisation: all-at-fast-target, or 50% at fast target and 50% runner to
  entry plus 2 ATR with stop moved to breakeven after TP1.

This cross-product is fixed before any outcome is inspected. A trigger whose
target is not above the next open is ineligible rather than being adjusted.

## Selection and promotion

Within each development validation fold, candidates are ranked by win rate,
then profit factor, then net PnL, but only after passing validation PF >= 1.3
and positive PnL. The plurality winner across development folds is frozen for
the final holdout.

A cell passes only when:

- development and holdout each contain at least 30 trades;
- holdout win rate is at least 60% (65% remains the target);
- holdout PF is at least 1.3;
- holdout net PnL is positive;
- at least two development test folds also have win rate >= 60%, PF >= 1.3,
  and positive PnL;
- the result survives Benjamini-Hochberg multiple-testing control across all
  14 geography × horizon mean-reversion cells.

Cells with high win rate but PF below 1.3 are explicitly reported as rejected
bleeding strategies.

## FMP gate for Part C

Estimate revision momentum may be tested only when the provider supplies
historical observations with a publication/revision timestamp, allowing each
signal date to use only already-known estimates. Current-only fundamental
scores, current analyst consensus, or undated forecast-period rows are not
point-in-time eligible. Earnings surprise dates and actual-versus-estimated EPS
may support post-earnings drift only when the report date is present.

## Live trend-long exit diagnostic

For US, Japan, and France medium/long buys only, retain the exact production
entry decision and vary just exits:

1. Current hybrid exit baseline.
2. 50% TP1 / 50% runner, using the existing TP1 partial mechanics.
3. MAE/MFE calibrated protective stop and target derived solely from each
   development fold.

The diagnostic reports win-rate, PF, PnL, average win, average loss, and PnL
retention versus baseline. It cannot change production. A candidate is
reportable only when the relevant price-only replay has point-in-time entry
inputs and meets the same holdout sample, PF, and PnL safeguards.

The approved maximum deterioration in holdout net PnL is 10% versus the current
exit baseline. This threshold was selected before the exit diagnostic run.
