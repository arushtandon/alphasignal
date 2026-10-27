# US/JP mean-reversion regime-stabilization preregistration

Frozen: 25 September 2026, before the study run.

## Holdout status

No genuinely untouched 126-session holdout exists. Previous studies consumed
test and validation windows through 24 September 2026, while available market
data extends by at most one newer session. This study reserves the trailing
126-session fold, labels every result `OVERLAP_RISK`, and does not permit live
promotion regardless of its reported metrics.

## Scope

Backtest only: US and Japan, buy side, standalone price-only mean reversion.
The 200-day structural requirement, benchmark/sector tide, next-open entry,
cost model, stop-first convention, trigger, target, stop, time stop, and
partial-exit mechanics are unchanged. No FMP or live production input is used.

The fixed base models are the development-frozen models from the prior
mean-reversion study:

| Cell | Frozen entry/exit model |
|---|---|
| US short | `rsi2_lt_5__prior_close__t3__sl2__full` |
| US medium | `close_below_lower_bb20_2__one_atr__t21__sl2.5__partial` |
| Japan short | `close_below_lower_bb20_2__one_atr__t10__sl2.5__partial` |
| Japan medium | `close_below_lower_bb20_2__one_atr__t21__sl2.5__full` |

## Frozen regime variants

At the signal close, each base model is tested with exactly these benchmark
gates:

1. `baseline`: no additional regime gate.
2. `vol_skip_top20`: skip when 20-session realized benchmark volatility is in
   the highest 20% of its trailing 252-session distribution.
3. `vol_skip_top30`: same, highest 30%.
4. `ma50_flat_or_up`: benchmark 50-day SMA is at least its value ten sessions
   earlier.
5. `vol_skip_top20_and_ma50_flat_or_up`.
6. `vol_skip_top30_and_ma50_flat_or_up`.

No other trigger, exit, lookback, percentile, or slope is tuned after the
result is observed.

## Evaluation

Four date-aligned 504/126/126 folds use existing 20-bar (short) and 63-bar
(medium) embargoes. The last fold is reserved as overlap-risk holdout; folds
1–3 are reported independently, not used to pick a post-hoc variant.

A diagnostic pass requires win rate >=60%, PF >=1.3, positive PnL,
Benjamini-Hochberg MTC, and at least two qualifying development folds.
`FULL` requires n >=30. `THIN` requires n 15–29, exact one-sided binomial
p<0.05 versus 50%, PF >=1.6, positive PnL, and two qualifying development
folds. An overlap-risk diagnostic pass is `CANDIDATE_ONLY_OVERLAP_RISK`, not
promotable.
