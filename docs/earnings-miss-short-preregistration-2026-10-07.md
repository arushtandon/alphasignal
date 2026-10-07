# F9 — earnings-miss short — pre-registration

Frozen: 2026-10-07, before any F9 backtest. Research only. US only.
This file is the commitment. The data check and any backtest come after this
commit. A pass is signals-only forward tracking. It does not place orders
and it does not enable a book.

## Data check, before any trial

The trigger needs, on each historical report date, `epsActual` and
`epsEstimated`, and for variant f also revenue actual and revenue estimate.
The existing earnings cache stores announcement dates only. That cache is
not a substitute.

If Financial Modeling Prep does not return those fields on a historical
report date, the study stops. Coverage is reported by year. A missing field
is a data gap. No proxy, no date-only run, no other vendor.

## Universe

US ever-members. Point-in-time membership on the report date. No other market.

## Trigger

Report date `d0` is a trial only when all of the following are true:

- EPS actual is below the EPS estimate on that report.
- The reaction from close(`d0−1`) to close(`d0+1`), minus the SPY return over
  the same two sessions, is −5% or worse.
- The stock close is below its own 200-session average, and that average is
  below its value 21 sessions earlier.
- SPY's close is above SPY's own 200-session average. The weakness has to be
  the stock, not the market.

Entry is the open on `d0+2`.

## Variants

Six variants. All six are trials.

| Id | Position | Exit |
| --- | --- | --- |
| a | Naked short | 63 sessions |
| b | Short the stock and long an equal dollar amount of SPY | 63 sessions |
| c | Same SPY hedge as b | Cover when the stock close is back above its 50-session average, or 63 sessions |
| d | Same SPY hedge as b, and the previous report was also an EPS miss | 63 sessions |
| e | Short the stock and long an equal dollar amount of the sector SPDR | 63 sessions |
| f | Same SPY hedge as b, and revenue actual is below the revenue estimate | 63 sessions |

Sector map for e: Technology XLK, Financial Services XLF, Healthcare XLV,
Consumer Cyclical XLY, Consumer Defensive XLP, Energy XLE, Industrials XLI,
Basic Materials XLB, Real Estate XLRE, Utilities XLU, Communication Services
XLC. A name with no sector label is left out of e. It is not assigned a
stand-in ETF.

## Costs and borrow

Same as the opportunistic study (`implementation-cost-v1`). Borrow is 1% a
year, or 3% a year when the entry price is under $5. A missing market cap
does not by itself trigger 3%. US-listed hedge ETFs do not pay UK stamp.

## Scoring

Same as the opportunistic study. The four windows are the last 504 SPY
sessions in four blocks of 126. The empty-window switch is neutral: a window
with zero trades is not a failure, and every window that has trades must be
net positive. A pass needs at least 40 trades, profit factor at least 1.2,
and a t-stat of at least 3 on the per-trade excess return. There is no
candidate rule.

Naked excess is the stock-short return minus the return of shorting SPY over
the same sessions. Hedged excess is the spread.

Deflated Sharpe is reported over the six variants and is not a pass gate.

Also report a per-year table, the book's return in the top-decile months of
SPY (rebound months), the ten worst trades, and every trade in the sanity
names used by the opportunistic study: NKE, SBUX, MCD, GFS, META, INTC.

## What a pass means

A passing cell is logged for signals-only forward tracking. It is not sent
to the order bridge and it is not added to the paper book.
