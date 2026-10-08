# F11 Supertrend combinations — pre-registration (replacement)

Frozen before any trial of this design is scored. Research only. Nothing
is enabled, and no order is sent.

This replaces the 2026-10-07 design (`30eb91406e66b4b8be9afbd15ad426fdc5330d7e`).
That design was long-only and used one Supertrend setting. Its freeze is
void for this study. Stage 2 of this design does not run until there is an
explicit go-ahead after the new freeze.

## Universe

Stage 1: US ever-members. A name can signal only on a date when it was a
member. Signals from 2010-01-01 through 2019-12-31 only. No bar dated after
2019-12-31 is loaded into a Stage 1 series. Indicators are computed on that
cut series.

The US 2010-2013 caveat is reported with Stage 1 and is not a pass gate:
the membership file is mostly Nasdaq-100 in those years.

Stage 2, only after the freeze and an explicit go-ahead, on the frozen
rules with no threshold, filter, or exit change:

- US ever-members, signals from 2020-01-01 through the run date
- UK, France, and Germany ever-members, signals from 2010-01-01 through
  the run date, membership required on the signal date

One open position per name, per base, per side. A later signal whose entry
is not after the open trade's exit is skipped.

## Supertrend

ATR is Wilder's smoothed true range. The basic bands are (high + low) / 2
plus or minus multiplier times ATR. The final upper band can only fall, or
it resets when the prior close is above it. The final lower band can only
rise, or it resets when the prior close is below it. The trend is bullish
when the close finishes above the final upper band, bearish when it finishes
below the final lower band, and otherwise unchanged.

A flip is a change of that state on the signal bar. The order is filled at
the next session's open.

A week is Monday through Friday UTC. The weekly bar uses the first session's
open, the week's high and low, and the last session's close. A weekly flip
is known on that last session. The fill is the next daily open. A weekly
reading is available to a daily bar only from the last week whose last
session is on or before that bar.

## Bases

These are the live engine settings. Each base is long on a bull flip and
short on a bear flip.

| Base | Signal | Max hold |
| --- | --- | --- |
| SHORT | daily Supertrend(7, 2) | 10 sessions |
| MEDIUM | daily Supertrend(10, 3) | 63 sessions |
| LONG | daily Supertrend(14, 4) | 126 sessions |
| WEEKLY | weekly Supertrend(10, 3) | 126 sessions |

WEEKLY is the second LONG base. The entry session is session 1. A trade
still open on session N exits at that session's close. A trade still open
on the last loaded bar exits at that bar's close and is kept.

## Sides and excess

Long excess is the stock return minus the index return over the same
sessions. Short excess is the short stock return plus the long return of an
equal dollar amount of the market ETF. The Stage 1 index is SPY. Stage 2
uses SPY, EWU, EWQ, and EWG.

The fill clock matches. The entry session is close/open for the stock and
for the index. A later session that is held to the close is close-to-close
for both. An exit filled at the next open is the overnight move to that
open for both. A stop exit fills the stock at the stop, or at the open when
the open is already through the stop. That session's index leg is
close-to-close, because the daily index bar has no intraday stop price.

A short pays borrow on the stock: 1% a year, or 3% a year when the entry
price is under $5. A missing market cap does not by itself trigger 3%.
Borrow is `rate / 252` times the number of sessions held, subtracted from
the short spread. Borrow applies in Stage 1 and Stage 2.

Stage 1 does not charge commission, spread, slippage, or stamp. Stage 2
charges `implementation-cost-v1` on the stock and on the hedge ETF. UK
stamp is charged on a UK stock buy. Covering a UK short does not pay stamp.
The US-listed hedge ETFs do not pay UK stamp.

## Filters

Each filter is true or false on the signal bar. None of them read a later
bar. The short column is the mirror. F5 and F8 are the same on both sides.

| Id | Long | Short |
| --- | --- | --- |
| F1 | close > MA200 | close < MA200 |
| F2 | MA50 > MA200 | MA50 < MA200 |
| F3 | index close > its MA200 | index close < its MA200 |
| F4 | index Supertrend bullish, same setting as the base | index Supertrend bearish, same setting |
| F5 | ADX(14) > 25 | ADX(14) > 25 |
| F6 | MACD line > signal line | MACD line < signal line |
| F7 | RSI(14) from 50 to 70 inclusive | RSI(14) from 30 to 50 inclusive |
| F8 | flip-bar volume > 1.5 times its prior 20-session average | same |
| F9 | 6-month return minus the index is in the top 30% of members that can be scored that day | the same excess is in the bottom 30% |
| F10 | the next-higher Supertrend agrees | the next-higher Supertrend agrees, on the short side |
| F11 | close equals the highest close of the last 55 sessions, including the signal bar | close equals the lowest close of those 55 sessions |
| F12 | close is within 1 ATR of the Supertrend line, on the trade's side of the line | same, on the short side of the line |

MA200, MA50, ADX(14), MACD(12, 26, 9), and RSI(14) are daily, including
for the weekly base, and they are read on the signal session. Six months
is 126 sessions. F8's average is the 20 sessions before the signal bar and
does not include it. A bar with no volume field is F8 false. No second
price source is queried to fill volume.

F4 uses the base's own Supertrend on the index: daily (7, 2), (10, 3),
or (14, 4), or weekly (10, 3) for the weekly base.

F10, long agrees when that Supertrend is bullish and short agrees when it
is bearish:

- SHORT uses daily Supertrend(10, 3)
- MEDIUM uses daily Supertrend(14, 4)
- LONG uses weekly Supertrend(10, 3)
- WEEKLY uses daily Supertrend(14, 4)

F12's ATR is the Wilder ATR of the Supertrend that created the signal.

## Exits

- X1: the opposite flip, filled at the next open, or the max-hold close if
  that comes first.
- X2: a trailing stop 3 ATR under the best close for a long, or 3 ATR over
  the best close for a short. The ATR is the signal Supertrend's Wilder ATR.
  For a weekly base the ATR is the last completed week's ATR(10). The stop
  checked on session t uses the ATR from session t-1 and the best close
  through session t-1. The best close is a daily close. The max hold still
  applies.

## Stage 1

Discovery only.

a) One table. For each of the 4 bases and both sides, each filter true and
false, on both exits: trades, mean per-trade excess, win percent, and
profit factor.

b) Every single filter and every pair. That is 12 + 66 = 78 filter sets,
times 4 bases, times 2 sides, times 2 exits = 1,248 rows. Every row is
scored. The report states how many rows were actually scored. A row reports
trades, per-trade excess t, profit factor, win percent, and a per-year
table. The minimums below are the freeze gate, not a reason to skip a row.

Minimum trades: SHORT 300, MEDIUM 150, LONG and WEEKLY 100.

Per-trade excess t is the t-statistic of the trade excesses. Win percent is
the share of trades with positive excess. Profit factor is gross positive
excess over gross absolute negative excess.

Deflated Sharpe uses `deflatedSharpe` in `lib/research/strategy-gaps.js`
on the monthly compounded excess of the scored trial with the highest
excess t, against the Sharpe of every scored trial.

c) Freeze the top 3 by excess t inside each horizon and side. The horizons
are SHORT, MEDIUM, and LONG. LONG contains both the daily (14, 4) base and
the weekly (10, 3) base, so those two bases compete for the same three LONG
slots on each side. A row must also have profit factor at least 1.2 and at
least the horizon's minimum trades. If fewer than 3 qualify, freeze only
those that do. Write them to `docs/supertrend-combo-frozen-2026-10-07.md`
and commit that file before Stage 2.

## Stage 2

Not part of the Stage 1 run. After an explicit go-ahead, the frozen rules
are applied unchanged.

Costs and stamp duty are as specified above. A market passes only when all
of these hold:

- at least 40 trades
- profit factor at least 1.2
- per-trade excess t at least 2.5
- every window that contains trades has positive net excess; a window with
  no trades is neutral

Windows are the date-aligned folds from the F8 study: `FOLD_SPEC` and the
horizon embargo in `lib/research/consistency-study.js` (short 20, medium 63,
long 180). The weekly base uses the long embargo.

A rule that passes US validation and at least one of UK, France, or Germany
is recorded for signals-only forward tracking. It is not turned on.
