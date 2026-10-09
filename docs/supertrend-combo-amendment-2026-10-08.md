# Supertrend combination amendment — 2026-10-08

Amends `docs/supertrend-combo-preregistration-2026-10-08.md`
(`e552e85700d5049beb8b4299b46dee088ed7c9dc`). Discovery data only: US
ever-members, signals from 2010-01-01 through 2019-12-31. No bar after
2019-12-31 is scored. Stage 2 is not authorized by this amendment.

## Volume

The price cache is the Yahoo daily chart used by
`scripts/run-strategy-amendment.js`, and that cache stored open, high, low,
and close only. F8 is re-scored from `indicators.quote.volume` on that same
chart, joined onto the cached bars by timestamp. This is the same source,
not a second vendor. A cached bar with no joined volume stays F8 false.
Sessions after 2019-12-31 are not scored.

## F12

F12 is dropped. On a flip the Supertrend line switches to the opposite
band, so the close is not within 1 ATR of that line. F12 cannot be true
after a flip. Trials that include F12 stay in the trial count and cannot
be frozen.

## Extra statistics

These are reported for every rule that meets the freeze gate below. They
do not change a trade that was already scored.

The monthly book return is the equal-weight average of concurrent daily
excesses, compounded inside the calendar month, including months whose
days have no open trade (those days contribute 0). The monthly t-statistic
is the t-statistic of that monthly series.

For a short, the monthly book return is regressed on the same month's SPY
close-to-close return by ordinary least squares with an intercept. Beta is
the slope. Annualized alpha is 12 times the monthly intercept. Alpha t is
the intercept divided by its classical OLS standard error.

## Freeze

Tighter than the 2026-10-07 freeze, and not looser. A row qualifies only
when all of these hold:

- profit factor at least 1.2
- the horizon minimum trades (SHORT 300, MEDIUM 150, LONG 100, including
  the weekly base)
- monthly book t at least 2.5
- for a short, alpha t at least 2

F8 rows use the volume re-score. Rows that require F12 do not qualify.
Rank qualifying rows by per-trade excess t and take the top 3 in each
horizon and side. LONG still pools the daily (14, 4) base and the weekly
(10, 3) base. If fewer qualify, freeze only those that do.

The registered trial count is 1,248 (the replacement search) + 312 (the
voided long-only search) + the number of F8 trials re-scored with volume.
The F8 re-score is every F8 single and every F8 pair, on all 4 bases, both
sides, and both exits.

Write the freeze to `docs/supertrend-combo-frozen-2026-10-08.md`. The
2026-10-07 freeze is not the Stage 2 rule set. Stage 2 has not been run.
