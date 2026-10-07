# F8 opportunistic single-stock trend — pre-registration

Frozen: 2026-10-07, before the run. Research only. Nothing is enabled.
This is not the monthly downtrend-short study. The rules below are the
ones that are frozen. Germany and Hong Kong, once their dated membership
files exist, use these same rules with no change.

## Universe

US, UK, and France now, from the same dated files as the monthly study.
Candidates are every ever-member. A signal requires membership on the
signal date. A name that stops trading during a hold exits at its last
close and is kept.

Germany is added only if `data/research/index-membership/dax.json` has
dated changes and `.DE` prices. Hong Kong is added only if
`data/research/index-membership/hsi.json` has dated changes and `.HK`
prices. A missing file is a data gap. A current constituent list is not
substituted.

## Signal

Daily scan. Enter at the next session open.

Short trigger, all of the following:

- Close is below its 200-session average.
- That average is below its value 21 sessions earlier.
- The close is a new 52-week closing low (the lowest close of the prior
  252 sessions, including the signal session).
- The stock's 126-session return minus the index's 126-session return is
  in the bottom 20% of members with a finite value that day.

## Variants

Six. All are trials. No seventh is added.

| Id | Book | Exit |
| --- | --- | --- |
| a | Naked short | close above MA50, or 126 sessions |
| b | Naked short | trailing stop 3 ATR above the lowest close since entry, or 126 sessions |
| c | Short the stock and long an equal dollar amount of the market ETF (US SPY, UK EWU, France EWQ, Germany EWG, Hong Kong EWH) | same as a |
| d | Same hedge as c | same as b |
| e | Same hedge as c, and only when the index itself is below its MA200 | same as a |
| f | The short in a, plus a later long in the same name | Short covers as a. The long starts after the trend repairs: close above MA200, MA200 rising versus 21 sessions earlier, a new 52-week closing high, and 126-session relative strength in the top 20% of members. The long sells on a close below MA200. |

## Costs

`implementation-cost-v1` on the stock and on the ETF. Borrow is 1% a year,
or 3% a year when the entry price is under $5 or a current profile market
cap is under $2 billion. A missing market cap does not by itself trigger
3%. UK stamp duty is charged on the long leg in variant f. Covering a UK
short does not pay stamp duty. US-listed hedge ETFs do not pay UK stamp
duty.

## Scoring

The four windows are the last 504 benchmark sessions in four blocks of
126. The full sample starts in 2010.

This study sets the empty-window switch to neutral. A window with zero
trades is not a failure. Every window that has trades must be net
positive. The full sample needs at least 40 trades, profit factor at
least 1.2, and a t-stat of at least 3 on the per-trade excess return.
Naked excess is the stock-short return minus the return of shorting the
index over the same sessions. Hedged excess is the spread. Variant f
scores the short and the later long as separate trades; the long's excess
is the stock return minus the index return over the same sessions.

There is no candidate rule. A cell passes or it fails.

Deflated Sharpe is reported over the six variants in each market and is
not a pass gate.

Also report a per-year table from 2010 through 2026, the maximum number
of concurrent positions, the ten worst trades, and the book's return
during the top-decile months of that market's benchmark. Those tables are
not a pass gate.

## Sanity check

Report every trade the rule took in NKE, SBUX, MCD, GFS, META during
2021-2023, INTC, and VOW3.DE once Germany is in the study.
