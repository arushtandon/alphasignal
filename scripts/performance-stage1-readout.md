# Cache-backed Performance Program Readout

Generated: 2026-09-30T07:52:30.165Z

## Outcome
Executed cells: 144; blocked cells: 0.
Full cached-universe run requested.
Primary uses decision-date FX normalization for currency mismatches and scales LSE GBp prices to GBP; Piotroski-only output remains non-promotable.
FX sources are loaded by each bounded worker from the local cache with retry.
This readout was regenerated from completed Stage 1 checkpoint/worker outputs only; no symbol replay occurred.
Stage 2 was not run; it remains gated on explicit Stage 1 review.

## Stage 1 geography × horizon × side summary
| Geography | Horizon | Side | Result / best passing config | Win % | PF | PnL | Confidence | Holdout | Coverage (full gate) | Basis |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| US | medium | buy | FAIL | 100% | 99 | 836.62 USD | INSUFFICIENT | 2 trades | 75.2% (58068/77195) | B; INSUFFICIENT_SAMPLE |
| US | medium | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 75.2% (58068/77195) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| US | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 75.2% (58068/77195) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| US | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 75.2% (58068/77195) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Japan | medium | buy | FAIL | 42.9% | 1.934 | 714.42 USD | INSUFFICIENT | 7 trades | 44.1% (107019/242539) | D; INSUFFICIENT_SAMPLE |
| Japan | medium | sell | FAIL | 61.1% | 1.515 | 1618.26 USD | THIN | 18 trades | 44.1% (107019/242539) | B; EXECUTED |
| Japan | long | buy | FAIL | 0% | 0 | -1696.09 USD | INSUFFICIENT | 2 trades | 44.1% (107019/242539) | D; INSUFFICIENT_SAMPLE |
| Japan | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 44.1% (107019/242539) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Hong Kong | medium | buy | FAIL | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) | D; INSUFFICIENT_SAMPLE |
| Hong Kong | medium | sell | FAIL | 50% | 1.914 | 1327.95 USD | INSUFFICIENT | 10 trades | 36.9% (27573/74677) | B; INSUFFICIENT_SAMPLE |
| Hong Kong | long | buy | FAIL | 100% | 99 | 2350.11 USD | INSUFFICIENT | 1 trades | 36.9% (27573/74677) | D; INSUFFICIENT_SAMPLE |
| Hong Kong | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 36.9% (27573/74677) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | medium | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34330/105035) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | medium | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34330/105035) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34330/105035) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34330/105035) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Germany | medium | buy | FAIL | 50% | 0.373 | -545.24 USD | INSUFFICIENT | 2 trades | 70.6% (30594/43343) | D; INSUFFICIENT_SAMPLE |
| Germany | medium | sell | FAIL | 33.3% | 0.965 | -72.26 USD | INSUFFICIENT | 9 trades | 70.6% (30594/43343) | D; INSUFFICIENT_SAMPLE |
| Germany | long | buy | FAIL | 50% | 3.691 | 1115.91 USD | INSUFFICIENT | 2 trades | 70.6% (30594/43343) | B; INSUFFICIENT_SAMPLE |
| Germany | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) | E; INSUFFICIENT_NO_HOLDOUT_TRADES |
| France | medium | buy | FAIL | 100% | 99 | 270.74 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) | B; INSUFFICIENT_SAMPLE |
| France | medium | sell | FAIL | 75% | 5.756 | 287.17 USD | INSUFFICIENT | 4 trades | 45.9% (20929/45591) | D; INSUFFICIENT_SAMPLE |
| France | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| France | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |

A PASS requires the frozen Stage 1 promotion criteria and BH correction. FAIL rows show the deterministically highest-ranked evaluated primary-parity Stage 1 cell for context; they are not candidates.

## Stage 1 ranked configurations
| Rank | Result | Geography | Horizon | Side | Part | Config | Win % | PF | PnL | Confidence | Holdout | Coverage (full gate) |
| ---: | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 1 | FAIL | Hong Kong | long | buy | D | Piotroski>=7 | 100% | 99 | 2350.11 USD | INSUFFICIENT | 1 trades | 36.9% (27573/74677) |
| 2 | FAIL | Japan | medium | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 61.1% | 1.515 | 1618.26 USD | THIN | 18 trades | 44.1% (107019/242539) |
| 3 | FAIL | Hong Kong | long | buy | D | Piotroski>=5 | 50% | 3.053 | 1580.36 USD | INSUFFICIENT | 2 trades | 36.9% (27573/74677) |
| 4 | FAIL | Hong Kong | long | buy | D | Piotroski>=6 | 50% | 3.053 | 1580.36 USD | INSUFFICIENT | 2 trades | 36.9% (27573/74677) |
| 5 | FAIL | Hong Kong | medium | buy | D | Piotroski>=5 | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) |
| 6 | FAIL | Hong Kong | medium | buy | D | Piotroski>=6 | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) |
| 7 | FAIL | Hong Kong | medium | buy | D | Piotroski>=7 | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) |
| 8 | FAIL | Japan | medium | sell | D | Piotroski>=5 | 80% | 3.976 | 1375.58 USD | INSUFFICIENT | 5 trades | 44.1% (107019/242539) |
| 9 | FAIL | Hong Kong | medium | sell | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 50% | 1.914 | 1327.95 USD | INSUFFICIENT | 10 trades | 36.9% (27573/74677) |
| 10 | FAIL | Germany | long | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 50% | 3.691 | 1115.91 USD | INSUFFICIENT | 2 trades | 70.6% (30594/43343) |
| 11 | FAIL | Germany | long | buy | D | Piotroski>=5 | 50% | 3.691 | 1115.91 USD | INSUFFICIENT | 2 trades | 70.6% (30594/43343) |
| 12 | FAIL | Hong Kong | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 62.5% | 2.667 | 1009.59 USD | INSUFFICIENT | 8 trades | 36.9% (27573/74677) |
| 13 | FAIL | US | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 100% | 99 | 836.62 USD | INSUFFICIENT | 2 trades | 75.2% (58068/77195) |
| 14 | FAIL | Hong Kong | medium | sell | D | Piotroski>=5 | 50% | 3.224 | 716.92 USD | INSUFFICIENT | 2 trades | 36.9% (27573/74677) |
| 15 | FAIL | Japan | medium | buy | D | Piotroski>=7 | 42.9% | 1.934 | 714.42 USD | INSUFFICIENT | 7 trades | 44.1% (107019/242539) |
| 16 | FAIL | US | medium | buy | D | Piotroski>=5 | 100% | 99 | 620.44 USD | INSUFFICIENT | 1 trades | 75.2% (58068/77195) |
| 17 | FAIL | US | medium | buy | D | Piotroski>=6 | 100% | 99 | 620.44 USD | INSUFFICIENT | 1 trades | 75.2% (58068/77195) |
| 18 | FAIL | Japan | medium | buy | D | Piotroski>=6 | 36.4% | 1.325 | 574.92 USD | INSUFFICIENT | 11 trades | 44.1% (107019/242539) |
| 19 | FAIL | France | medium | sell | D | Piotroski>=5 | 75% | 5.756 | 287.17 USD | INSUFFICIENT | 4 trades | 45.9% (20929/45591) |
| 20 | FAIL | France | medium | sell | D | Piotroski>=6 | 75% | 5.756 | 287.17 USD | INSUFFICIENT | 4 trades | 45.9% (20929/45591) |
| 21 | FAIL | France | medium | sell | D | Piotroski>=7 | 75% | 5.756 | 287.17 USD | INSUFFICIENT | 4 trades | 45.9% (20929/45591) |
| 22 | FAIL | France | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 100% | 99 | 270.74 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) |
| 23 | FAIL | France | medium | buy | D | Piotroski>=5 | 100% | 99 | 270.74 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) |
| 24 | FAIL | France | medium | buy | D | Piotroski>=6 | 100% | 99 | 270.74 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) |
| 25 | FAIL | France | medium | buy | D | Piotroski>=7 | 100% | 99 | 270.74 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) |
| 26 | FAIL | France | medium | sell | E | PIT_F_SCORE_LE_3 | 100% | 99 | 226.17 USD | INSUFFICIENT | 1 trades | 45.9% (20929/45591) |
| 27 | FAIL | Japan | medium | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | 29.4% | 1.042 | 108.23 USD | THIN | 17 trades | 44.1% (107019/242539) |
| 28 | FAIL | Japan | medium | buy | D | Piotroski>=5 | 30.8% | 1.006 | 14.78 USD | INSUFFICIENT | 13 trades | 44.1% (107019/242539) |
| 29 | FAIL | France | long | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 45.9% (20929/45591) |
| 30 | FAIL | UK | long | buy | B | PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34330/105035) |

## Best configuration
No forward candidate qualified.

## Explicit blocks

Machine-readable report: scripts\performance-stage1-results.json

