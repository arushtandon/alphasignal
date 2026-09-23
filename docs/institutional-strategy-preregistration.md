# US/UK institutional-style strategy preregistration

Status: research specification only. No strategy may be promoted from the
static-universe Yahoo replay in `scripts/institutional-style-3y-backtest.js`.

## Frozen test window and universe

- Window: 2023-09-18 through 2026-09-18.
- Point-in-time S&P 500 and FTSE 350 membership, including delisted securities.
- Exclude prices below USD/GBP 5 and securities outside each market's top 200
  by trailing 60-session traded value.
- Use split/dividend-adjusted prices and total-return market benchmarks.
- Enter at the next session open; include spreads, slippage, commissions,
  0.5% UK SDRT on the purchase leg, FX costs, and historical short borrow.

The required point-in-time constituent, delisting, borrow, and liquidity data
is not currently present in this repository.

## Short horizon: five-session relative reversal

- Weekly signal:
  `relative5 = stock log return(5) - market log return(5)`.
- Buy the bottom quintile and short the top quintile within US and UK separately.
- Equal-notional long/short books; enter next open and hold five sessions.
- Catastrophe stop at 2 × ATR(20), with adverse gap and stop-first handling.

## Medium horizon: 12–1 cross-sectional momentum

- Month-end signal: `log(price[t-21] / price[t-252])`.
- Buy the top quintile and short the bottom quintile.
- Hold 63 sessions using three overlapping monthly vintages.
- Inverse 20-session volatility weights, capped at 2% portfolio risk per name.

## Long horizon: 12-month time-series trend

- Monthly direction: sign of `log(price[t] / price[t-252])`.
- Buy only above SMA(200); short only below SMA(200); otherwise cash.
- Exit at the first monthly reversal or after 252 sessions.
- Inverse-volatility weights with equal gross US and UK allocation.

## Promotion criteria fixed before testing

Every condition must pass after costs:

- Annualized Sharpe at least 1.2.
- Profit factor at least 1.5.
- Maximum drawdown no greater than 10%.
- Positive net return in US, UK, long, and short legs separately.
- At least 50 completed positions per side and 30 rebalance dates.
- 90% stationary-block-bootstrap confidence interval for combined mean daily
  excess return entirely above zero.

Thresholds may not be tuned after observing the result. Failure means rejection.

## Public research basis

- AQR, *A Century of Evidence on Trend-Following Investing*.
- AQR, *Value and Momentum Everywhere*.
- AQR Momentum Index methodology.
- Man AHL public trend-following research.

These are simplified public strategy families, not copies of any manager's
proprietary model and not evidence of “top 0.01%” performance.
