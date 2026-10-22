# Cell strategy search — readout

Generated: 2026-10-22T08:34:53.185Z

Research only. No live signal, setup-book cell, bracket, order, flag, or deployment setting changed.
Pre-registration: `docs/cell-strategy-search-preregistration.md`. Consistency rule: mean reversion needs every window profitable with win rate ≥ 60%; trend, momentum, breakout, reversal and earnings books need every window profitable with PF ≥ 1.2. Ranking: CONSISTENT first, then worst all-window PF, then smaller average loss. The fourth window is OVERLAP_RISK in every source.

## Best strategy by requested cell

A row is the best available strategy for the cell, not an endorsement: only CONSISTENT cells clear the framework. Rows from the trend/momentum books report per-window book return (%) rather than $ PnL; the crypto trend rows are the same monthly-rebalanced book scored under the medium and long labels in the source study.

| Market | Horizon | Verdict | Best row | Family | Worst PF | Pooled n | Pooled WR | Pooled PF | Why not consistent | Source | Membership |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Hong Kong | short | NONE | `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__full` | mean_reversion | 0.659 | 184 | 49.5% | 0.706 | window 1 lost money | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| UK | short | NONE | `E__UK__short__worst5__regimeoff` | weekly_reversal | 0.555 | 2310 | 44.2% | 0.775 | window 1 lost money | new-strategy-types 2026-10-05 | SURVIVORSHIP_BIAS |
| Germany | short | NONE | `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` | mean_reversion | 0.802 | 83 | 62.7% | 0.964 | window 2 lost money | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| France | short | NONE | `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` | mean_reversion | 0.664 | 407 | 63.6% | 0.725 | window 2 lost money | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| Commodities | short | NONE | `A__Commodities__short__close_below_lower_bb20_2__none__sl1.5__t10__full` | mean_reversion | 0.641 | 43 | 67.4% | 0.881 | window 1 lost money | consistency-study 2026-10-05 | NOT_APPLICABLE |
| Crypto | short | NONE | `D__Crypto__short__breakout20` | breakout | 0.122 | 1038 | 38.6% | 2.246 | window 2 PF 0.122 < 1.2 | new-strategy-types 2026-10-05 | NOT_APPLICABLE |
| US | medium | NONE | `A2__US__medium__react0.03_d2_h60__longsample` | earnings | 1.053 | 3591 | 41.8% | 1.313 | window 1 lost money | strategy-amendment 2026-10-06 | POINT_IN_TIME |
| UK | medium | NONE | `B__UK__medium__momentum__regimeoff` | momentum | 1.149 | 1060 | 51.2% | 1.105 | window 4 PF 1.149 < 1.2 | new-strategy-types 2026-10-05 | SURVIVORSHIP_BIAS |
| Germany | medium | NONE | `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full` | mean_reversion | 0.939 | 82 | 64.6% | 0.986 | window 2 lost money | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| France | medium | NONE | `B__France__medium__momentum__regimeoff__longsample` | momentum | 0.92 | 1890 | 50.6% | 1.145 | window 3 lost money | strategy-amendment 2026-10-06 | SURVIVORSHIP_BIAS |
| Crypto | medium | NONE | `D__Crypto__medium__trend12m` | trend | 0.133 | 712 | 20.8% | 5.478 | window 2 PF 0.372 < 1.2 | new-strategy-types 2026-10-05 | NOT_APPLICABLE |
| US | long | CONSISTENT | `B__US__long__piotroski6__regimeoff` | momentum | 2.102 | 2206 | 59.9% | 2.502 | — | new-strategy-types 2026-10-05 | POINT_IN_TIME |
| UK | long | CONSISTENT | `B__UK__long__piotroski6__regimeoff` | momentum | 1.478 | 975 | 52.4% | 1.478 | — | new-strategy-types 2026-10-05 | SURVIVORSHIP_BIAS |
| Crypto | long | NONE | `D__Crypto__long__trend12m` | trend | 0.133 | 712 | 20.8% | 5.478 | window 2 PF 0.372 < 1.2 | new-strategy-types 2026-10-05 | NOT_APPLICABLE |

## Per-cell detail

### Hong Kong · short — NONE

Variants scored: 114.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Hong_Kong__short__sector_off` | 0 | 4 | 75% | 43.54 | window 4 has no trades |
| mean_reversion | 108 | 0 | `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__full` | 0.659 | 184 | 49.5% | 0.706 | window 1 lost money |
| weekly_reversal | 4 | 0 | `C__Hong_Kong__short__worst5__regimeoff` | 0.501 | 2310 | 45.3% | 0.88 | window 1 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__full` — MR close_below_lower_bb20_2 · vol_skip_top30_and_ma50_flat_or_up · 2.5 ATR stop · t5 · full. $-2856.25 / PF 0.659 / n 41 · $-673.19 / PF 0.887 / n 49 · $-5493.24 / PF 0.665 / n 94 · $127.89 / PF 1.202 / n 6. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30__sl2.5__t5__full` — MR close_below_lower_bb20_2 · vol_skip_top30 · 2.5 ATR stop · t5 · full. $-2925.64 / PF 0.653 / n 42 · $-673.19 / PF 0.887 / n 49 · $-5493.24 / PF 0.665 / n 94 · $-22.89 / PF 0.972 / n 8. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2__t5__full` — MR close_below_lower_bb20_2 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t5 · full. $-3471.17 / PF 0.614 / n 41 · $-548.09 / PF 0.906 / n 49 · $-5615.85 / PF 0.66 / n 95 · $-10.8 / PF 0.986 / n 6. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30__sl2__t5__full` — MR close_below_lower_bb20_2 · vol_skip_top30 · 2 ATR stop · t5 · full. $-3540.56 / PF 0.609 / n 42 · $-548.09 / PF 0.906 / n 49 · $-5615.85 / PF 0.66 / n 95 · $-161.58 / PF 0.832 / n 8. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30__sl2.5__t10__full` — MR close_below_lower_bb20_2 · vol_skip_top30 · 2.5 ATR stop · t10 · full. $-4725.33 / PF 0.605 / n 39 · $-2499.13 / PF 0.71 / n 46 · $-6297.18 / PF 0.675 / n 90 · $-261.39 / PF 0.792 / n 8. Source verdict: NOT_CONSISTENT. BH q 1.

### UK · short — NONE

Variants scored: 114.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__UK__short__sector_off` | 0 | 0 | 0% | 0 | window 1 has no trades |
| mean_reversion | 108 | 0 | `A__UK__short__close_below_lower_bb20_2__none__sl2__t10__full` | 0.372 | 340 | 64.1% | 0.536 | window 1 lost money |
| weekly_reversal | 4 | 0 | `E__UK__short__worst5__regimeoff` | 0.555 | 2310 | 44.2% | 0.775 | window 1 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `E__UK__short__worst5__regimeoff` — Weekly reversal, worst 5. -24.14% / PF 0.555 / n 125 · -0.04% / PF 1.033 / n 125 · -20.07% / PF 0.659 / n 130 · 11.39% / PF 1.265 / n 125. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `E__UK__short__worst10__regimeoff` — Weekly reversal, worst 10. -23.64% / PF 0.509 / n 250 · -2.55% / PF 0.974 / n 250 · -25.33% / PF 0.584 / n 260 · 3.36% / PF 1.096 / n 250. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `E__UK__short__worst5__regimeon` — Weekly reversal, worst 5, only above 200-day MA. -19.16% / PF 0.461 / n 80 · -5.95% / PF 0.899 / n 120 · -20.07% / PF 0.659 / n 130 · 11.39% / PF 1.265 / n 125. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `A__UK__short__close_below_lower_bb20_2__none__sl2__t10__full` — MR close_below_lower_bb20_2 · none · 2 ATR stop · t10 · full. $-11114.76 / PF 0.372 / n 91 · $-2435.68 / PF 0.822 / n 101 · $-15826.96 / PF 0.504 / n 148 · $2324.99 / PF 1.221 / n 91. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__UK__short__williams_r10_lt_minus_95__none__sl1.5__t10__full` — MR williams_r10_lt_minus_95 · none · 1.5 ATR stop · t10 · full. $-14505.83 / PF 0.366 / n 122 · $-7208.24 / PF 0.542 / n 116 · $-8415.11 / PF 0.658 / n 158 · $-4967.25 / PF 0.741 / n 122. Source verdict: NOT_CONSISTENT. BH q 1.

### Germany · short — NONE

Variants scored: 110.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Germany__short__sector_off` | 0 | 3 | 66.7% | 1.141 | window 3 lost money |
| mean_reversion | 108 | 0 | `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` | 0.802 | 83 | 62.7% | 0.964 | window 2 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t10 · full. $20.17 / PF 1.016 / n 12 · $-538 / PF 0.896 / n 47 · $151.33 / PF 1.04 / n 24 · $-757.53 / PF 0.802 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30__sl2.5__t5__full` — MR williams_r10_lt_minus_95 · vol_skip_top30 · 2.5 ATR stop · t5 · full. $-630.97 / PF 0.778 / n 25 · $1157.45 / PF 1.281 / n 53 · $307.74 / PF 1.082 / n 28 · $-650.88 / PF 0.849 / n 30. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t5__partial` — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t5 · 50/50 partial. $-152.62 / PF 0.845 / n 13 · $107.12 / PF 1.021 / n 50 · $390.08 / PF 1.127 / n 24 · $-994.72 / PF 0.756 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__close_below_lower_bb20_2__vol_skip_top30__sl1.5__t5__partial` — MR close_below_lower_bb20_2 · vol_skip_top30 · 1.5 ATR stop · t5 · 50/50 partial. $-352.14 / PF 0.776 / n 13 · $-61.26 / PF 0.989 / n 51 · $745.05 / PF 1.202 / n 34 · $-714.85 / PF 0.747 / n 20. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__rsi2_lt_5__vol_skip_top30__sl2.5__t10__full` — MR rsi2_lt_5 · vol_skip_top30 · 2.5 ATR stop · t10 · full. $-913.28 / PF 0.94 / n 125 · $4366.31 / PF 1.18 / n 218 · $-8210.69 / PF 0.773 / n 202 · $-5126.25 / PF 0.741 / n 116. Source verdict: NOT_CONSISTENT. BH q 1.

### France · short — NONE

Variants scored: 114.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__France__short__sector_off` | 0 | 1 | 100% | 99 | window 1 has no trades |
| mean_reversion | 108 | 0 | `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` | 0.664 | 407 | 63.6% | 0.725 | window 2 lost money |
| weekly_reversal | 4 | 0 | `E__France__short__worst10__regimeon` | 0.629 | 3120 | 45.5% | 0.769 | window 1 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · 50/50 partial. $895.31 / PF 1.131 / n 60 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-2366.14 / PF 0.835 / n 88. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__short__rsi2_lt_5__vol_skip_top30__sl2__t10__partial` — MR rsi2_lt_5 · vol_skip_top30 · 2 ATR stop · t10 · 50/50 partial. $540.75 / PF 1.079 / n 61 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-367.74 / PF 0.977 / n 109. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__full` — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · full. $183.31 / PF 1.027 / n 62 · $-7523.74 / PF 0.682 / n 170 · $-12290.58 / PF 0.637 / n 194 · $-3747.32 / PF 0.76 / n 92. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__short__rsi2_lt_5__vol_skip_top30__sl2__t10__full` — MR rsi2_lt_5 · vol_skip_top30 · 2 ATR stop · t10 · full. $299.59 / PF 1.044 / n 65 · $-7523.74 / PF 0.682 / n 170 · $-12290.58 / PF 0.637 / n 194 · $-1119.77 / PF 0.934 / n 114. Source verdict: NOT_CONSISTENT. BH q 1.
- `E__France__short__worst10__regimeon` — Weekly reversal, worst 10, only above 200-day MA. -3.95% / PF 0.786 / n 90 · -16.09% / PF 0.711 / n 240 · -18.25% / PF 0.629 / n 230 · -0.68% / PF 0.991 / n 190. Source verdict: FAIL. Beat benchmark in 1/4 windows.

### Commodities · short — NONE

Variants scored: 111.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| breakout | 1 | 0 | `D__Commodities__short__breakout20` | 0.113 | 602 | 35.9% | 1.129 | window 1 PF 0.664 < 1.2 |
| current_engine | 2 | 0 | `B__Commodities__short__sector_off` | 0 | 1 | 0% | 0 | window 1 lost money |
| mean_reversion | 108 | 0 | `A__Commodities__short__close_below_lower_bb20_2__none__sl1.5__t10__full` | 0.641 | 43 | 67.4% | 0.881 | window 1 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__Commodities__short__close_below_lower_bb20_2__none__sl1.5__t10__full` — MR close_below_lower_bb20_2 · none · 1.5 ATR stop · t10 · full. $-34.94 / PF 0.971 / n 12 · $-228.51 / PF 0.756 / n 9 · $-453.38 / PF 0.884 / n 22 · $-1733.17 / PF 0.641 / n 29. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Commodities__short__close_below_lower_bb20_2__none__sl1.5__t10__partial` — MR close_below_lower_bb20_2 · none · 1.5 ATR stop · t10 · 50/50 partial. $564.2 / PF 1.47 / n 12 · $208.3 / PF 1.223 / n 9 · $-671.75 / PF 0.828 / n 22 · $-1798.23 / PF 0.628 / n 29. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Commodities__short__close_below_lower_bb20_2__none__sl2.5__t5__partial` — MR close_below_lower_bb20_2 · none · 2.5 ATR stop · t5 · 50/50 partial. $376.6 / PF 1.332 / n 10 · $-131.75 / PF 0.883 / n 9 · $-1384.19 / PF 0.613 / n 20 · $-1209.53 / PF 0.717 / n 26. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Commodities__short__close_below_lower_bb20_2__none__sl2__t10__partial` — MR close_below_lower_bb20_2 · none · 2 ATR stop · t10 · 50/50 partial. $1080.42 / PF 2.36 / n 10 · $-15.72 / PF 0.986 / n 9 · $-1824.77 / PF 0.64 / n 22 · $-1931.89 / PF 0.612 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Commodities__short__close_below_lower_bb20_2__none__sl2__t10__full` — MR close_below_lower_bb20_2 · none · 2 ATR stop · t10 · full. $363.62 / PF 1.463 / n 10 · $-452.53 / PF 0.61 / n 9 · $-1606.4 / PF 0.682 / n 22 · $-1796.97 / PF 0.639 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.

### Crypto · short — NONE

Variants scored: 111.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| breakout | 1 | 0 | `D__Crypto__short__breakout20` | 0.122 | 1038 | 38.6% | 2.246 | window 2 PF 0.122 < 1.2 |
| current_engine | 2 | 0 | `B__Crypto__short__sector_off` | 0 | 1 | 100% | 99 | window 2 has no trades |
| mean_reversion | 108 | 0 | `A__Crypto__short__williams_r10_lt_minus_95__none__sl1.5__t10__full` | 0 | 6 | 100% | 99 | window 3 has no trades |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `D__Crypto__short__breakout20` — 20-day breakout, exit on a 10-day low. 27.12% / PF 2.202 / n 61 · 65.62% / PF 0.122 / n 39 · 44.73% / PF 0.145 / n 52 · 55.93% / PF 2.829 / n 56. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.
- `A__Crypto__short__williams_r10_lt_minus_95__none__sl1.5__t10__full` — MR williams_r10_lt_minus_95 · none · 1.5 ATR stop · t10 · full. $1446.55 / PF 99 / n 4 · $499.66 / PF 99 / n 2 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Crypto__short__williams_r10_lt_minus_95__none__sl1.5__t10__partial` — MR williams_r10_lt_minus_95 · none · 1.5 ATR stop · t10 · 50/50 partial. $2035.59 / PF 99 / n 4 · $811.49 / PF 99 / n 2 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Crypto__short__williams_r10_lt_minus_95__none__sl1.5__t5__full` — MR williams_r10_lt_minus_95 · none · 1.5 ATR stop · t5 · full. $1219.23 / PF 99 / n 4 · $499.66 / PF 99 / n 2 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Crypto__short__williams_r10_lt_minus_95__none__sl1.5__t5__partial` — MR williams_r10_lt_minus_95 · none · 1.5 ATR stop · t5 · 50/50 partial. $1654.51 / PF 99 / n 4 · $811.49 / PF 99 / n 2 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.

### US · medium — NONE

Variants scored: 118. Blocked families: A (Post-earnings drift): No point-in-time EPS estimate history is in data/research/fmp.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__US__medium__sector_off` | 0 | 9 | 55.6% | 0.602 | window 1 lost money |
| earnings | 8 | 0 | `A2__US__medium__react0.03_d2_h60__longsample` | 1.053 | 3591 | 41.8% | 1.313 | window 1 lost money |
| mean_reversion | 108 | 0 | `A__US__medium__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` | 0.746 | 1607 | 59.7% | 0.94 | window 1 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A2__US__medium__react0.03_d2_h60__longsample` — Earnings reaction, excess ≥ 3%, enter +2 session, hold 60 or 2.5 ATR. -2.74% / PF 1.053 / n 240 · 10.47% / PF 1.994 / n 121 · 0.57% / PF 1.081 / n 229 · 2.14% / PF 1.147 / n 245. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `A2__US__medium__react0.05_d2_h60__longsample` — Earnings reaction, excess ≥ 5%, enter +2 session, hold 60 or 2.5 ATR. -1.51% / PF 1.062 / n 144 · 10.46% / PF 1.615 / n 68 · -2.8% / PF 0.949 / n 133 · 5.29% / PF 1.295 / n 135. Source verdict: FAIL. Beat benchmark in 0/4 windows.
- `A2__US__medium__react0.03_d1_h60__longsample` — Earnings reaction, excess ≥ 3%, enter +1 session, hold 60 or 2.5 ATR. -4.93% / PF 0.911 / n 230 · 10.99% / PF 2.325 / n 124 · 2.89% / PF 1.088 / n 224 · 2.51% / PF 1.219 / n 244. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `A2__US__medium__react0.05_d1_h60__longsample` — Earnings reaction, excess ≥ 5%, enter +1 session, hold 60 or 2.5 ATR. -3.13% / PF 0.871 / n 140 · 9.78% / PF 1.84 / n 70 · 0.25% / PF 1.089 / n 130 · 4.93% / PF 1.298 / n 133. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `A__US__medium__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` — MR close_below_lower_bb20_2 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t10 · full. $-23161.95 / PF 0.746 / n 633 · $61.38 / PF 1.001 / n 357 · $9361.8 / PF 1.098 / n 617 · $-7259.52 / PF 0.902 / n 439. Source verdict: NOT_CONSISTENT. BH q 1.

### UK · medium — NONE

Variants scored: 118.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__UK__medium__sector_off` | 0 | 1 | 0% | 0 | window 1 has no trades |
| mean_reversion | 108 | 0 | `A__UK__medium__williams_r10_lt_minus_95__none__sl1.5__t21__full` | 0.372 | 396 | 62.9% | 0.532 | window 1 lost money |
| momentum | 8 | 0 | `B__UK__medium__momentum__regimeoff` | 1.149 | 1060 | 51.2% | 1.105 | window 4 PF 1.149 < 1.2 |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `B__UK__medium__momentum__regimeoff` — 12-1 momentum. 4.26% / PF 1.288 / n 60 · 15.04% / PF 2.119 / n 60 · 15.53% / PF 1.714 / n 70 · 1.77% / PF 1.149 / n 50. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.
- `B__UK__medium__piotroski6__regimeoff` — 12-1 momentum among Piotroski ≥ 6. 1.48% / PF 1.111 / n 60 · 3.62% / PF 1.198 / n 56 · 8.64% / PF 1.451 / n 70 · 2.58% / PF 1.252 / n 50. Source verdict: CANDIDATE. Beat benchmark in 3/4 windows.
- `B__UK__medium__momentum__regimeoff__longsample` — 12-1 momentum. 2.5% / PF 1.156 / n 60 · 22.92% / PF 3.051 / n 60 · 10.13% / PF 1.548 / n 60 · -1.91% / PF 0.949 / n 60. Source verdict: CANDIDATE. Beat benchmark in 3/4 windows.
- `B__UK__medium__piotroski6__regimeoff__longsample` — 12-1 momentum among Piotroski ≥ 6. -1.6% / PF 0.938 / n 60 · 9.94% / PF 1.785 / n 56 · 7.11% / PF 1.434 / n 60 · 1.63% / PF 1.131 / n 60. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `B__UK__medium__piotroski6__regimeon` — 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA. -5.29% / PF 0.626 / n 40 · 3.62% / PF 1.198 / n 56 · 8.64% / PF 1.451 / n 70 · 2.58% / PF 1.252 / n 50. Source verdict: FAIL. Beat benchmark in 2/4 windows.

### Germany · medium — NONE

Variants scored: 110.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Germany__medium__sector_off` | 0 | 4 | 75% | 6.306 | window 1 has no trades |
| mean_reversion | 108 | 0 | `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full` | 0.939 | 82 | 64.6% | 0.986 | window 2 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full` — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t21 · full. $20.17 / PF 1.016 / n 12 · $-318 / PF 0.939 / n 46 · $151.33 / PF 1.04 / n 24 · $425.27 / PF 1.117 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t10 · full. $20.17 / PF 1.016 / n 12 · $-538 / PF 0.896 / n 47 · $151.33 / PF 1.04 / n 24 · $-757.53 / PF 0.802 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl2__t21__full` — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t21 · full. $-349.07 / PF 0.787 / n 12 · $-135.99 / PF 0.974 / n 43 · $-1001.11 / PF 0.797 / n 24 · $-541.23 / PF 0.882 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30__sl2.5__t21__full` — MR williams_r10_lt_minus_95 · vol_skip_top30 · 2.5 ATR stop · t21 · full. $-368.18 / PF 0.878 / n 23 · $156.78 / PF 1.029 / n 46 · $-1426.28 / PF 0.771 / n 28 · $515.41 / PF 1.119 / n 29. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__close_below_lower_bb20_2__vol_skip_top30__sl1.5__t21__full` — MR close_below_lower_bb20_2 · vol_skip_top30 · 1.5 ATR stop · t21 · full. $-416.04 / PF 0.769 / n 13 · $-922.75 / PF 0.864 / n 51 · $2070.56 / PF 1.498 / n 34 · $-838.25 / PF 0.782 / n 22. Source verdict: NOT_CONSISTENT. BH q 1.

### France · medium — NONE

Variants scored: 118.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__France__medium__sector_on` | 0 | 7 | 28.6% | 0.24 | window 1 lost money |
| mean_reversion | 108 | 0 | `A__France__medium__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` | 0.664 | 407 | 63.6% | 0.725 | window 2 lost money |
| momentum | 8 | 0 | `B__France__medium__momentum__regimeoff__longsample` | 0.92 | 1890 | 50.6% | 1.145 | window 3 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `B__France__medium__momentum__regimeoff__longsample` — 12-1 momentum. 3.85% / PF 1.276 / n 60 · 2.46% / PF 1.217 / n 60 · -2.41% / PF 0.937 / n 60 · -2.37% / PF 0.92 / n 60. Source verdict: FAIL. Beat benchmark in 2/4 windows.
- `B__France__medium__momentum__regimeoff` — 12-1 momentum. 5.99% / PF 1.499 / n 60 · -4.91% / PF 0.705 / n 60 · 1.46% / PF 1.108 / n 70 · 0.62% / PF 1.051 / n 50. Source verdict: CANDIDATE. Beat benchmark in 3/4 windows.
- `A__France__medium__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · 50/50 partial. $895.31 / PF 1.131 / n 60 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-2366.14 / PF 0.835 / n 88. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__medium__rsi2_lt_5__vol_skip_top30__sl2__t10__partial` — MR rsi2_lt_5 · vol_skip_top30 · 2 ATR stop · t10 · 50/50 partial. $540.75 / PF 1.079 / n 61 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-367.74 / PF 0.977 / n 109. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__medium__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__full` — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · full. $183.31 / PF 1.027 / n 62 · $-7523.74 / PF 0.682 / n 170 · $-12290.58 / PF 0.637 / n 194 · $-3747.32 / PF 0.76 / n 92. Source verdict: NOT_CONSISTENT. BH q 1.

### Crypto · medium — NONE

Variants scored: 112.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Crypto__medium__sector_off` | 0 | 0 | 0% | 0 | window 1 has no trades |
| mean_reversion | 108 | 0 | `A__Crypto__medium__close_below_lower_bb20_2__none__sl1.5__t21__full` | 0 | 5 | 100% | 99 | window 3 has no trades |
| trend | 2 | 0 | `D__Crypto__medium__trend12m` | 0.133 | 712 | 20.8% | 5.478 | window 2 PF 0.372 < 1.2 |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `D__Crypto__medium__trend12m` — 12-month trend and 200-day MA. 38.51% / PF 4.265 / n 35 · 6.13% / PF 0.372 / n 34 · 39.24% / PF 0.133 / n 8 · 95.77% / PF 5.015 / n 14. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.
- `D__Crypto__medium__trend3m` — 3-month trend and 200-day MA. 29.35% / PF 0.602 / n 47 · -10.95% / PF 0.625 / n 43 · 90.73% / PF 0.038 / n 6 · 33.03% / PF 2.674 / n 50. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.
- `A__Crypto__medium__close_below_lower_bb20_2__none__sl1.5__t21__full` — MR close_below_lower_bb20_2 · none · 1.5 ATR stop · t21 · full. $626.14 / PF 99 / n 3 · $499.66 / PF 99 / n 2 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Crypto__medium__close_below_lower_bb20_2__none__sl1.5__t21__partial` — MR close_below_lower_bb20_2 · none · 1.5 ATR stop · t21 · 50/50 partial. $965.49 / PF 99 / n 3 · $811.49 / PF 99 / n 2 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Crypto__medium__close_below_lower_bb20_2__none__sl2__t21__full` — MR close_below_lower_bb20_2 · none · 2 ATR stop · t21 · full. $626.14 / PF 99 / n 3 · $499.66 / PF 99 / n 2 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.

### US · long — CONSISTENT

Variants scored: 12.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__US__long__sector_off` | 0 | 2 | 50% | 15.071 | window 1 has no trades |
| momentum | 8 | 2 | `B__US__long__piotroski6__regimeoff` | 2.102 | 2206 | 59.9% | 2.502 | — |
| wave3_breakout | 2 | 0 | `C__us__long__old68` | 0.411 | 505 | 27.3% | 1.757 | window 1 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `B__US__long__piotroski6__regimeoff` — 12-1 momentum among Piotroski ≥ 6. 7.52% / PF 4.604 / n 130 · 13.78% / PF 2.391 / n 146 · 3.22% / PF 2.102 / n 149 · 20.8% / PF 7.283 / n 141. Source verdict: PASS. Beat benchmark in 3/4 windows.
- `B__US__long__momentum__regimeoff` — 12-1 momentum. 6.5% / PF 3.384 / n 288 · 10.64% / PF 1.505 / n 291 · 0.22% / PF 2.04 / n 343 · 22.23% / PF 4.359 / n 246. Source verdict: PASS. Beat benchmark in 3/4 windows.
- `B__US__long__piotroski6__regimeoff__longsample` — 12-1 momentum among Piotroski ≥ 6. -3.65% / PF 4.174 / n 126 · 27.26% / PF 2.9 / n 148 · 0.09% / PF 1.738 / n 126 · 22.57% / PF 7.722 / n 169. Source verdict: CANDIDATE. Beat benchmark in 3/4 windows.
- `B__US__long__momentum__regimeoff__longsample` — 12-1 momentum. -5.48% / PF 2.551 / n 288 · 24.71% / PF 2.233 / n 292 · -3.6% / PF 1.653 / n 294 · 26.6% / PF 4.695 / n 295. Source verdict: FAIL. Beat benchmark in 2/4 windows.
- `B__US__long__piotroski6__regimeon` — 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA. 7.52% / PF 4.604 / n 130 · -1.11% / PF 5.016 / n 94 · 3.28% / PF 1.498 / n 104 · 2.35% / PF 8.131 / n 113. Source verdict: FAIL. Beat benchmark in 2/4 windows.

### UK · long — CONSISTENT

Variants scored: 10.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__UK__long__sector_off` | 0 | 0 | 0% | 0 | window 1 has no trades |
| momentum | 8 | 2 | `B__UK__long__piotroski6__regimeoff` | 1.478 | 975 | 52.4% | 1.478 | — |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `B__UK__long__piotroski6__regimeoff` — 12-1 momentum among Piotroski ≥ 6. 10.15% / PF 2.013 / n 60 · 5.93% / PF 5.41 / n 60 · 14.44% / PF 7.015 / n 66 · 2.09% / PF 1.478 / n 50. Source verdict: PASS. Beat benchmark in 3/4 windows.
- `B__UK__long__piotroski6__regimeoff__longsample` — 12-1 momentum among Piotroski ≥ 6. 7.55% / PF 1.894 / n 60 · 13.54% / PF 7.605 / n 60 · 10.87% / PF 6.71 / n 56 · 0.37% / PF 1.408 / n 60. Source verdict: PASS. Beat benchmark in 4/4 windows.
- `B__UK__long__piotroski6__regimeon` — 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA. -0.63% / PF 1.395 / n 40 · 4.2% / PF 4.798 / n 40 · 14.44% / PF 7.015 / n 66 · 2.09% / PF 1.478 / n 50. Source verdict: FAIL. Beat benchmark in 2/4 windows.
- `B__UK__long__piotroski6__regimeon__longsample` — 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA. -1.74% / PF 1.272 / n 40 · 10.28% / PF 8.404 / n 40 · 10.87% / PF 6.71 / n 56 · 0.37% / PF 1.408 / n 60. Source verdict: FAIL. Beat benchmark in 2/4 windows.
- `B__UK__long__momentum__regimeoff` — 12-1 momentum. 6.89% / PF 1.091 / n 60 · 15.63% / PF 3.697 / n 60 · 13.18% / PF 10.21 / n 70 · 15.11% / PF 2.426 / n 50. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.

### Crypto · long — NONE

Variants scored: 4.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Crypto__long__sector_off` | 0 | 0 | 0% | 0 | window 1 has no trades |
| trend | 2 | 0 | `D__Crypto__long__trend12m` | 0.133 | 712 | 20.8% | 5.478 | window 2 PF 0.372 < 1.2 |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `D__Crypto__long__trend12m` — 12-month trend and 200-day MA. 38.51% / PF 4.265 / n 35 · 6.13% / PF 0.372 / n 34 · 39.24% / PF 0.133 / n 8 · 95.77% / PF 5.015 / n 14. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.
- `D__Crypto__long__trend3m` — 3-month trend and 200-day MA. 29.35% / PF 0.602 / n 47 · -10.95% / PF 0.625 / n 43 · 90.73% / PF 0.038 / n 6 · 33.03% / PF 2.674 / n 50. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.
- `B__Crypto__long__sector_off` — Live engine long, sector off. $0 / PF 0 / n 0 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.
- `B__Crypto__long__sector_on` — Live engine long, sector on. $0 / PF 0 / n 0 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0 · $0 / PF 0 / n 0. Source verdict: NOT_CONSISTENT. BH q 1.

## Live engine at the short horizon (new replay)

Sector OFF for Hong Kong, UK, Germany and France is the stage-1 cache primary buy stream (same engine, same bars); sector ON was replayed through `scripts/consistency-trend-worker.js`. Commodities and Crypto were fetched fresh (10y daily) and replayed for both variants. The engine almost never fires at the short horizon: 0–4 trades per market over the whole sample, so no window pattern exists to be consistent. A small BH q with n ≤ 4 (Hong Kong) is a win-rate artefact, not evidence; the consistency rule already fails on the empty window.

| Market | Sector | Contexts | Pooled n | Pooled WR | Pooled PF | Pooled PnL | Windows (PnL / PF / n) | BH q | Consistent |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| Hong Kong | off | 72 | 4 | 75% | 43.54 | $1134.96 | $526.78 / 20.745 / 2 · $45.23 / 99 / 1 · $562.95 / 99 / 1 · $0 / — / 0 | 0.0061173 | false |
| Hong Kong | on | 72 | 4 | 75% | 43.54 | $1134.96 | $526.78 / 20.745 / 2 · $45.23 / 99 / 1 · $562.95 / 99 / 1 · $0 / — / 0 | 0.0061173 | false |
| UK | off | 92 | 0 | — | — | $0 | $0 / — / 0 · $0 / — / 0 · $0 / — / 0 · $0 / — / 0 | 1 | false |
| UK | on | 92 | 0 | — | — | $0 | $0 / — / 0 · $0 / — / 0 · $0 / — / 0 · $0 / — / 0 | 1 | false |
| Germany | off | 38 | 3 | 66.7% | 1.141 | $63.44 | $191.83 / 99 / 1 · $321.98 / 99 / 1 · $-450.37 / 0 / 1 · $-503.12 / 0.536 / 3 | 0.9333842 | false |
| Germany | on | 38 | 3 | 66.7% | 1.141 | $63.44 | $191.83 / 99 / 1 · $321.98 / 99 / 1 · $-450.37 / 0 / 1 · $-503.12 / 0.536 / 3 | 0.9333842 | false |
| France | off | 39 | 1 | 100% | 99 | $171.59 | $0 / — / 0 · $0 / — / 0 · $171.59 / 99 / 1 · $0 / — / 0 | 0.85714286 | false |
| France | on | 39 | 1 | 100% | 99 | $171.59 | $0 / — / 0 · $0 / — / 0 · $171.59 / 99 / 1 · $0 / — / 0 | 0.85714286 | false |
| Commodities | off | 21 | 1 | 0% | 0 | $-118.42 | $-118.42 / 0 / 1 · $0 / — / 0 · $0 / — / 0 · $126.21 / 99 / 1 | 1 | false |
| Commodities | on | 21 | 3 | 66.7% | 4.326 | $393.8 | $393.8 / 4.326 / 3 · $0 / — / 0 · $0 / — / 0 · $0 / — / 0 | 0.85714286 | false |
| Crypto | off | 2 | 1 | 100% | 99 | $220.59 | $220.59 / 99 / 1 · $0 / — / 0 · $0 / — / 0 · $0 / — / 0 | 0.85714286 | false |
| Crypto | on | 2 | 1 | 100% | 99 | $220.59 | $220.59 / 99 / 1 · $0 / — / 0 · $0 / — / 0 · $0 / — / 0 | 0.85714286 | false |

## Reference only — omitted-geography rescue (different fold calendar)

- France short: `rsi2_lt_5__prior_close__t3__sl2__full` holdout n 174, WR 37.4%, PF 0.553, PnL $-3245.41 — mtcPass false, stable development folds 0, sample confidence FAIL, promotable false.
- France medium: `rsi2_lt_5__ma20__t21__sl2.5__full` holdout n 113, WR 53.1%, PF 0.531, PnL $-9083.96 — mtcPass false, stable development folds 0, sample confidence FAIL, promotable false.
- Germany short: `williams_r10_lt_minus_95__one_atr__t10__sl2.5__full` holdout n 32, WR 62.5%, PF 0.93, PnL $-307.47 — mtcPass false, stable development folds 0, sample confidence FAIL, promotable false.
- Germany medium: `williams_r10_lt_minus_95__one_atr__t21__sl2.5__full` holdout n 31, WR 71%, PF 0.991, PnL $-43.96 — mtcPass false, stable development folds 0, sample confidence FAIL, promotable false.
- Hong Kong short: `close_below_lower_bb20_2__one_atr__t10__sl2.5__full` holdout n 11, WR 72.7%, PF 1.755, PnL $767.17 — mtcPass false, stable development folds 1, sample confidence FAIL, promotable false.
- UK short: `rsi2_lt_5__prior_close__t3__sl2__full` holdout n 568, WR 15.8%, PF 0.136, PnL $-47534.27 — mtcPass false, stable development folds 0, sample confidence FAIL, promotable false.
- UK medium: `rsi2_lt_5__prior_close__t10__sl2__full` holdout n 557, WR 18.9%, PF 0.169, PnL $-43345.14 — mtcPass false, stable development folds 0, sample confidence FAIL, promotable false.
- Commodities short: `rsi2_lt_5__prior_close__t3__sl2__full` holdout n 229, WR 27.1%, PF 0.211, PnL $-15891.14 — mtcPass false, stable development folds 0, sample confidence FAIL, promotable false.

## Sources

- scripts/consistency-study-results.json (Part A MR grid short/medium; Part B live engine medium/long; Part C Wave 3)
- scripts/new-strategy-types-results.json (momentum, weekly reversal, commodity/crypto trend and breakout, PEAD)
- scripts/strategy-amendment-results.json (momentum on the longer sample; US earnings reaction)
- scripts/cell-strategy-search-engine-short.json (new: live engine short horizon, sector off/on)
- scripts/backtest-omitted-geo-rescue-results.json (reference only)

Machine-readable results: `scripts/cell-strategy-search-results.json`; engine-short replay trades: `scripts/cell-strategy-search-engine-short.json`.

