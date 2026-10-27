# Cache-backed Performance Program Readout

Generated: 2026-10-01T08:36:34.690Z

## Outcome
Executed cells: 168; blocked cells: 0.
Full cached-universe run requested.
Primary uses decision-date FX normalization for currency mismatches and scales LSE GBp prices to GBP; Piotroski-only output remains non-promotable.
FX sources are loaded by each bounded worker from the local cache with retry.
This readout includes the execution requested for this run.
Stage 2 was not run; it remains gated on explicit Stage 1 review.

## Stage 1 geography × horizon × side summary
| Geography | Horizon | Side | Result / best passing config | Win % | PF | PnL | Confidence | Holdout | Coverage (full gate) | Basis |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| US | medium | buy | FAIL | 0% | 0 | -654.03 USD | INSUFFICIENT | 1 trades | 76.2% (535630/702667) | B; INSUFFICIENT_SAMPLE |
| US | medium | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 76.2% (535630/702667) | E; INSUFFICIENT_NO_HOLDOUT_TRADES |
| US | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 76.2% (535630/702667) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| US | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 76.2% (535630/702667) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Japan | medium | buy | FAIL | 41.2% | 1.179 | 483.09 USD | THIN | 17 trades | 44.1% (107020/242540) | B; EXECUTED |
| Japan | medium | sell | FAIL | 66.7% | 2.806 | 976.77 USD | INSUFFICIENT | 3 trades | 44.1% (107020/242540) | D; INSUFFICIENT_SAMPLE |
| Japan | long | buy | FAIL | 50% | 3.39 | 5122.58 USD | INSUFFICIENT | 4 trades | 44.1% (107020/242540) | D; INSUFFICIENT_SAMPLE |
| Japan | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 44.1% (107020/242540) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Hong Kong | medium | buy | FAIL | 100% | 99 | 1484.13 USD | INSUFFICIENT | 3 trades | 36.9% (27573/74677) | D; INSUFFICIENT_SAMPLE |
| Hong Kong | medium | sell | FAIL | 50% | 1.867 | 1290.98 USD | INSUFFICIENT | 10 trades | 36.9% (27573/74677) | B; INSUFFICIENT_SAMPLE |
| Hong Kong | long | buy | FAIL | 100% | 99 | 2350.11 USD | INSUFFICIENT | 1 trades | 36.9% (27573/74677) | D; INSUFFICIENT_SAMPLE |
| Hong Kong | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 36.9% (27573/74677) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | medium | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | medium | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| UK | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 32.7% (34331/105034) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Germany | medium | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) | B; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Germany | medium | sell | FAIL | 55.6% | 2.444 | 1797.47 USD | INSUFFICIENT | 9 trades | 70.6% (30594/43343) | D; INSUFFICIENT_SAMPLE |
| Germany | long | buy | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) | D; INSUFFICIENT_NO_HOLDOUT_TRADES |
| Germany | long | sell | FAIL | — | — | 0 USD | INSUFFICIENT | 0 trades | 70.6% (30594/43343) | E; INSUFFICIENT_NO_HOLDOUT_TRADES |
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
- B Japan medium buy PIO_ONLY_NON_PARITY: n=31, WR=45.2%, PF=0.877, PnL=-599.45 USD; holdout n=10; Part D BH=n/a
- B Japan medium buy PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY: n=48, WR=43.8%, PF=0.748, PnL=-1869.8 USD; holdout n=17; Part D BH=n/a
- B Japan medium sell PIO_ONLY_NON_PARITY: n=53, WR=18.9%, PF=0.204, PnL=-10206.16 USD; holdout n=8; Part D BH=n/a
- B Japan medium sell PIT_PIOTROSKI_PLUS_ALTMAN_EXACT_LIVE_OVERLAY: n=54, WR=18.5%, PF=0.196, PnL=-10726.78 USD; holdout n=8; Part D BH=n/a

## Stage 2 buy-only pooled exit grid
| Horizon | Variant | n | Win % | PF | PnL | Avg win | Avg loss | Δ PF | Δ PnL | Holdout n | BH | RR rule | Full-market harm | Recommended |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| — | No Stage 2 rows executed | — | — | — | — | — | — | — | — | — | — | — | — | — |

Per-market Stage 2 metrics and baseline deltas are in the machine-readable `stage2.pooledByHorizon[*].markets` output.

## Explicit blocks

Machine-readable report: scripts\performance-stage1-v2-results.json

