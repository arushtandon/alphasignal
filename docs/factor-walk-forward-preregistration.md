# Advanced factor walk-forward preregistration

This document freezes the research design before the advanced-factor result set
is generated. Production recommendation and execution rules are out of scope.

## Cells and data

- Cells: seven geographies × short/medium/long × buy/sell (42 total).
- Geographies: US, Hong Kong, Japan, UK, Germany, France, commodities.
- Price source: historical Yahoo OHLCV only; current fundamentals are excluded.
- Entry: next daily open after a signal. Same-bar ambiguity is stop-first.
- Trades do not overlap for the same symbol and strategy.
- Costs include commission, spread, slippage, FX/tax and short borrow.
- Static current constituents create survivorship bias and are disclosed.

## Frozen factors

1. Trailing point-in-time expectancy: only trades closed before the signal.
2. Cross-sectional relative-strength percentile over 20/60/120 bars.
3. Geography breadth: percentages above MA50 and MA200.
4. ADX and ATR-percentile volatility regime.
5. Breakout retest confirmation before entry.
6. Maximum normalized distance from MA20/MA50.
7. Gap, rolling dollar-volume and OHLC spread proxies.
8. Geography-specific selection.
9. Commodity proxies: Brent-WTI relative movement, CL/USO and BZ/BNO
   relative movement, DBC trend, volume/volatility shock and Wednesday
   inventory-release timing risk. These are not actual inventory surprises or
   a verified futures curve.
10. Hierarchical Bayesian win-rate shrinkage.

All indicators at index `i` may read bars `<= i` only.

## Frozen candidate registry

The search is capped at 26 entry models:

- Baseline.
- Ten single-factor overlays.
- Fifteen combinations: quality core; standalone trend; standalone retest;
  execution quality; standalone mean reversion; RS+breadth; RS+expectancy;
  expectancy+execution; expectancy+retest; trend+retest;
  RS+trend+execution; breadth+trend+execution; conservative all-quality;
  standalone commodity proxy; commodity regime+expectancy.

The baseline and single-factor models retain the current breakout entry.
The four explicitly named standalone models use their trend, confirmed-retest,
low-ADX mean-reversion, or commodity-proxy entry independently of that
breakout. This keeps the registry at 26 while testing both overlays and
standalone strategies.

Cross-sectional RS thresholds are limited to top/bottom 10%, 15% and 20%.
Exit selection is a separate three-profile choice per horizon: tight
single-target, balanced TP1/runner, and wide single-target. No post-result
factor subsets or continuous threshold search is permitted.

## Walk-forward protocol

- Four date-aligned rolling folds.
- Training: 504 bars; validation: 126 bars.
- Embargo between validation and test equals the horizon maximum hold
  (20/63/180 bars).
- Test: 126 bars.
- The first three folds are development OOS folds. Their results may choose one
  frozen model/exit profile for the fourth and final untouched holdout.
- Pooled model-comparison and cross-market reports are diagnostics only and
  cannot feed selection.

## Selection and promotion

Validation candidates must have positive net PnL and average return, PF >= 1.3,
and a positive Bayesian conservative win-rate bound. Ranking penalizes factor
count and small samples.

Promotion is decided separately for each of the 42 cells and requires:

- observed win rate >= 65% (65–70% is the target);
- raw costed PF >= 1.3;
- positive average return and PnL;
- at least 30 development OOS trades and 30 final-holdout trades;
- positive/PF-qualified performance in at least two development folds;
- final holdout pass;
- multiplicity-adjusted reporting across all cells.

A cell that fails any condition remains unsupported/paused. Thresholds will not
be relaxed after results are observed.
