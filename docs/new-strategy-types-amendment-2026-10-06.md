# New strategy types — amendment

Frozen: 2026-10-06, before this run. Research only. No live order, flag, or setup-book change.

The 2026-10-05 family of 46 stays as scored. This amendment adds eight earnings-reaction variants and re-scores the twenty momentum variants on a longer price sample. It does not replace the original window table.

## Longer momentum sample

Same twenty variants: US long, UK medium and long, France medium and long; 12-1 momentum or Piotroski ≥ 6; cash when the benchmark is below its 200-day average, on or off.

US point-in-time membership in `data/research/fmp` begins 2014-01-23, so the US book cannot start in 2010. Prices are extended toward 2010-01-01 and a name is held only while `membershipAt` includes it. Names that left the index and have no price file stay missing.

UK and France have no dated membership. Those books are SURVIVORSHIP_BIAS. Prices are extended toward 2010-01-01 on the cached constituent list.

Each variant reports, per calendar year, its return against the passive benchmark, plus the full-sample max drawdown and worst month.

## US medium earnings reaction

Eight variants. Buy only. Point-in-time US membership.

The report day is the Yahoo chart earnings date. The signal is that session's close-to-close return minus the same-day SPY return. Thresholds are ≥ 3% and ≥ 5%. Entry is the open one session later, or two sessions later. Exit is a 2.5 ATR(14) stop, measured on completed bars before entry, or the close of session 40 or 60. Costs use the same implementation-cost model as the consistency study.

A PASS still needs a positive return and profit factor of at least 1.2 in every one of the four study windows, and a better return than SPY in at least three windows.
