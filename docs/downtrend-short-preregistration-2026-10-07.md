# F8 downtrend short — pre-registration

Frozen: 2026-10-07, before the run. Research only. Nothing is enabled.
The paper books and the 2 November momentum run are not changed.

## Universe

Markets with dated membership: US (`data/research/fmp/us-universe.json`),
UK (`data/research/index-membership/ftse100.json`), France
(`data/research/index-membership/cac40.json`).

Candidates are every symbol that was a member on any replayed date, not
`currentSymbols` alone. A signal still requires membership on the signal
date. A name that stops trading during the hold exits at its last close
and is kept. A name with no bar on the entry date never opened.

## Signal

Month-end close. Enter at the next session open.

All of the following:

- Close is within 5% of the 52-week low. The low is the minimum low over
  the prior 252 sessions, including the signal session. Within 5% means
  the close is less than or equal to 1.05 times that low.
- The 12-1 return (close now versus close 252 sessions ago, skipping the
  most recent 21) is in the bottom decile of members with a finite 12-1
  that day. Decile width is floor(n / 10). Fewer than 10 ranked members
  produces no signal.
- Close is below its 200-session average.
- That 200-session average is below its own value 21 sessions earlier.

Skip a name with a report date in the earnings cache on one of the next
5 sessions. UK and France have no report-date files. Those names are not
dropped and the skip is not filled with US dates. The count is reported.

## Variants

Six. No seventh is added.

| Id | Book | Cover |
| --- | --- | --- |
| a | Naked short | 63 sessions |
| b | Naked short | close above MA50, or 63 sessions |
| c | Short the stock and long an equal dollar amount of the market ETF (US SPY, UK EWU, France EWQ) | 63 sessions |
| d | Same hedge as c | close above MA50, or 63 sessions |
| e | Short the stock and long an equal dollar amount of the stock's SPDR sector ETF. US only | 63 sessions |
| f | Same hedge as c, but the 12-1 cut is the bottom 5% instead of the bottom decile | 63 sessions |

Sector ETFs are the current FMP sector mapped to XLK, XLF, XLV, XLY, XLP,
XLE, XLI, XLB, XLRE, XLU, XLC. A US name with no sector label is not given
a sector hedge and is left out of variant e. No other ETF is substituted.
Variant e is not run for the UK or France.

Naked books report the stock-short return. Hedged books report the spread
(stock short plus ETF long) as the monthly return.

## Costs

`implementation-cost-v1` on the stock and on the ETF leg. Borrow is 1% a
year (`sessions × 0.01 / 252`). Borrow is 3% a year when the entry price
is under $5 or a current profile market cap is under $2 billion. A missing
market cap does not by itself trigger 3%. UK stamp duty is charged on a
UK-listed purchase. EWU and EWQ are US-listed, so the hedge buy does not
pay UK stamp duty. Covering a UK short does not pay stamp duty.

## Scoring

The four test windows are the same constructor as the strategy-gaps study:
the last 504 benchmark sessions, in four blocks of 126. The full sample is
the whole monthly path from the first eligible signal, not only those four
blocks.

Pass requires every window profitable, profit factor at least 1.2, at
least one trade in the window, a positive full-sample return, and a t-stat
of at least 3. Naked books take that t-stat on monthly excess return
(book minus the return of shorting the benchmark over the same month),
via `tBasis: 'excess'`. Hedged books take it on the spread series. The
existing candidate rule (positive full sample that beats the benchmark,
and at least 3 of 4 windows) still applies and is not a pass.

Deflated Sharpe is reported for the family and is not a pass gate. No
probability cutoff was specified.

Trials are every research cell plus the executable k=1, k=2, and k=5
books. Research cells are a, b, c, d, and f in each of the three markets,
plus e in the US only: 16. Each of those has three executable books: 48.
The family size is 64, unless a cell is a data gap, in which case it is
not a trial. Executable books are the top k new shorts that month, $30,000
a leg, real lot sizing, same hold as the variant. They use the same pass
rule and they enter `nTrials`.

Separately, report the book's return in rebound months, defined as the
top decile of SPY calendar months by SPY's own monthly return, and the
max drawdown. This rebound table is not a pass gate.

## Sanity check

Report every month the rule shorted NKE, SBUX, MCD, GFS, and NVO, and the
side and variant. List the five shorts with the largest positive stock
rebounds (the worst shorts).
