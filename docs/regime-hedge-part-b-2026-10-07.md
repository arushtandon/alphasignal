# Regime hedge Part B

Scored from the stage-1 worker price cache. No `server.js` import. Each open trade is $30,000 from its entry date through its exit date. The hedge is short the US-listed index ETF on the session after a confirmed downtrend, sized to the prior exposure, and covered when that state ends. Hedge execution and borrow use the US cost profile because SPY and EWJ are US-listed.

The sector filter uses the market benchmark. The ticker-to-sector map lives in `server.js` and was not copied. Japan `.T` prices are the bars stored on the Japan worker results. Japan amended books drop the time stop and hold until the target, the stop, or the last cached bar.

US_LONG_WAVE3 is rebuilt from those same bars: 12-1 momentum above zero, close above MA200, entry on the next open, 4 ATR initial stop, 5 ATR trail, MA200 exit, 180-session cap, sampled every second bar. The worker files do not store that trade list.

COMMODITIES_MEDIUM_MR hedge-on is a gap. `HEDGE_ETFS` has no commodities ETF. DBC was not substituted. There is also no Commodities worker cache, so hedge-off was not rebuilt.

## JAPAN_MEDIUM_MR

Hedge ETF EWJ. Symbols 217. Trades 4735. Hedge-leg P&L $-30,986 (execution $21,318, borrow $1,673).

| Window | Hedge | Return | PF | Max DD | Sessions | Sessions hedged | Book P&L |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024-09-26 → 2025-03-28 | off | 1.45% | 1.549 | -6.89% | 76 | 0 | $25,691 |
| 2024-09-26 → 2025-03-28 | on | -4.56% | 1.273 | -11.71% | 76 | 29 | $14,778 |
| 2025-03-31 → 2025-09-29 | off | -27.19% | 0.921 | -28.26% | 92 | 0 | $-14,433 |
| 2025-03-31 → 2025-09-29 | on | -27.19% | 0.921 | -28.26% | 92 | 0 | $-14,433 |
| 2025-09-30 → 2026-03-31 | off | 20.39% | 1.343 | -6.72% | 97 | 0 | $86,781 |
| 2025-09-30 → 2026-03-31 | on | 20.39% | 1.343 | -6.72% | 97 | 0 | $86,781 |
| 2026-04-01 → 2026-09-30 | off | -2.95% | 1.183 | -9.88% | 95 | 0 | $56,718 |
| 2026-04-01 → 2026-09-30 | on | -2.95% | 1.183 | -9.88% | 95 | 0 | $56,718 |

## JAPAN_SHORT_MR

Hedge ETF EWJ. Symbols 217. Trades 4735. Hedge-leg P&L $-22,260 (execution $25,542, borrow $1,940).

| Window | Hedge | Return | PF | Max DD | Sessions | Sessions hedged | Book P&L |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024-09-26 → 2025-03-28 | off | 3.5% | 1.518 | -6.22% | 76 | 0 | $32,899 |
| 2024-09-26 → 2025-03-28 | on | -2.8% | 1.296 | -10.42% | 76 | 29 | $21,538 |
| 2025-03-31 → 2025-09-29 | off | -24.57% | 0.952 | -25.05% | 92 | 0 | $-10,485 |
| 2025-03-31 → 2025-09-29 | on | -24.57% | 0.952 | -25.05% | 92 | 0 | $-10,485 |
| 2025-09-30 → 2026-03-31 | off | 13.05% | 1.392 | -5.03% | 99 | 0 | $124,320 |
| 2025-09-30 → 2026-03-31 | on | 13.05% | 1.392 | -5.03% | 99 | 0 | $124,320 |
| 2026-04-01 → 2026-09-30 | off | -0.16% | 1.247 | -8.45% | 95 | 0 | $88,999 |
| 2026-04-01 → 2026-09-30 | on | -0.16% | 1.247 | -8.45% | 95 | 0 | $88,999 |

## US_SHORT_MR

Hedge ETF SPY. Symbols 623. Trades 13331. Hedge-leg P&L $12,759 (execution $6,204, borrow $371).

| Window | Hedge | Return | PF | Max DD | Sessions | Sessions hedged | Book P&L |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024-09-26 → 2025-03-28 | off | -16.57% | 0.697 | -18.32% | 72 | 0 | $-169,724 |
| 2024-09-26 → 2025-03-28 | on | -16.57% | 0.697 | -18.32% | 72 | 0 | $-169,724 |
| 2025-03-31 → 2025-09-29 | off | 6.99% | 1.36 | -3.19% | 86 | 0 | $39,546 |
| 2025-03-31 → 2025-09-29 | on | 6.99% | 1.36 | -3.19% | 86 | 0 | $39,546 |
| 2025-09-30 → 2026-03-31 | off | -8.72% | 1.23 | -9.31% | 115 | 0 | $97,929 |
| 2025-09-30 → 2026-03-31 | on | -8.72% | 1.23 | -9.31% | 115 | 0 | $97,929 |
| 2026-04-01 → 2026-09-30 | off | 1.06% | 1.085 | -7.61% | 82 | 0 | $28,697 |
| 2026-04-01 → 2026-09-30 | on | 1.06% | 1.085 | -7.61% | 82 | 0 | $28,697 |

## US_LONG_WAVE3

Hedge ETF SPY. Symbols 623. Trades 18532. Hedge-leg P&L $-389,902 (execution $285,846, borrow $57,911).

| Window | Hedge | Return | PF | Max DD | Sessions | Sessions hedged | Book P&L |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024-09-26 → 2025-03-28 | off | -2.73% | 0.945 | -10.65% | 126 | 0 | $-169,053 |
| 2024-09-26 → 2025-03-28 | on | -3.28% | 0.941 | -9.72% | 126 | 12 | $-173,644 |
| 2025-03-31 → 2025-09-29 | off | 5.19% | 1.199 | -13.99% | 126 | 0 | $409,011 |
| 2025-03-31 → 2025-09-29 | on | -1.46% | 1.168 | -11.44% | 126 | 30 | $326,470 |
| 2025-09-30 → 2026-03-31 | off | 2.3% | 1.029 | -8.29% | 126 | 0 | $79,167 |
| 2025-09-30 → 2026-03-31 | on | 3.54% | 1.072 | -6.42% | 126 | 8 | $181,855 |
| 2026-04-01 → 2026-09-30 | off | 6.37% | 1.18 | -5.71% | 126 | 0 | $411,696 |
| 2026-04-01 → 2026-09-30 | on | 2.18% | 1.06 | -5.71% | 126 | 5 | $137,882 |

## COMMODITIES_MEDIUM_MR

Gap. No commodities ETF is in the frozen hedge map, and the worker cache has no Commodities contexts.

The informational overlay on the current paper book was not run. It is not a trial.

