# Strategy gaps — pre-registration

Frozen: 2026-10-06, before any backtest in this study. Research only.
Nothing in this study is enabled, and the bridge is not modified.

The question is which empty market × horizon × side cells have a rule that
survives the pass rule below. A missing input is reported as a data gap.
It is not replaced with a current constituent list, a continuous contract,
an ETF, or a market return standing in for an industry.

## Sample and windows

Evaluation starts at the later of 2010-01-01 and that market's dated
membership start, after the lookback warmup. US dated membership starts
2014-01-23 (`data/research/fmp/us-universe.json`). UK uses
`data/research/index-membership/ftse100.json`. France uses
`data/research/index-membership/cac40.json`. A market with no dated
membership file is not run.

The four windows are the four test slices from
`buildDateAlignedFolds` with the consistency-study fold spec: 4 folds,
504 train bars, 126 validation bars, 126 test bars. Embargo is 20 bars
for a hold of 10 sessions or less, 63 bars for a hold up to one month,
and 180 bars for a hold of about six months. Window dates are taken from
the family's benchmark calendar and printed in the readout.

The full sample is the whole path from the first eligible signal through
the last bar, not only the four test slices. Window return and maximum
drawdown use the book's equity curve inside that window. Profit factor
and win rate use the trades whose exit date falls in the window.

## Pass rule

A variant PASSes only when all of the following are true:

- All four windows have a positive book return, profit factor at least 1.2,
  and at least one trade. A window with no losing trades and a positive
  sum of gains has infinite profit factor and clears 1.2. A window with
  no trades fails.
- The full-sample book return is positive and greater than the benchmark
  over the same dates. Benchmarks are price returns with no costs.
- The t-statistic of the mean return is at least 3, with sample standard
  deviation (divisor n − 1) and n at least 30. Monthly families use the
  monthly book return. Event families (F3, F6) use the round-trip trade
  return. Fewer than 30 observations cannot clear this bar.

A variant is a CANDIDATE when the full sample is positive and beats its
benchmark, at least three of the four windows are profitable with profit
factor at least 1.2 and at least one trade, and the variant is not a PASS.
Anything else is FAIL. A family that cannot be built is DATA_GAP, not FAIL.

Deflated Sharpe is reported for the best variant in each family and is
not a pass gate. It is the Bailey and López de Prado (2014) deflated
Sharpe probability. N is the number of market × side × variant cells in
that family that produced a finite Sharpe. The selected Sharpe is the
maximum of those Sharpes. Sharpe and skewness are measured on the monthly
book return, not annualized. The probability is reported beside the
annualized Sharpe (monthly Sharpe × sqrt(12)).

## Costs

Equity and ETF trades use `applyCosts` from
`lib/research/cost-model.js` (`implementation-cost-v1`): commission,
half-spread, slippage, tax, and FX, plus the profile's borrow on shorts.
Entries are the next session's open after the signal close. A same-bar
fill is not used.

Futures in F1 pay that round trip when the position opens and closes, and
a roll estimate while it is open. The stored commodity files are single
continuous series, not a front and next contract. The roll estimate is
26 bps per month the position is held (OTHER profile: 6 bps commission +
10 bps half-spread + 10 bps slippage), charged on that month's return.
Index proxies are not futures and do not pay this roll.

F5 replaces the profile borrow with 1% per year, charged as
100 / 252 bps per session held. If a hard-to-borrow flag exists on that
name, the charge is 5% per year (500 / 252 bps per session). No
hard-to-borrow file is in the research cache. Unless one is found before
the run, every F5 short pays 1% and the 5% branch is reported as unused.
F5 still pays the rest of the market's round-trip cost.

## Executable form

Every PASS and every CANDIDATE is repeated at $30,000 per position with
the lot rules in `lib/research/exit-amendment.js` (`positionSize`,
`boardLot`): Japan and Hong Kong board lots of 100, London prices in
pence, and one micro-futures contract when one contract exceeds $30,000.
A family holds at most 50 positions, one per ticker. If more names qualify,
the strongest signals are kept. This re-run does not change the verdict.
It reports whether the same rule still makes money in that size.

## F1 — time-series trend, futures, long and short

Commodities are the current micro map only: GC=F, SI=F, CL=F, HG=F, PL=F,
PA=F, NG=F. A commodity that is not in that map is out, including the
grain and livestock ETF stand-ins.

Index proxies, in this order, using a cached daily series or a Yahoo daily
download of that symbol: S&P 500 SPY, Nasdaq QQQ, Nikkei ^N225, Hang Seng
^HSI, DAX ^GDAXI, CAC ^FCHI, FTSE ^FTSE. If ^FTSE cannot be downloaded,
EWU is the FTSE proxy because it is already the UK benchmark. QQQ is not
replaced with SPY. A symbol that cannot be loaded is a data gap for that
market.

Signal at the month-end close. The position earns the move from the next
session open to the next rebalance's next session open. Vol target on
every variant: prior 63-session close-to-close volatility, annualized,
weight = min(2, 0.10 / volatility). Non-finite volatility is flat. Cash
earns 0.

| Variant | Signal |
| --- | --- |
| ts_3m | sign of the 63-session return |
| ts_6m | sign of the 126-session return |
| ts_12m | sign of the 252-session return |
| ts_12_1 | sign of the return from 252 sessions ago to 21 sessions ago |
| ts_blend | sign of the equal-weight average of the 3m, 6m, and 12m returns |
| ts_vote | sign of the sum of those three signs; a zero sum is flat |

Each instrument is its own market. Long-only is flat when the sign is
short. Short-only is flat when the sign is long. Combined always takes
the sign. The commodity book and the index book are equal-weight
composites of their instruments, using the same weights.

Benchmarks: long-only and combined versus buy-and-hold of that instrument
or equal-weight composite. Short-only versus being short that series.
Horizon label: medium. Empty cells this can fill: Commodities short, and
a new index-futures book. It does not fill an equity cell.

## F2 — commodity carry

Run only if a dated front-contract price and a dated next-contract price
exist for the same commodity. The first step of the run is that check
against the research cache and one historical curve request. A single
continuous series, or an ETF, is not a curve. If the pair is missing the
family is DATA_GAP and the grid below is not computed.

If the pair exists, carry is (next − front) / front at month-end, using
only contracts knowable that day. Long the top third by backwardation,
short the top third by contango, equal weight, enter next open, hold one
month. Commodities are the micro map only.

| Variant | Rule |
| --- | --- |
| thirds | long top third backwardation, short top third contango |
| quartiles | top and bottom quarter instead of thirds |
| long_only | top third backwardation, no short |
| short_only | top third contango, no long |
| annualized | thirds, with carry annualized by the months between the two contracts |
| top_half | long the backwardated half, short the contango half |

Horizon: medium. Benchmark: equal-weight buy-and-hold of the commodities
that have a curve; the short book versus shorting that composite.
Empty cell: Commodities short, and the long side of Commodities medium
only as a candidate beside the existing mean-reversion book.

## F3 — earnings-announcement drift, price only, both sides

The FMP report date is the date in the cached earnings file. No EPS, no
surprise, and no estimate. Let d0 be the first price bar on or after that
date. The 3-session abnormal return is the stock's close[d0] / close[d0−3]
minus the same ratio on the market index. The signal is known at the d0
close. Entry is the next session open. Exit is the close hold−1 sessions
after the entry bar. The equity curve is the equal-weight of open
positions' daily marks, and a day with no position is 0. The round-trip
cost is taken on the exit day.

Ranks are within one market and one calendar month of d0. The top decile
is a long and the bottom decile is a short. A month with fewer than 10
reports is skipped. India is long the top decile only.

Indexes: US SPY, UK ^FTSE or EWU, France ^FCHI, Japan ^N225. India has
no dated membership and no earnings cache here, so India is DATA_GAP.
Japan has earnings dates and prices for some names but no dated index
membership file, so Japan is DATA_GAP rather than a current Nikkei list.

| Variant | Hold |
| --- | --- |
| hold_21 | 21 sessions |
| hold_42 | 42 sessions |
| hold_63 | 63 sessions |

Horizon: medium for 21, long for 42 and 63. Benchmark: buy-and-hold of
that market's index; shorts versus shorting the index.
Empty cells: US medium, UK medium, France long. US short only if the
short decile passes on its own. Sells stay off unless this study passes;
this file does not turn them on.

## F4 — residual momentum and industry momentum

US only, long only, dated S&P membership. Medium holds one month. Long
holds six months as six equal-weight overlapping sleeves, one new sleeve
each month.

Residual momentum is the intercept from a regression of the stock's daily
returns on the S&P proxy's daily returns and the stock's sector
equal-weight daily return, over the 252 sessions ending 21 sessions
before the signal, excluding the stock itself from the sector. Names
without a sector label are dropped.

Industry momentum ranks industries by the equal-weight 126-session return
of their current members, then holds every member of the selected
industries in equal weight.

Sector and industry labels are the current FMP profile fields. They are
not point-in-time. The readout marks these two variants
CURRENT_INDUSTRY_LABELS. If the profile cache cannot be loaded, F4 is
DATA_GAP. A market return is not used in place of a sector or industry.

| Variant | Rule |
| --- | --- |
| resid_decile_medium | top decile of residual momentum, hold one month |
| resid_quintile_medium | top quintile, hold one month |
| resid_decile_long | top decile, six-month sleeves |
| ind_quintile_medium | top quintile of industries by 6-month return, hold one month |
| ind_top3_medium | top 3 industries, hold one month |
| ind_quintile_long | top quintile of industries, six-month sleeves |

Benchmark: SPY. Empty cells: US medium and US long.

## F5 — junk shorts

Short only. A name qualifies when all of the following are true on the
signal date: 12-minus-1 return is negative, the close is below the
200-session moving average, and the quality test in the variant is true.
Piotroski ≤ 2 or Altman Z < 1.8 are the quality tests. Z is the
cache-only score from `scoreAtDecision`. A statement is usable only when
it has a filing date or accepted date, and only from 45 days after that
date. A statement with no filing date is ignored. It is not given the
45-day lag from the period end.

Markets: US, UK, France, and Japan, each only with dated membership.
Germany has statement files and no dated membership file, so a pooled
Europe book is DATA_GAP. France is reported as France, not relabelled
Europe. Japan is DATA_GAP until a dated membership file exists.

Rebalance is monthly unless the variant says 63 sessions. Equal weight.
One position per ticker.

| Variant | Quality rule and book |
| --- | --- |
| or_all | Piotroski ≤ 2 or Z < 1.8, every qualifier |
| pio_only | Piotroski ≤ 2 only |
| z_only | Z < 1.8 only |
| and_both | both quality tests |
| or_worst10 | the OR rule, the 10 most negative 12-minus-1 names |
| or_63 | the OR rule, held 63 sessions |

Horizon: medium, and short for the 63-session hold is still reported as
medium because it is inside one quarter. Benchmark: shorting that
market's index. Empty cells: the sell side of US, UK, France, and Japan.

## F6 — short-term reversal within industry

Signal at the close. Five-session stock return minus the equal-weight
return of the other names in its industry over the same five sessions.
Bottom decile long. Top decile short where that market is shortable.
Hold five sessions unless the variant says otherwise. Enter next open.
Exit at the close of the last hold session. Daily marks, cash day 0.

Markets: UK and France, both sides. Hong Kong long only, and only if a
dated Hang Seng membership file exists. It does not today, so Hong Kong
is DATA_GAP. Industry labels are the same current FMP profile labels as
F4, marked CURRENT_INDUSTRY_LABELS. No label, no trade. The market
return is not the industry return.

| Variant | Signal and hold |
| --- | --- |
| d5_h5 | 5-session residual, decile, hold 5 |
| d5_h3 | 5-session residual, decile, hold 3 |
| d5_h10 | 5-session residual, decile, hold 10 |
| d3_h5 | 3-session residual, decile, hold 5 |
| d10_h5 | 10-session residual, decile, hold 5 |
| q5_h5 | 5-session residual, quintile, hold 5 |

Horizon: short. Benchmark: buy-and-hold of the market index; shorts
versus shorting the index. Empty cells: UK short, France short, and
Hong Kong long if the membership file exists.

## F7 — crypto time-series trend

BTC-USD and ETH-USD only. Same six signals as F1. No volatility target.
Monthly rebalance, next-session open, cash earns 0. Shorts pay the
crypto profile borrow in the cost model. This book stays signals-only
even if it passes; the readout says so.

| Variant | Signal |
| --- | --- |
| ts_3m | sign of the 63-session return |
| ts_6m | sign of the 126-session return |
| ts_12m | sign of the 252-session return |
| ts_12_1 | sign of the return from 252 sessions ago to 21 sessions ago |
| ts_blend | sign of the equal-weight average of the 3m, 6m, and 12m returns |
| ts_vote | sign of the sum of those three signs; a zero sum is flat |

Long-only, short-only, and combined, per coin and for the equal-weight
pair. Benchmark: buy-and-hold of that coin or pair; shorts versus being
short it. Horizon: medium. Empty cell: none in the equity table. Crypto
is a separate signals-only book.

## What this file does not do

It does not enable a setup, change a flag, or edit the bridge. The
readout is `docs/strategy-gaps-readout.md`.
