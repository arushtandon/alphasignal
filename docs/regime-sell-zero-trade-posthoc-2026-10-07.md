# Regime-sell Part A — post-hoc zero-trade diagnostic

POST-HOC. This does not change the stored verdicts in `scripts/regime-sell-hedge-results.json` or `docs/regime-sell-hedge-readout.md`.
A Part A window passes the frozen rule when its pnl is positive and its win rate is at least 60%. A window with zero trades fails that rule because its pnl is not positive.
A variant is in the table below when every window that has trades would pass, and at least one window has zero trades. That is the only reason it is not consistent.

Part A variants: 1944. Stored consistent: 0.
Failed only because a window had zero trades: 120.
Separate count, all four windows empty: 0. Those are not in the table, because there is no window with trades to treat as neutral.

Neutral rescore: a zero-trade window is ignored. The variant is neutral-consistent when every window that has trades passes.

| Variant | Neutral | Window 1 | Window 2 | Window 3 | Window 4 |
| --- | --- | --- | --- | --- | --- |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl1.5__t5__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 1008.13 / 83.3% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl1.5__t5__partial | yes | neutral (0 trades) | pass 318.3 / 60% / 5 trades | pass 1671.93 / 83.3% / 6 trades | pass 140.02 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl1.5__t10__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl1.5__t10__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl2__t5__partial | yes | neutral (0 trades) | pass 71.11 / 60% / 5 trades | pass 1906.27 / 100% / 5 trades | pass 140.02 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl2__t10__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl2.5__t10__full | yes | neutral (0 trades) | pass 183.99 / 80% / 5 trades | pass 818.89 / 80% / 5 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__none__sl2.5__t10__partial | yes | neutral (0 trades) | pass 378.95 / 75% / 4 trades | pass 668.73 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t5__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 1008.13 / 83.3% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t5__partial | yes | neutral (0 trades) | pass 318.3 / 60% / 5 trades | pass 1671.93 / 83.3% / 6 trades | pass 140.02 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t10__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t10__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl2__t5__partial | yes | neutral (0 trades) | pass 71.11 / 60% / 5 trades | pass 1906.27 / 100% / 5 trades | pass 140.02 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl2__t10__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl2.5__t10__full | yes | neutral (0 trades) | pass 183.99 / 80% / 5 trades | pass 818.89 / 80% / 5 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30__sl2.5__t10__partial | yes | neutral (0 trades) | pass 378.95 / 75% / 4 trades | pass 668.73 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t5__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 1008.13 / 83.3% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t5__partial | yes | neutral (0 trades) | pass 318.3 / 60% / 5 trades | pass 1671.93 / 83.3% / 6 trades | pass 140.02 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2__t5__partial | yes | neutral (0 trades) | pass 71.11 / 60% / 5 trades | pass 1906.27 / 100% / 5 trades | pass 140.02 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__full | yes | neutral (0 trades) | pass 183.99 / 80% / 5 trades | pass 818.89 / 80% / 5 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__short__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__partial | yes | neutral (0 trades) | pass 378.95 / 75% / 4 trades | pass 668.73 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl1.5__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl1.5__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl1.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl1.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2.5__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2.5__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 746.02 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__partial | yes | neutral (0 trades) | pass 605.12 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 458.59 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__short__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl1.5__t10__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl1.5__t10__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl1.5__t21__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl1.5__t21__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl2__t10__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl2__t21__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl2.5__t10__full | yes | neutral (0 trades) | pass 183.99 / 80% / 5 trades | pass 818.89 / 80% / 5 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__none__sl2.5__t10__partial | yes | neutral (0 trades) | pass 378.95 / 75% / 4 trades | pass 668.73 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t10__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t10__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t21__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl1.5__t21__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl2__t10__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl2__t21__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl2.5__t10__full | yes | neutral (0 trades) | pass 183.99 / 80% / 5 trades | pass 818.89 / 80% / 5 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30__sl2.5__t10__partial | yes | neutral (0 trades) | pass 378.95 / 75% / 4 trades | pass 668.73 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full | yes | neutral (0 trades) | pass 100.19 / 66.7% / 6 trades | pass 151.86 / 66.7% / 6 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__partial | yes | neutral (0 trades) | pass 424.51 / 60% / 5 trades | pass 497.48 / 66.7% / 6 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2__t21__partial | yes | neutral (0 trades) | pass 177.32 / 60% / 5 trades | pass 623.51 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__full | yes | neutral (0 trades) | pass 183.99 / 80% / 5 trades | pass 818.89 / 80% / 5 trades | pass 173.65 / 100% / 1 trades |
| SELL__Crypto__medium__close_above_upper_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__partial | yes | neutral (0 trades) | pass 378.95 / 75% / 4 trades | pass 668.73 / 80% / 5 trades | pass 286.98 / 100% / 1 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl1.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl1.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl1.5__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl1.5__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2.5__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__none__sl2.5__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl1.5__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30__sl2.5__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 776.48 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t10__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 418.73 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t21__full | yes | neutral (0 trades) | pass 639.68 / 100% / 2 trades | pass 322.94 / 100% / 1 trades | pass 925.82 / 100% / 3 trades |
| SELL__Crypto__medium__williams_r10_gt_minus_5__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t21__partial | yes | neutral (0 trades) | pass 505.1 / 100% / 2 trades | pass 514.91 / 100% / 1 trades | pass 778.24 / 100% / 3 trades |

