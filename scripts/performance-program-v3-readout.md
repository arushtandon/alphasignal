# Cache-backed Performance Program Readout

Generated: 2026-10-02T09:18:55.254Z

## Outcome
Executed cells: 744; blocked cells: 0.
Full cached-universe run requested.
Primary uses decision-date FX normalization for currency mismatches and scales LSE GBp prices to GBP; Piotroski-only output remains non-promotable.
FX sources are loaded by each bounded worker from the local cache with retry.
This readout includes the execution requested for this run.
Stage 2 was run only after explicit Stage 1 review approval.

## Stage 1 geography × horizon × side summary
| Geography | Horizon | Side | Result / best passing config | Win % | PF | PnL | Confidence | Holdout | Coverage (full gate) | Basis |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| US | short | buy | FAIL | 0% | 0 | -427.91 USD | INSUFFICIENT | 1 trades | 76.2% (535630/702667) | B; INSUFFICIENT_SAMPLE |
| US | short | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 76.2% (535630/702667) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| US | medium | buy | FAIL | 0% | 0 | -654.03 USD | INSUFFICIENT | 1 trades | 76.2% (535630/702667) | B; INSUFFICIENT_SAMPLE |
| US | medium | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 76.2% (535630/702667) | E; INSUFFICIENT_NO_HOLDOUT_TRADES |
| US | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 76.2% (535630/702667) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| US | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 76.2% (535630/702667) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Japan | short | buy | FAIL | 40% | 0.505 | -755.69 USD | INSUFFICIENT | 5 trades | 44.1% (107020/242540) | B; INSUFFICIENT_SAMPLE |
| Japan | short | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 44.1% (107020/242540) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Japan | medium | buy | FAIL | 41.2% | 1.179 | 483.09 USD | THIN | 17 trades | 44.1% (107020/242540) | B; EXECUTED |
| Japan | medium | sell | FAIL | 66.7% | 2.806 | 976.77 USD | INSUFFICIENT | 3 trades | 44.1% (107020/242540) | D; INSUFFICIENT_SAMPLE |
| Japan | long | buy | FAIL | 50% | 3.39 | 5122.58 USD | INSUFFICIENT | 4 trades | 44.1% (107020/242540) | D; INSUFFICIENT_SAMPLE |
| Japan | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 44.1% (107020/242540) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Hong Kong | short | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 36.9% (27573/74677) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Hong Kong | short | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 36.9% (27573/74677) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Hong Kong | medium | buy | FAIL | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) | D; INSUFFICIENT_SAMPLE |
| Hong Kong | medium | sell | FAIL | 50% | 1.867 | 1290.98 USD | INSUFFICIENT | 10 trades | 36.9% (27573/74677) | B; INSUFFICIENT_SAMPLE |
| Hong Kong | long | buy | FAIL | 100% | 99 | 2350.11 USD | INSUFFICIENT | 1 trades | 36.9% (27573/74677) | D; INSUFFICIENT_SAMPLE |
| Hong Kong | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 36.9% (27573/74677) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | short | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | short | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | medium | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | medium | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Germany | short | buy | FAIL | 33.3% | 0.536 | -503.12 USD | INSUFFICIENT | 3 trades | 70.6% (30594/43343) | B; INSUFFICIENT_SAMPLE |
| Germany | short | sell | FAIL | 0% | 0 | -450.5 USD | INSUFFICIENT | 1 trades | 70.6% (30594/43343) | B; INSUFFICIENT_SAMPLE |
| Germany | medium | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Germany | medium | sell | FAIL | 55.6% | 2.444 | 1797.47 USD | INSUFFICIENT | 9 trades | 70.6% (30594/43343) | D; INSUFFICIENT_SAMPLE |
| Germany | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Germany | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) | E; INSUFFICIENT_NO_HOLDOUT_TRADES |
| France | short | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| France | short | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| France | medium | buy | FAIL | 100% | 99 | 643.64 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) | B; INSUFFICIENT_SAMPLE |
| France | medium | sell | FAIL | 0% | 0 | -125.18 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) | E; INSUFFICIENT_SAMPLE |
| France | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| France | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |

A PASS requires the frozen Stage 1 promotion criteria and BH correction. FAIL rows show the deterministically highest-ranked evaluated primary-parity Stage 1 cell for context; they are not candidates.

## Stage 1 ranked configurations
| Rank | Result | Geography | Horizon | Side | Part | Config | Win % | PF | PnL | Confidence | Holdout | Coverage (full gate) |
| ---: | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 1 | FAIL | Japan | long | buy | D | Piotroski>=5 | 50% | 3.39 | 5122.58 USD | INSUFFICIENT | 4 trades | 44.1% (107020/242540) |
| 2 | FAIL | Japan | long | buy | D | Piotroski>=6 | 50% | 3.39 | 5122.58 USD | INSUFFICIENT | 4 trades | 44.1% (107020/242540) |
| 3 | FAIL | Hong Kong | long | buy | D | Piotroski>=7 | 100% | 99 | 2350.11 USD | INSUFFICIENT | 1 trades | 36.9% (27573/74677) |
| 4 | FAIL | Japan | long | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 28.6% | 1.428 | 2176.56 USD | INSUFFICIENT | 7 trades | 44.1% (107020/242540) |
| 5 | FAIL | Germany | medium | sell | D | Piotroski>=7 | 55.6% | 2.444 | 1797.47 USD | INSUFFICIENT | 9 trades | 70.6% (30594/43343) |
| 6 | FAIL | Hong Kong | long | buy | D | Piotroski>=5 | 50% | 3.053 | 1580.36 USD | INSUFFICIENT | 2 trades | 36.9% (27573/74677) |
| 7 | FAIL | Hong Kong | long | buy | D | Piotroski>=6 | 50% | 3.053 | 1580.36 USD | INSUFFICIENT | 2 trades | 36.9% (27573/74677) |
| 8 | FAIL | Germany | medium | sell | D | Piotroski>=5 | 54.5% | 1.671 | 1577.02 USD | INSUFFICIENT | 11 trades | 70.6% (30594/43343) |
| 9 | FAIL | Hong Kong | medium | buy | D | Piotroski>=5 | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) |
| 10 | FAIL | Hong Kong | medium | buy | D | Piotroski>=6 | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) |
| 11 | FAIL | Hong Kong | medium | buy | D | Piotroski>=7 | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) |
| 12 | FAIL | Hong Kong | medium | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 50% | 1.867 | 1290.98 USD | INSUFFICIENT | 10 trades | 36.9% (27573/74677) |
| 13 | FAIL | Germany | medium | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 56.3% | 1.388 | 1238.03 USD | THIN | 16 trades | 70.6% (30594/43343) |
| 14 | FAIL | Hong Kong | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 62.5% | 2.667 | 1009.59 USD | INSUFFICIENT | 8 trades | 36.9% (27573/74677) |
| 15 | FAIL | Japan | medium | sell | D | Piotroski>=5 | 66.7% | 2.806 | 976.77 USD | INSUFFICIENT | 3 trades | 44.1% (107020/242540) |
| 16 | FAIL | Hong Kong | medium | sell | D | Piotroski>=5 | 50% | 3.224 | 716.92 USD | INSUFFICIENT | 2 trades | 36.9% (27573/74677) |
| 17 | FAIL | Germany | medium | sell | D | Piotroski>=6 | 50% | 1.294 | 692.12 USD | INSUFFICIENT | 10 trades | 70.6% (30594/43343) |
| 18 | FAIL | France | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 100% | 99 | 643.64 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) |
| 19 | FAIL | Japan | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 41.2% | 1.179 | 483.09 USD | THIN | 17 trades | 44.1% (107020/242540) |
| 20 | FAIL | Germany | medium | sell | E | PIT_F_SCORE_LE_3 | 100% | 99 | 150.32 USD | INSUFFICIENT | 1 trades | 70.6% (30594/43343) |
| 21 | FAIL | France | short | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) |
| 22 | FAIL | France | short | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) |
| 23 | FAIL | Germany | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) |
| 24 | FAIL | Hong Kong | short | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 36.9% (27573/74677) |
| 25 | FAIL | Hong Kong | short | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 36.9% (27573/74677) |
| 26 | FAIL | Japan | short | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 44.1% (107020/242540) |
| 27 | FAIL | UK | long | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) |
| 28 | FAIL | UK | long | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) |
| 29 | FAIL | UK | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) |
| 30 | FAIL | UK | medium | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) |

## Best configuration
No forward candidate qualified.

## Pooled development candidates (n >= 30)
- B Japan long buy PIO_ONLY_NON_PARITY: n=61, WR=50.8%, PF=1.836, PnL=25243.02 USD; holdout n=7; Part D BH=n/a
- B Japan long buy PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY: n=58, WR=50%, PF=1.817, PnL=23144.41 USD; holdout n=7; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_12PCT_TIME_80_MODE_TP1_ONLY: n=59, WR=59.3%, PF=1.735, PnL=15007.25 USD; holdout n=12; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_12PCT_TIME_80_MODE_50_50_TP2: n=59, WR=59.3%, PF=1.644, PnL=13158.79 USD; holdout n=12; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_NONE_TIME_80_MODE_TP1_ONLY: n=59, WR=55.9%, PF=1.519, PnL=12319.66 USD; holdout n=11; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_NONE_TIME_80_MODE_50_50_TP2: n=59, WR=55.9%, PF=1.472, PnL=11210.96 USD; holdout n=10; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_12PCT_TIME_80_MODE_TP1_ONLY: n=59, WR=62.7%, PF=1.525, PnL=10290.31 USD; holdout n=14; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_12PCT_TIME_80_MODE_TP1_ONLY: n=59, WR=50.8%, PF=1.421, PnL=10205.06 USD; holdout n=12; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_12PCT_TIME_80_MODE_50_50_TP2: n=59, WR=50.8%, PF=1.411, PnL=9967.28 USD; holdout n=11; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_12PCT_TIME_80_MODE_50_50_TP2: n=59, WR=62.7%, PF=1.491, PnL=9624.33 USD; holdout n=14; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_NONE_TIME_80_MODE_50_50_TP2: n=59, WR=49.2%, PF=1.335, PnL=8928.79 USD; holdout n=10; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_NONE_TIME_80_MODE_TP1_ONLY: n=59, WR=49.2%, PF=1.329, PnL=8779.6 USD; holdout n=10; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_NONE_TIME_80_MODE_TP1_ONLY: n=59, WR=57.6%, PF=1.35, PnL=8187.8 USD; holdout n=12; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_NONE_TIME_80_MODE_50_50_TP2: n=59, WR=57.6%, PF=1.285, PnL=6670.49 USD; holdout n=12; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_NONE_TIME_80_MODE_50_50_TP2: n=59, WR=47.5%, PF=1.212, PnL=5977.5 USD; holdout n=10; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_NONE_TIME_80_MODE_TP1_ONLY: n=59, WR=47.5%, PF=1.169, PnL=4762.94 USD; holdout n=10; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_12PCT_TIME_80_MODE_50_50_TP2: n=59, WR=45.8%, PF=1.141, PnL=3931.57 USD; holdout n=10; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_12PCT_TIME_80_MODE_TP1_ONLY: n=59, WR=45.8%, PF=1.119, PnL=3319.78 USD; holdout n=10; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_12PCT_TIME_40_MODE_50_50_TP2: n=59, WR=55.9%, PF=1.121, PnL=2421.49 USD; holdout n=15; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_12PCT_TIME_40_MODE_50_50_TP2: n=59, WR=52.5%, PF=1.111, PnL=2328.02 USD; holdout n=15; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_12PCT_TIME_40_MODE_TP1_ONLY: n=59, WR=52.5%, PF=1.111, PnL=2319.66 USD; holdout n=15; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_12PCT_TIME_40_MODE_TP1_ONLY: n=59, WR=55.9%, PF=1.077, PnL=1551.1 USD; holdout n=15; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_NONE_TIME_40_MODE_TP1_ONLY: n=59, WR=50.8%, PF=1.044, PnL=995.52 USD; holdout n=14; Part D BH=n/a
- C Japan long buy TP1_1.00R_CAP_NONE_TIME_40_MODE_50_50_TP2: n=59, WR=50.8%, PF=1.032, PnL=722.34 USD; holdout n=13; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_NONE_TIME_40_MODE_50_50_TP2: n=59, WR=52.5%, PF=1.014, PnL=314.08 USD; holdout n=15; Part D BH=n/a
- C Japan long buy TP1_0.75R_CAP_NONE_TIME_40_MODE_TP1_ONLY: n=59, WR=52.5%, PF=0.99, PnL=-221.22 USD; holdout n=15; Part D BH=n/a
- B Japan medium buy PIO_ONLY_NON_PARITY: n=31, WR=45.2%, PF=0.877, PnL=-599.45 USD; holdout n=10; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_8PCT_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.841, PnL=-1178.6 USD; holdout n=17; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_12PCT_TIME_40_MODE_50_50_TP2: n=59, WR=47.5%, PF=0.949, PnL=-1184.87 USD; holdout n=13; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_NONE_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.84, PnL=-1186.33 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_NONE_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.838, PnL=-1199.24 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_8PCT_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.828, PnL=-1242.66 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_NONE_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.827, PnL=-1250.4 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_NONE_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.825, PnL=-1263.31 USD; holdout n=17; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_12PCT_TIME_40_MODE_TP1_ONLY: n=59, WR=47.5%, PF=0.945, PnL=-1272.31 USD; holdout n=13; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_NONE_TIME_40_MODE_TP1_ONLY: n=59, WR=47.5%, PF=0.942, PnL=-1366.18 USD; holdout n=13; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_NONE_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.812, PnL=-1394.73 USD; holdout n=17; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_NONE_TIME_40_MODE_50_50_TP2: n=59, WR=47.5%, PF=0.939, PnL=-1426.42 USD; holdout n=13; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_NONE_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.798, PnL=-1458.8 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_8PCT_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.795, PnL=-1478.67 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_NONE_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.8, PnL=-1486.65 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_NONE_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.8, PnL=-1486.65 USD; holdout n=17; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_NONE_TIME_40_MODE_50_50_TP2: n=59, WR=47.5%, PF=0.937, PnL=-1488.64 USD; holdout n=13; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_8PCT_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.796, PnL=-1510.43 USD; holdout n=17; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_12PCT_TIME_40_MODE_50_50_TP2: n=59, WR=47.5%, PF=0.935, PnL=-1510.81 USD; holdout n=14; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_8PCT_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.791, PnL=-1549.41 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_NONE_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.785, PnL=-1550.71 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_NONE_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.785, PnL=-1550.71 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_8PCT_TIME_30_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.79, PnL=-1556.6 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_8PCT_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.789, PnL=-1565.88 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_8PCT_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.782, PnL=-1574.49 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_NONE_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.78, PnL=-1588.23 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_8PCT_TIME_15_MODE_TP1_ONLY: n=48, WR=43.8%, PF=0.776, PnL=-1620.67 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_8PCT_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.779, PnL=-1633.72 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_8PCT_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.765, PnL=-1697.78 USD; holdout n=17; Part D BH=n/a
- C Japan long buy TP1_CURRENT_CAP_NONE_TIME_40_MODE_TP1_ONLY: n=59, WR=47.5%, PF=0.927, PnL=-1717.95 USD; holdout n=13; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_8PCT_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.761, PnL=-1725.56 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_0.75R_CAP_NONE_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.764, PnL=-1749.28 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_NONE_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.749, PnL=-1813.9 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_NONE_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.75, PnL=-1853.9 USD; holdout n=17; Part D BH=n/a
- B Japan medium buy PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY: n=48, WR=43.8%, PF=0.748, PnL=-1869.8 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_NONE_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.748, PnL=-1869.8 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_8PCT_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.737, PnL=-1901.41 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_CURRENT_CAP_NONE_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.732, PnL=-1933.87 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.00R_CAP_8PCT_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.738, PnL=-1941.4 USD; holdout n=17; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_8PCT_TIME_30_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.73, PnL=-1996.6 USD; holdout n=17; Part D BH=n/a
- C Japan long buy TP1_1.25R_CAP_12PCT_TIME_40_MODE_TP1_ONLY: n=59, WR=47.5%, PF=0.913, PnL=-2002.6 USD; holdout n=15; Part D BH=n/a
- C Japan medium buy TP1_1.25R_CAP_8PCT_TIME_15_MODE_50_50_TP2: n=48, WR=43.8%, PF=0.715, PnL=-2060.67 USD; holdout n=17; Part D BH=n/a
- B Japan medium sell PIO_ONLY_NON_PARITY: n=53, WR=18.9%, PF=0.204, PnL=-10206.16 USD; holdout n=8; Part D BH=n/a
- B Japan medium sell PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY: n=54, WR=18.5%, PF=0.196, PnL=-10726.78 USD; holdout n=8; Part D BH=n/a

## Stage 2 buy-only pooled exit grid
| Horizon | Variant | n | Win % | PF | PnL | Avg win | Avg loss | Δ PF | Δ PnL | Holdout n | BH | RR rule | Full-market harm | Recommended |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| short | TP1_CURRENT_CAP_NONE_TIME_5_MODE_TP1_ONLY | 23 | 60.9% | 1.614 | 1768.99 USD | 3.322% | -3.202% | 0.063 | 48.01 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_CURRENT_CAP_NONE_TIME_5_MODE_50_50_TP2 | 23 | 60.9% | 1.603 | 1738.48 USD | 3.3% | -3.202% | 0.052 | 17.5 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_CURRENT_CAP_NONE_TIME_10_MODE_TP1_ONLY | 23 | 65.2% | 1.51 | 1584.29 USD | 3.128% | -3.885% | -0.041 | -136.69 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_CURRENT_CAP_NONE_TIME_10_MODE_50_50_TP2 | 23 | 65.2% | 1.541 | 1681.83 USD | 3.193% | -3.885% | -0.01 | -39.15 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_CURRENT_CAP_4PCT_TIME_5_MODE_TP1_ONLY | 23 | 60.9% | 1.651 | 1834.66 USD | 3.322% | -3.129% | 0.1 | 113.68 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_CURRENT_CAP_4PCT_TIME_5_MODE_50_50_TP2 | 23 | 60.9% | 1.641 | 1804.15 USD | 3.3% | -3.129% | 0.09 | 83.17 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_CURRENT_CAP_4PCT_TIME_10_MODE_TP1_ONLY | 23 | 65.2% | 1.542 | 1649.95 USD | 3.128% | -3.803% | -0.009 | -71.03 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_CURRENT_CAP_4PCT_TIME_10_MODE_50_50_TP2 | 23 | 65.2% | 1.574 | 1747.49 USD | 3.193% | -3.803% | 0.023 | 26.51 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_0.75R_CAP_NONE_TIME_5_MODE_TP1_ONLY | 23 | 60.9% | 1.249 | 717.91 USD | 2.571% | -3.202% | -0.302 | -1003.07 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_0.75R_CAP_NONE_TIME_5_MODE_50_50_TP2 | 23 | 60.9% | 1.393 | 1132.54 USD | 2.867% | -3.202% | -0.158 | -588.44 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_0.75R_CAP_NONE_TIME_10_MODE_TP1_ONLY | 23 | 65.2% | 1.172 | 533.22 USD | 2.428% | -3.885% | -0.379 | -1187.76 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_0.75R_CAP_NONE_TIME_10_MODE_50_50_TP2 | 23 | 65.2% | 1.393 | 1220.26 USD | 2.886% | -3.885% | -0.158 | -500.72 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_0.75R_CAP_4PCT_TIME_5_MODE_TP1_ONLY | 23 | 60.9% | 1.093 | 261.81 USD | 2.199% | -3.129% | -0.458 | -1459.17 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_0.75R_CAP_4PCT_TIME_5_MODE_50_50_TP2 | 23 | 60.9% | 1.266 | 749.01 USD | 2.547% | -3.129% | -0.285 | -971.97 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_0.75R_CAP_4PCT_TIME_10_MODE_TP1_ONLY | 23 | 65.2% | 1.025 | 77.12 USD | 2.08% | -3.803% | -0.526 | -1643.86 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_0.75R_CAP_4PCT_TIME_10_MODE_50_50_TP2 | 23 | 65.2% | 1.233 | 708.68 USD | 2.501% | -3.803% | -0.318 | -1012.3 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_NONE_TIME_5_MODE_TP1_ONLY | 23 | 60.9% | 1.405 | 1167.1 USD | 2.892% | -3.202% | -0.146 | -553.88 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_NONE_TIME_5_MODE_50_50_TP2 | 23 | 60.9% | 1.497 | 1431.4 USD | 3.081% | -3.202% | -0.054 | -289.58 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_NONE_TIME_10_MODE_TP1_ONLY | 23 | 65.2% | 1.316 | 982.41 USD | 2.727% | -3.885% | -0.235 | -738.57 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_NONE_TIME_10_MODE_50_50_TP2 | 23 | 65.2% | 1.51 | 1586.48 USD | 3.13% | -3.885% | -0.041 | -134.5 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_4PCT_TIME_5_MODE_TP1_ONLY | 23 | 60.9% | 1.298 | 839.59 USD | 2.611% | -3.129% | -0.253 | -881.39 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_4PCT_TIME_5_MODE_50_50_TP2 | 23 | 60.9% | 1.361 | 1017.63 USD | 2.738% | -3.129% | -0.19 | -703.35 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_4PCT_TIME_10_MODE_TP1_ONLY | 23 | 65.2% | 1.215 | 654.9 USD | 2.465% | -3.803% | -0.336 | -1066.08 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.00R_CAP_4PCT_TIME_10_MODE_50_50_TP2 | 23 | 65.2% | 1.343 | 1044.65 USD | 2.725% | -3.803% | -0.208 | -676.33 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| short | TP1_1.25R_CAP_NONE_TIME_5_MODE_TP1_ONLY | 23 | 56.5% | 1.105 | 349.02 USD | 2.827% | -3.326% | -0.446 | -1371.96 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_1.25R_CAP_NONE_TIME_5_MODE_50_50_TP2 | 23 | 56.5% | 1.246 | 816.58 USD | 3.186% | -3.326% | -0.305 | -904.4 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_1.25R_CAP_NONE_TIME_10_MODE_TP1_ONLY | 23 | 60.9% | 1.046 | 164.33 USD | 2.655% | -3.947% | -0.505 | -1556.65 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_1.25R_CAP_NONE_TIME_10_MODE_50_50_TP2 | 23 | 60.9% | 1.245 | 869.64 USD | 3.159% | -3.947% | -0.306 | -851.34 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_1.25R_CAP_4PCT_TIME_5_MODE_TP1_ONLY | 23 | 56.5% | 1.08 | 260.67 USD | 2.708% | -3.26% | -0.471 | -1460.31 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_1.25R_CAP_4PCT_TIME_5_MODE_50_50_TP2 | 23 | 56.5% | 1.247 | 805.23 USD | 3.127% | -3.26% | -0.304 | -915.75 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_1.25R_CAP_4PCT_TIME_10_MODE_TP1_ONLY | 23 | 60.9% | 1.022 | 75.97 USD | 2.545% | -3.874% | -0.529 | -1645.01 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| short | TP1_1.25R_CAP_4PCT_TIME_10_MODE_50_50_TP2 | 23 | 60.9% | 1.283 | 986.35 USD | 3.195% | -3.874% | -0.268 | -734.63 USD | 9 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_CURRENT_CAP_NONE_TIME_15_MODE_TP1_ONLY | 93 | 41.9% | 0.56 | -8014.3 USD | 2.617% | -3.374% | 0.041 | 847.05 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_CURRENT_CAP_NONE_TIME_15_MODE_50_50_TP2 | 93 | 41.9% | 0.51 | -8925.42 USD | 2.384% | -3.374% | -0.009 | -64.07 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| medium | TP1_CURRENT_CAP_NONE_TIME_30_MODE_TP1_ONLY | 93 | 41.9% | 0.568 | -7950.23 USD | 2.682% | -3.409% | 0.049 | 911.12 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_CURRENT_CAP_NONE_TIME_30_MODE_50_50_TP2 | 93 | 41.9% | 0.519 | -8861.35 USD | 2.448% | -3.409% | 0 | 0 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_CURRENT_CAP_8PCT_TIME_15_MODE_TP1_ONLY | 93 | 40.9% | 0.527 | -8992.01 USD | 2.639% | -3.458% | 0.008 | -130.66 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_CURRENT_CAP_8PCT_TIME_15_MODE_50_50_TP2 | 93 | 40.9% | 0.491 | -9674.78 USD | 2.459% | -3.458% | -0.028 | -813.43 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_CURRENT_CAP_8PCT_TIME_30_MODE_TP1_ONLY | 93 | 40.9% | 0.535 | -8927.95 USD | 2.705% | -3.492% | 0.016 | -66.6 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_CURRENT_CAP_8PCT_TIME_30_MODE_50_50_TP2 | 93 | 40.9% | 0.5 | -9610.72 USD | 2.525% | -3.492% | -0.019 | -749.37 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_0.75R_CAP_NONE_TIME_15_MODE_TP1_ONLY | 93 | 41.9% | 0.516 | -8819.62 USD | 2.411% | -3.374% | -0.003 | 41.73 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_0.75R_CAP_NONE_TIME_15_MODE_50_50_TP2 | 93 | 41.9% | 0.527 | -8624.12 USD | 2.461% | -3.374% | 0.008 | 237.23 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_0.75R_CAP_NONE_TIME_30_MODE_TP1_ONLY | 93 | 41.9% | 0.524 | -8755.55 USD | 2.475% | -3.409% | 0.005 | 105.8 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_0.75R_CAP_NONE_TIME_30_MODE_50_50_TP2 | 93 | 41.9% | 0.523 | -8785.17 USD | 2.468% | -3.409% | 0.004 | 76.18 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_0.75R_CAP_8PCT_TIME_15_MODE_TP1_ONLY | 93 | 40.9% | 0.468 | -10114.01 USD | 2.344% | -3.458% | -0.051 | -1252.66 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_0.75R_CAP_8PCT_TIME_15_MODE_50_50_TP2 | 93 | 40.9% | 0.485 | -9793.69 USD | 2.428% | -3.458% | -0.034 | -932.34 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_0.75R_CAP_8PCT_TIME_30_MODE_TP1_ONLY | 93 | 40.9% | 0.47 | -10184.75 USD | 2.374% | -3.492% | -0.049 | -1323.4 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_0.75R_CAP_8PCT_TIME_30_MODE_50_50_TP2 | 93 | 40.9% | 0.498 | -9634.01 USD | 2.519% | -3.492% | -0.021 | -772.66 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_1.00R_CAP_NONE_TIME_15_MODE_TP1_ONLY | 93 | 41.9% | 0.528 | -8602.06 USD | 2.467% | -3.374% | 0.009 | 259.29 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_1.00R_CAP_NONE_TIME_15_MODE_50_50_TP2 | 93 | 41.9% | 0.537 | -8440.01 USD | 2.508% | -3.374% | 0.018 | 421.34 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_1.00R_CAP_NONE_TIME_30_MODE_TP1_ONLY | 93 | 41.9% | 0.536 | -8537.99 USD | 2.531% | -3.409% | 0.017 | 323.36 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_1.00R_CAP_NONE_TIME_30_MODE_50_50_TP2 | 93 | 41.9% | 0.539 | -8480.01 USD | 2.546% | -3.409% | 0.02 | 381.34 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_1.00R_CAP_8PCT_TIME_15_MODE_TP1_ONLY | 93 | 40.9% | 0.49 | -9703.2 USD | 2.452% | -3.458% | -0.029 | -841.85 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_1.00R_CAP_8PCT_TIME_15_MODE_50_50_TP2 | 93 | 40.9% | 0.5 | -9512.97 USD | 2.502% | -3.458% | -0.019 | -651.62 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| medium | TP1_1.00R_CAP_8PCT_TIME_30_MODE_TP1_ONLY | 93 | 40.9% | 0.498 | -9639.14 USD | 2.518% | -3.492% | -0.021 | -777.79 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | NO | NO |
| medium | TP1_1.00R_CAP_8PCT_TIME_30_MODE_50_50_TP2 | 93 | 40.9% | 0.503 | -9552.96 USD | 2.541% | -3.492% | -0.016 | -691.61 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| medium | TP1_1.25R_CAP_NONE_TIME_15_MODE_TP1_ONLY | 93 | 41.9% | 0.539 | -8391.43 USD | 2.521% | -3.374% | 0.02 | 469.92 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_1.25R_CAP_NONE_TIME_15_MODE_50_50_TP2 | 93 | 41.9% | 0.566 | -7913.51 USD | 2.643% | -3.374% | 0.047 | 947.84 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_1.25R_CAP_NONE_TIME_30_MODE_TP1_ONLY | 93 | 41.9% | 0.548 | -8327.37 USD | 2.585% | -3.409% | 0.029 | 533.98 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_1.25R_CAP_NONE_TIME_30_MODE_50_50_TP2 | 93 | 41.9% | 0.574 | -7849.45 USD | 2.708% | -3.409% | 0.055 | 1011.9 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_1.25R_CAP_8PCT_TIME_15_MODE_TP1_ONLY | 93 | 40.9% | 0.503 | -9446.84 USD | 2.519% | -3.458% | -0.016 | -585.49 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_1.25R_CAP_8PCT_TIME_15_MODE_50_50_TP2 | 93 | 40.9% | 0.505 | -9408.92 USD | 2.529% | -3.458% | -0.014 | -547.57 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| medium | TP1_1.25R_CAP_8PCT_TIME_30_MODE_TP1_ONLY | 93 | 40.9% | 0.512 | -9382.77 USD | 2.585% | -3.492% | -0.007 | -521.42 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | NO | NO |
| medium | TP1_1.25R_CAP_8PCT_TIME_30_MODE_50_50_TP2 | 93 | 40.9% | 0.513 | -9344.85 USD | 2.595% | -3.492% | -0.006 | -483.5 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_NONE_TIME_40_MODE_TP1_ONLY | 99 | 48.5% | 1.257 | 9728.05 USD | 9.902% | -7.413% | -0.848 | -37978.66 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_NONE_TIME_40_MODE_50_50_TP2 | 99 | 48.5% | 1.255 | 9621.5 USD | 9.88% | -7.413% | -0.85 | -38085.21 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_NONE_TIME_80_MODE_TP1_ONLY | 99 | 48.5% | 1.541 | 22196.95 USD | 13.169% | -8.042% | -0.564 | -25509.76 USD | 21 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_NONE_TIME_80_MODE_50_50_TP2 | 99 | 48.5% | 1.64 | 26235.07 USD | 14.01% | -8.042% | -0.465 | -21471.64 USD | 21 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_12PCT_TIME_40_MODE_TP1_ONLY | 99 | 47.5% | 1.269 | 10054.06 USD | 10.084% | -7.18% | -0.836 | -37652.65 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_12PCT_TIME_40_MODE_50_50_TP2 | 99 | 47.5% | 1.263 | 9805.64 USD | 10.031% | -7.18% | -0.842 | -37901.07 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_12PCT_TIME_80_MODE_TP1_ONLY | 99 | 46.5% | 1.44 | 18482.97 USD | 13.144% | -7.921% | -0.665 | -29223.74 USD | 22 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_CURRENT_CAP_12PCT_TIME_80_MODE_50_50_TP2 | 99 | 46.5% | 1.462 | 19415.66 USD | 13.347% | -7.921% | -0.643 | -28291.05 USD | 22 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_0.75R_CAP_NONE_TIME_40_MODE_TP1_ONLY | 99 | 55.6% | 1.227 | 7846.95 USD | 7.726% | -7.874% | -0.878 | -39859.76 USD | 29 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_0.75R_CAP_NONE_TIME_40_MODE_50_50_TP2 | 99 | 55.6% | 1.248 | 8591.2 USD | 7.861% | -7.874% | -0.857 | -39115.51 USD | 29 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_0.75R_CAP_NONE_TIME_80_MODE_TP1_ONLY | 99 | 60.6% | 1.686 | 23917.36 USD | 9.794% | -8.936% | -0.419 | -23789.35 USD | 24 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_0.75R_CAP_NONE_TIME_80_MODE_50_50_TP2 | 99 | 60.6% | 1.664 | 23154.54 USD | 9.667% | -8.936% | -0.441 | -24552.17 USD | 24 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_0.75R_CAP_12PCT_TIME_40_MODE_TP1_ONLY | 99 | 56.6% | 1.205 | 6710.98 USD | 7.058% | -7.631% | -0.9 | -40995.73 USD | 29 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_0.75R_CAP_12PCT_TIME_40_MODE_50_50_TP2 | 99 | 56.6% | 1.286 | 9373.39 USD | 7.533% | -7.631% | -0.819 | -38333.32 USD | 29 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_0.75R_CAP_12PCT_TIME_80_MODE_TP1_ONLY | 99 | 63.6% | 1.576 | 18462.33 USD | 8.022% | -8.909% | -0.529 | -29244.38 USD | 26 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_0.75R_CAP_12PCT_TIME_80_MODE_50_50_TP2 | 99 | 63.6% | 1.641 | 20554.32 USD | 8.354% | -8.909% | -0.464 | -27152.39 USD | 26 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_NONE_TIME_40_MODE_TP1_ONLY | 99 | 51.5% | 1.258 | 9477.38 USD | 9.066% | -7.658% | -0.847 | -38229.33 USD | 28 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_NONE_TIME_40_MODE_50_50_TP2 | 99 | 51.5% | 1.238 | 8763.81 USD | 8.926% | -7.658% | -0.867 | -38942.9 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_NONE_TIME_80_MODE_TP1_ONLY | 99 | 56.6% | 1.824 | 29548.95 USD | 11.682% | -8.342% | -0.281 | -18157.76 USD | 22 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_NONE_TIME_80_MODE_50_50_TP2 | 99 | 56.6% | 1.819 | 29377.92 USD | 11.652% | -8.342% | -0.286 | -18328.79 USD | 21 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_12PCT_TIME_40_MODE_TP1_ONLY | 99 | 52.5% | 1.267 | 9230.67 USD | 8.43% | -7.363% | -0.838 | -38476.04 USD | 29 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_12PCT_TIME_40_MODE_50_50_TP2 | 99 | 52.5% | 1.265 | 9175.7 USD | 8.42% | -7.363% | -0.84 | -38531.01 USD | 29 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_12PCT_TIME_80_MODE_TP1_ONLY | 99 | 59.6% | 1.828 | 27641.3 USD | 10.345% | -8.349% | -0.277 | -20065.41 USD | 24 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.00R_CAP_12PCT_TIME_80_MODE_50_50_TP2 | 99 | 59.6% | 1.791 | 26410.21 USD | 10.137% | -8.349% | -0.314 | -21296.5 USD | 24 | BH_STAGE2_POOLED_FAIL_0.05 | VIOLATES_TP1_RR | YES | NO |
| long | TP1_1.25R_CAP_NONE_TIME_40_MODE_TP1_ONLY | 99 | 48.5% | 1.248 | 9389.52 USD | 9.832% | -7.413% | -0.857 | -38317.19 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_1.25R_CAP_NONE_TIME_40_MODE_50_50_TP2 | 99 | 48.5% | 1.247 | 9338.57 USD | 9.821% | -7.413% | -0.858 | -38368.14 USD | 27 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_1.25R_CAP_NONE_TIME_80_MODE_TP1_ONLY | 99 | 49.5% | 1.656 | 25835.71 USD | 13.314% | -7.88% | -0.449 | -21871 USD | 21 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_1.25R_CAP_NONE_TIME_80_MODE_50_50_TP2 | 99 | 49.5% | 1.737 | 29042.16 USD | 13.968% | -7.88% | -0.368 | -18664.55 USD | 21 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_1.25R_CAP_12PCT_TIME_40_MODE_TP1_ONLY | 99 | 47.5% | 1.137 | 5100.61 USD | 9.03% | -7.18% | -0.968 | -42606.1 USD | 29 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_1.25R_CAP_12PCT_TIME_40_MODE_50_50_TP2 | 99 | 47.5% | 1.187 | 6979.42 USD | 9.429% | -7.18% | -0.918 | -40727.29 USD | 28 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_1.25R_CAP_12PCT_TIME_80_MODE_TP1_ONLY | 99 | 49.5% | 1.542 | 20717.67 USD | 12.034% | -7.65% | -0.563 | -26989.04 USD | 24 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |
| long | TP1_1.25R_CAP_12PCT_TIME_80_MODE_50_50_TP2 | 99 | 49.5% | 1.625 | 23921.46 USD | 12.688% | -7.65% | -0.48 | -23785.25 USD | 23 | BH_STAGE2_POOLED_FAIL_0.05 | OK | YES | NO |

Per-market Stage 2 metrics and baseline deltas are in the machine-readable `stage2.pooledByHorizon[*].markets` output.

## Japan long buy — win % versus PF
| Exit | Dev n | Dev win % | Dev PF | Dev PnL | Dev avg win/loss | Holdout n | Holdout win % | Holdout PF | Holdout PnL | Holdout avg win/loss | RR rule | BH |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Live exits | 58 | 50% | 1.817 | 23144.41 USD | 17.745% / -9.764% | 7 | 28.6% | 1.428 | 2176.56 USD | 36.327% / -10.178% | LIVE_TP1_RULE | BH_FAIL_0.05 |
| 1.25R / 12% / 80 / 50-50 TP2 | 59 | 50.8% | 1.411 | 9967.28 USD | 11.404% / -8.361% | 11 | 63.6% | 2.857 | 7423.8 USD | 16.315% / -9.992% | OK | BH_STAGE2_FAIL_0.05 |
| 1.00R / 12% / 80 / 50-50 TP2 | 59 | 59.3% | 1.644 | 13158.79 USD | 9.597% / -8.513% | 12 | 66.7% | 2.281 | 5121.4 USD | 11.398% / -9.992% | VIOLATES_TP1_RR | BH_STAGE2_FAIL_0.05 |
| 0.75R / 12% / 80 / 50-50 TP2 | 59 | 62.7% | 1.491 | 9624.33 USD | 7.899% / -8.91% | 14 | 71.4% | 2.318 | 5267.51 USD | 9.264% / -9.992% | VIOLATES_TP1_RR | BH_STAGE2_FAIL_0.05 |

## Explicit blocks

Machine-readable report: scripts\performance-program-v3-results.json

