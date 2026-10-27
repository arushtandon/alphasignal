# US long momentum, Piotroski ≥ 6 — paper design

Not enabled. No order, flag, or setup-book change.

The book is the 2010-sample candidate: US long, 12-1 momentum among names with a point-in-time Piotroski score of at least 6, regime filter off. US signals start on 2014-01-23.

## Book

Six overlapping monthly sleeves. Once a month, rank eligible names and open one new sleeve. The other five sleeves stay. When a sleeve reaches six months, sell it.

Each name is a $30,000 ticket. The cap is N = 15 names, from the paper account net liquidation of $461,315.62 on 5 October 2026 (15 × $30,000 = $450,000). If the ranked sleeve would push the open count past 15, take the strongest names that still fit and skip the rest. A name already held in a younger sleeve is not bought again.

## Orders

Once a month, one batch:

- Sell the oldest sleeve.
- Buy the new sleeve at the cap above.

No other orders. Stops and targets are not part of this design.

## Tag and PnL

Fills use the tag `US_LONG_PIOTROSKI`. The PnL view shows only that tag: open names, sleeve month, and cumulative return against SPY from the first sleeve.

## Auto-pause

After six monthly rebalances, compare the tagged book's cumulative return with SPY over those same six months. If the book is behind SPY by more than 5 percentage points, stop opening new sleeves. Sleeves already open are sold on their normal six-month date. Nothing turns the book back on by itself.
