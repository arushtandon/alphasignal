# F11 Supertrend combinations — pre-registration

Research only. Nothing in this study is enabled, and no order is sent.
Stage 2 does not run until there is an explicit go-ahead after Stage 1 is frozen.

Both stages are specified here, before any combination is scored.

## Universe and sample

- Long only. Short Supertrend flips are out. They have already failed six times.
- One open position per name.
- Stage 1 discovery: US ever-members. A signal is eligible only when its bar
  date is from 2010-01-01 through 2019-12-31. No bar dated after 2019-12-31
  is loaded into a Stage 1 series. Indicators are computed on that cut series.
- Stage 2, only after the freeze and an explicit go-ahead, and only on the
  five frozen rules with no threshold or filter change:
  - US ever-members, signals from 2020-01-01 through the run date
  - UK, France, and Germany ever-members, signals from 2010-01-01 through the run date
- US 2010-2013 caveat, reported with Stage 1 and not used as a pass gate:
  the US ever-member file is mostly Nasdaq-100 in those years.

## Base signals

Enter at the next session's open.

- B1: daily Supertrend(10, 3) flips from bearish to bullish.
- B2: weekly Supertrend(10, 3) flips from bearish to bullish.

Supertrend is the causal Wilder construction already frozen for F10.
A week is Monday–Friday UTC. The weekly bar uses the first open, the week
high and low, and the last close. The flip is known on that last session.
The fill is the next daily open. A weekly reading is available to a daily
signal only from the last completed week on or before that signal bar.

A trade still open on the last loaded bar exits at that bar's close.
Stage 1 loads no bar after 2019-12-31, so that is the boundary.

The X2 stop checked on session t is 3 times Wilder ATR(10) from session t-1,
below the highest close through session t-1. The entry session is session 1.
If the stop is not hit, the trade exits at the close of session 63.

A priced ever-member can signal on any date in the window. Membership is
not re-checked each day. That is the same ever-member set as F10. The
2010-2013 Nasdaq-100 caveat is reported with the results.

## Filters

Each filter is true or false on the signal bar. None of them read a later bar.

- F1: close > MA200
- F2: MA50 > MA200
- F3: index close > the index MA200
- F4: index Supertrend(10, 3) is bullish
- F5: ADX(14) > 25
- F6: MACD line > MACD signal line
- F7: RSI(14) is between 50 and 70, inclusive
- F8: flip-day volume > 1.5 times its own prior 20-session average
- F9: six-month return minus the index is in the top 30% of members that can be scored that day
- F10: for B1, the weekly Supertrend(10, 3) is bullish; for B2, the daily Supertrend(10, 3) is bullish
- F11: close equals the highest close of the last 55 sessions, including the signal bar
- F12: close is within 1 ATR of the Supertrend line on the bullish side of it

ATR in F12 is Wilder ATR(10), the same period as the Supertrend.

## Exits

- X1: the opposite Supertrend flip. The fill is the next session open.
- X2: a trailing stop 3 ATR below the highest close since entry, and a
  maximum hold of 63 sessions. A session whose low trades through the stop
  fills at the stop, or at the open when the open is already through it.
  A trade still open on session 63 fills at that session's close.

The index leg uses the same fill clock as the stock. When the stock's last
fill is an open, the index leg for that session is the overnight move to the
index open, not the index close.

## Costs and score

Stage 1 and Stage 2 both charge `implementation-cost-v1` on the stock and on
the index ETF, with the F8 stamp and borrow rules. Borrow is 1% a year, or
3% a year when the entry price is under $5. A missing market cap does not
by itself trigger 3%. UK stamp is charged on a UK stock buy. The US-listed
hedge ETFs (SPY, EWU, EWQ, EWG) do not pay UK stamp. Stage 1 has no UK names.

Excess is the stock's net return minus the index ETF's net return over the
same fill clock. Per-trade excess t is the t-statistic of those trade excesses.
Win percent is the share of trades with positive excess. Profit factor is
gross positive excess over gross absolute negative excess.

## Stage 1

Discovery only. US ever-members, signal dates 2010-01-01 through 2019-12-31.

a) One table. For B1 and for B2, each filter true and false: trades, mean
per-trade excess versus the index, win percent, and profit factor.

b) Every single filter and every pair. That is 12 singles plus 66 pairs =
78 filter sets, times 2 bases, times 2 exits = 312 trials. A trial reports
trades, per-trade excess t, profit factor, and a per-year table. The minimum
sample used later is 100 trades. Deflated Sharpe is reported on the 312
trial Sharpes, using `deflatedSharpe` in `lib/research/strategy-gaps.js`,
on the monthly excess of the trial with the highest excess t.

c) Freeze the top 5 trials by excess t among those with at least 100 trades
and profit factor at least 1.2. Write them, unchanged, to
`docs/supertrend-combo-frozen-2026-10-07.md` and commit that file before
Stage 2. If fewer than 5 trials qualify, freeze only those that qualify.

## Stage 2

Not part of the Stage 1 run. After an explicit go-ahead, the frozen rules
are applied unchanged.

Markets: US from 2020-01-01 to the run date, and UK, France, and Germany
from 2010-01-01 to the run date. Ever-member universes. Costs and stamp
duty as above.

A market passes only when all of these hold:

- at least 40 trades
- profit factor at least 1.2
- per-trade excess t at least 2.5
- every window that contains trades is positive; a window with no trades is neutral

Windows are the same date-aligned folds used for F8. A rule that passes the
US validation and at least one of UK, France, or Germany is recorded for
signals-only forward tracking. It is not turned on for orders by this study.
