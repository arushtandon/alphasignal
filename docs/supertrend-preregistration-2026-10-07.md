# F10 Supertrend — pre-registration

Frozen: 2026-10-07, before the run. Research only. Nothing is enabled.
A pass is a research result. It is not an order and it does not turn a book on.

## Universe

Ever-members of the US, UK, France, and Germany membership files used by
the opportunistic study. A signal requires membership on the signal date.
A name that stops trading during a hold exits at its last close and is kept.
The full sample starts in 2010.

Hedge ETFs, all US-listed: US SPY, UK EWU, France EWQ, Germany EWG.

## Supertrend

Daily bars. ATR is Wilder's smoothed true range. The basic bands are
(high + low) / 2 plus or minus multiplier times ATR. The final upper band
can only fall, or it resets when the prior close is above it. The final
lower band can only rise, or it resets when the prior close is below it.
The trend is bullish when the close finishes above the final upper band,
bearish when it finishes below the final lower band, and otherwise unchanged.

A flip is a change of that state on the signal bar. The order is filled at
the next session's open. The exit of the opposite flip is filled at the
next session's open after that flip bar. One open position per name.

A week is Monday through Friday. The weekly bar uses the first session's
open, the week's high and low, and the last session's close. A weekly flip
is known on that last session. The fill is still the next daily open.

## Variants

Six per market. All 24 are trials.

| Id | Rule |
| --- | --- |
| a | Long when Supertrend(10, 3) flips bullish. Exit when it flips bearish. |
| b | The same with Supertrend(14, 4). |
| c | Variant a, and only when the signal close is above its 200-session average. |
| d | Long when the weekly Supertrend(10, 3) flips bullish. Exit on the weekly bearish flip. |
| e | Short when Supertrend(10, 3) flips bearish, and buy an equal dollar amount of the market ETF. Cover both when the stock flips bullish. |
| f | Variant e, and only when the index's own Supertrend(10, 3) is bearish on the signal bar. |

## Costs

`implementation-cost-v1` on the stock and on the ETF. Borrow is 1% a year,
or 3% a year when the entry price is under $5. A missing market cap does
not by itself trigger 3%. UK stamp duty is charged on a UK stock buy.
Covering a UK short does not pay stamp duty. The US-listed hedge ETFs do
not pay UK stamp duty.

## Scoring

The four windows are the last 504 benchmark sessions in four blocks of 126.
Empty windows are neutral: a window with zero trades is not a failure.
Every window that has trades must be net positive. The full sample needs
at least 40 trades, profit factor at least 1.2, and a t-stat of at least 3
on the per-trade excess return.

A long's excess is the stock's return minus the index return over the same
sessions. A short's excess is the hedged spread. Deflated Sharpe is
computed once over all 24 trials. It is reported. It is not an additional
pass gate.

Also report a per-year table from 2010 through 2026, the book's return in
the top-decile months of that market's benchmark, the ten worst trades,
and the trades in NKE, SBUX, META during 2021-2023, INTC, and VOW3.DE.
Those tables are not a pass gate.
