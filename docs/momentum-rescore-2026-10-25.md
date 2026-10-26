# Momentum re-score under current standards — 2026-10-25

Research only. No live signal, setup-book cell, flag, bracket, order, or deployment setting changed.

## What is live

- `UK_LONG_MOMENTUM`: plain 12-1 momentum, k=1 (one new name a month, six-month hold, six slots, $30,000 tickets), no Piotroski screen, Experimental. `FRANCE_LONG_MOMENTUM` is the same design and is paused.
- The US long Piotroski ≥ 6 book is **not** enabled. `docs/us-long-piotroski-paper-design.md` is a paper design; no cell, flag, tag, or order exists for it.

Standards: docs/strategy-gaps-amendment-2026-10-06.md (ever-member universe, PIT Piotroski filing+45d, monthly excess t, alpha t, k=1/k=2, QQQ hurdle).

Pass rule — VALIDATION_PASS: every window with trades profitable with PF ≥ 1.2; full sample beats benchmark; monthly excess t ≥ 3; alpha t ≥ 2 (US: SPY+QQQ two-factor; UK: EWU); US must beat QQQ. INCUBATION_ELIGIBLE: positive full-sample net excess; ≥ 3 of 4 windows positive; excess t ≥ 1.5; max DD < 50%. Deflated Sharpe is over the 12 excess-return series scored here.

Mechanics: signal at the month-end close, enter the next open, re-mark at each later first-session open. Research book = top 10 equal weight (long: six overlapping sleeves). k=1 / k=2 = top k names not already held, $30,000 tickets, real lot sizing, empty slots earn 0. Costs through implementation-cost-v1 at entry (UK: 50 bps stamp on the buy).

## Summary

| Book | Variant | Verdict | Months | Full | Benchmark | Excess pp | Excess t | Alpha ann. | Alpha t | Beta | Max DD | Bench DD | Windows (+ / 4) | Trades | WR | PF | DSR p |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `US__long__12-1__piotroski6` | research | INCUBATION_ELIGIBLE | 152 | 701.9% | 329.49% | 372.41 | 1.69 | 3.04% | 0.83 | 0.75/0.33 | 25.79% | 24.19% | 3 | 1470 | 60.5% | 2.768 | 0.568 |
| `US__long__12-1__piotroski6` | k1 | INCUBATION_ELIGIBLE | 152 | 1295.15% | 329.49% | 965.66 | 2.17 | 5.93% | 1.07 | 0.77/0.48 | 28.8% | 24.19% | 3 | 147 | 63.3% | 3.393 | 0.743 |
| `US__long__12-1__piotroski6` | k2 | FAIL | 152 | 625.38% | 329.49% | 295.89 | 1.38 | 2.21% | 0.53 | 0.95/0.22 | 30.47% | 24.19% | 4 | 294 | 61.9% | 2.519 | 0.447 |
| `UK__long__12-1__piotroski6` | research | FAIL | 200 | 114.27% | 48.49% | 65.79 | 0.61 | 3.26% | 1.41 | 0.59 | 32.8% | 47.02% | 3 | 1665 | 54.4% | 1.518 | 0.131 |
| `UK__long__12-1__piotroski6` | k1 | FAIL | 200 | 230.66% | 48.49% | 182.17 | 1.31 | 6.2% | 2.3 | 0.52 | 27.59% | 47.02% | 4 | 183 | 55.7% | 1.982 | 0.336 |
| `UK__long__12-1__piotroski6` | k2 | FAIL | 200 | 63.86% | 48.49% | 15.37 | -0.04 | 1.78% | 0.84 | 0.5 | 30.23% | 47.02% | 3 | 332 | 53.6% | 1.333 | 0.038 |
| `UK__long__12-1__plain` | research | FAIL | 200 | 226.18% | 48.49% | 177.69 | 1.27 | 6.24% | 2.06 | 0.54 | 25.05% | 47.02% | 4 | 1840 | 56.8% | 1.825 | 0.324 |
| `UK__long__12-1__plain` | k1 | INCUBATION_ELIGIBLE | 200 | 567.58% | 48.49% | 519.09 | 2.12 | 11.11% | 2.75 | 0.55 | 27.13% | 47.02% | 4 | 184 | 63% | 2.496 | 0.642 |
| `UK__long__12-1__plain` | k2 | FAIL | 200 | 273.91% | 48.49% | 225.43 | 1.48 | 7.1% | 2.31 | 0.53 | 27.16% | 47.02% | 4 | 368 | 58.4% | 1.923 | 0.4 |
| `UK__medium__12-1__plain` | research | FAIL | 200 | -27.34% | 48.49% | -75.82 | -1.1 | -2.42% | -0.71 | 0.48 | 63.91% | 47.02% | 3 | 1890 | 48.8% | 0.983 | 0.002 |
| `UK__medium__12-1__plain` | k1 | FAIL | 200 | 3.83% | 48.49% | -44.66 | 0.37 | 4.59% | 0.52 | 0.66 | 91.27% | 47.02% | 2 | 189 | 51.3% | 1.18 | 0.083 |
| `UK__medium__12-1__plain` | k2 | FAIL | 200 | 9.9% | 48.49% | -38.59 | 0.12 | 2.27% | 0.35 | 0.61 | 75.92% | 47.02% | 3 | 378 | 49.2% | 1.119 | 0.052 |
| `UK__medium__12-1__plain__currentSymbols` | research | FAIL | 200 | 2.39% | 48.49% | -46.1 | -0.6 | -0.46% | -0.14 | 0.51 | 54.36% | 47.02% | 3 | 1890 | 49.6% | 1.046 | 0.009 |
| `UK__medium__12-1__plain__currentSymbols` | k1 | FAIL | 200 | 47.47% | 48.49% | -1.02 | 0.58 | 6.3% | 0.74 | 0.66 | 87.58% | 47.02% | 2 | 189 | 53.4% | 1.24 | 0.118 |
| `UK__medium__12-1__plain__currentSymbols` | k2 | FAIL | 200 | 47.98% | 48.49% | -0.51 | 0.34 | 3.85% | 0.61 | 0.57 | 75.22% | 47.02% | 3 | 378 | 50.8% | 1.167 | 0.08 |

## US__long__12-1__piotroski6

12-1 momentum among point-in-time Piotroski ≥ 6, top 10, six-month hold in six sleeves. Cell: US long. Not live. docs/us-long-piotroski-paper-design.md is a paper design only; no setup-book cell, flag, or order exists.

Universe (ever-members): ever-members 809, current 517, former 292 (126 with a price file). Candidates 809, priced 623, with dated statements 479 (former members with statements: 88).

Prior rows superseded: B__US__long__piotroski6__regimeoff (new-strategy-types PASS); B__US__long__piotroski6__regimeoff__longsample (amendment CANDIDATE).

| Year | Members | With prices | Missing |
| --- | ---: | ---: | ---: |
| 2014 | 510 | 386 | 124 |
| 2015 | 509 | 401 | 108 |
| 2016 | 511 | 421 | 90 |
| 2017 | 507 | 432 | 75 |
| 2018 | 506 | 445 | 61 |
| 2019 | 510 | 457 | 53 |
| 2020 | 511 | 466 | 45 |
| 2021 | 508 | 470 | 38 |
| 2022 | 509 | 480 | 29 |
| 2023 | 510 | 486 | 24 |
| 2024 | 512 | 491 | 21 |
| 2025 | 515 | 499 | 16 |
| 2026 | 517 | 497 | 20 |

### research — INCUBATION_ELIGIBLE

Fails on: windows: -1.23%/PF 3.829, 38.6%/PF 4.511, 4.36%/PF 1.983, 32.31%/PF 12.052; excess t 1.69 < 3; alpha t 0.83 < 2; does not beat QQQ.

Sample 2014-03-03 → 2026-10-01, 152 months. Full 701.9% vs benchmark 329.49% (excess 372.41 pp). Max DD 25.79% vs 24.19%. Monthly excess t 1.69 (n 152, mean 0.5%/month). Alpha 3.04% ann., t 0.83 (SPY+QQQ). Trades 1470, WR 60.5%, PF 2.768, median names 10, early exits 0. Deflated excess Sharpe p 0.568.

QQQ hurdle: QQQ 762.28% (book minus QQQ -60.38 pp), QQQ max DD 32.68%, book Sharpe 0.26 vs QQQ 0.29, beats QQQ: false. Per window vs QQQ: 1: 0.01 pp, 2: 10.81 pp, 3: 6.99 pp, 4: 4.62 pp. SPY-only alpha 4.52% (t 1.24, beta 1.12).

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | -1.23% | -0.54% | -0.7 | 70 | 68.6% | 3.829 | 12.78% |
| 2 | 2025-04-03 | 2025-10-02 | 38.6% | 18.96% | 19.63 | 60 | 71.7% | 4.511 | 0.63% |
| 3 | 2025-10-03 | 2026-04-06 | 4.36% | -1.4% | 5.76 | 60 | 55% | 1.983 | 4.26% |
| 4 | 2026-04-07 | 2026-10-05 | 32.31% | 16.89% | 15.42 | 60 | 76.7% | 12.052 | 15.95% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2014 | 4.35% | 15.97% |
| 2015 | 5.78% | 1.47% |
| 2016 | 2.49% | 5.39% |
| 2017 | 25.47% | 19.95% |
| 2018 | 2.31% | 5.86% |
| 2019 | 2.4% | 12.24% |
| 2020 | 45.27% | 16.21% |
| 2021 | 31.59% | 26.28% |
| 2022 | 13.17% | -11.45% |
| 2023 | -4.31% | 11.5% |
| 2024 | 56.05% | 32.3% |
| 2025 | 15.89% | 12.58% |
| 2026 | 44.03% | 12.6% |

### k1 — INCUBATION_ELIGIBLE

Fails on: windows: -2.98%/PF 9.328, 57.82%/PF 6.498, 13.95%/PF 2.052, 43.07%/PF ∞; excess t 2.17 < 3; alpha t 1.07 < 2.

Sample 2014-03-03 → 2026-10-01, 152 months. Full 1295.15% vs benchmark 329.49% (excess 965.66 pp). Max DD 28.8% vs 24.19%. Monthly excess t 2.17 (n 152, mean 0.99%/month). Alpha 5.93% ann., t 1.07 (SPY+QQQ). Trades 147, WR 63.3%, PF 3.393, median names 1, early exits 0. Deflated excess Sharpe p 0.743.

QQQ hurdle: QQQ 762.28% (book minus QQQ 532.87 pp), QQQ max DD 32.68%, book Sharpe 0.26 vs QQQ 0.29, beats QQQ: true. Per window vs QQQ: 1: -1.74 pp, 2: 30.02 pp, 3: 16.58 pp, 4: 15.38 pp. SPY-only alpha 8.09% (t 1.47, beta 1.3).

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | -2.98% | -0.54% | -2.44 | 7 | 85.7% | 9.328 | 20.03% |
| 2 | 2025-04-03 | 2025-10-02 | 57.82% | 18.96% | 38.85 | 6 | 83.3% | 6.498 | 0% |
| 3 | 2025-10-03 | 2026-04-06 | 13.95% | -1.4% | 15.35 | 6 | 33.3% | 2.052 | 8.62% |
| 4 | 2026-04-07 | 2026-10-05 | 43.07% | 16.89% | 26.18 | 6 | 100% | ∞ | 21.65% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2014 | 13.25% | 15.97% |
| 2015 | 6.73% | 1.47% |
| 2016 | 12.69% | 5.39% |
| 2017 | 12.2% | 19.95% |
| 2018 | 4.37% | 5.86% |
| 2019 | 4.19% | 12.24% |
| 2020 | 54.88% | 16.21% |
| 2021 | 33.11% | 26.28% |
| 2022 | 20.52% | -11.45% |
| 2023 | -12.04% | 11.5% |
| 2024 | 86.7% | 32.3% |
| 2025 | 15.33% | 12.58% |
| 2026 | 78.41% | 12.6% |

### k2 — FAIL

Fails on: excess t 1.38 < 3; alpha t 0.53 < 2; does not beat QQQ.

Sample 2014-03-03 → 2026-10-01, 152 months. Full 625.38% vs benchmark 329.49% (excess 295.89 pp). Max DD 30.47% vs 24.19%. Monthly excess t 1.38 (n 152, mean 0.47%/month). Alpha 2.21% ann., t 0.53 (SPY+QQQ). Trades 294, WR 61.9%, PF 2.519, median names 2, early exits 0. Deflated excess Sharpe p 0.447.

QQQ hurdle: QQQ 762.28% (book minus QQQ -136.9 pp), QQQ max DD 32.68%, book Sharpe 0.23 vs QQQ 0.29, beats QQQ: false. Per window vs QQQ: 1: 1.26 pp, 2: 11.35 pp, 3: 21.13 pp, 4: 4.59 pp. SPY-only alpha 3.2% (t 0.77, beta 1.19).

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 0.02% | -0.54% | 0.55 | 14 | 78.6% | 7.532 | 13.98% |
| 2 | 2025-04-03 | 2025-10-02 | 39.15% | 18.96% | 20.18 | 12 | 66.7% | 5.128 | 0.27% |
| 3 | 2025-10-03 | 2026-04-06 | 18.51% | -1.4% | 19.9 | 12 | 66.7% | 3.272 | 4.3% |
| 4 | 2026-04-07 | 2026-10-05 | 32.29% | 16.89% | 15.39 | 12 | 75% | 16.622 | 15.01% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2014 | 0.18% | 15.97% |
| 2015 | 11.95% | 1.47% |
| 2016 | 2.56% | 5.39% |
| 2017 | 10.62% | 19.95% |
| 2018 | -5.72% | 5.86% |
| 2019 | 8.98% | 12.24% |
| 2020 | 23.28% | 16.21% |
| 2021 | 42.12% | 26.28% |
| 2022 | 12.8% | -11.45% |
| 2023 | -6.59% | 11.5% |
| 2024 | 60.16% | 32.3% |
| 2025 | 15.4% | 12.58% |
| 2026 | 62.61% | 12.6% |

## UK__long__12-1__piotroski6

12-1 momentum among point-in-time Piotroski ≥ 6, top 10, six-month hold in six sleeves. Cell: UK long. Not live. The live UK_LONG_MOMENTUM is plain 12-1, k=1, no Piotroski screen.

Universe (ever-members): ever-members 197, current 100, former 97 (32 with a price file). Candidates 197, priced 131, with dated statements 30 (former members with statements: 3).

Prior rows superseded: B__UK__long__piotroski6__regimeoff (new-strategy-types PASS, current constituents).

| Year | Members | With prices | Missing |
| --- | ---: | ---: | ---: |
| 2010 | 102 | 69 | 33 |
| 2011 | 102 | 71 | 31 |
| 2012 | 102 | 72 | 30 |
| 2013 | 103 | 78 | 25 |
| 2014 | 103 | 79 | 24 |
| 2015 | 103 | 80 | 23 |
| 2016 | 104 | 80 | 24 |
| 2017 | 104 | 81 | 23 |
| 2018 | 104 | 88 | 16 |
| 2019 | 102 | 85 | 17 |
| 2020 | 101 | 87 | 14 |
| 2021 | 101 | 87 | 14 |
| 2022 | 99 | 92 | 7 |
| 2023 | 99 | 95 | 4 |
| 2024 | 98 | 95 | 3 |
| 2025 | 99 | 98 | 1 |
| 2026 | 100 | 100 | 0 |

### research — FAIL

Fails on: windows: 8.65%/PF 2.078, 12.4%/PF 6.657, 9.24%/PF 5.474, -0.78%/PF 1.201; excess t 0.61 < 3; alpha t 1.41 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 114.27% vs benchmark 48.49% (excess 65.79 pp). Max DD 32.8% vs 47.02%. Monthly excess t 0.61 (n 200, mean 0.14%/month). Alpha 3.26% ann., t 1.41 (EWU). Trades 1665, WR 54.4%, PF 1.518, median names 10, early exits 0. Deflated excess Sharpe p 0.131.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 8.65% | 0.83% | 7.82 | 70 | 55.7% | 2.078 | 3.44% |
| 2 | 2025-04-03 | 2025-10-02 | 12.4% | 13.24% | -0.84 | 60 | 61.7% | 6.657 | 0% |
| 3 | 2025-10-03 | 2026-04-06 | 9.24% | 8.6% | 0.63 | 55 | 70.9% | 5.474 | 4.2% |
| 4 | 2026-04-07 | 2026-10-05 | -0.78% | 0.11% | -0.89 | 60 | 53.3% | 1.201 | 2.49% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | 1.29% | -0.55% |
| 2012 | 2.8% | 8.35% |
| 2013 | 14.23% | 14.86% |
| 2014 | -5.68% | -6.61% |
| 2015 | 2.26% | -9.39% |
| 2016 | -4.05% | -12.74% |
| 2017 | 13.22% | 15.89% |
| 2018 | -4.17% | -9.13% |
| 2019 | 3.66% | 3.59% |
| 2020 | -10.22% | -12.35% |
| 2021 | 18.25% | 12.6% |
| 2022 | 4.53% | -1.57% |
| 2023 | -2.16% | 1.69% |
| 2024 | 23.33% | 10.1% |
| 2025 | 22.19% | 20.72% |
| 2026 | 5.79% | 6.83% |

### k1 — FAIL

Fails on: windows: 13.7%/PF 3.455, 8.78%/PF 2.706, 2.76%/PF 4.146, 1.81%/PF 0.73; excess t 1.31 < 3.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 230.66% vs benchmark 48.49% (excess 182.17 pp). Max DD 27.59% vs 47.02%. Monthly excess t 1.31 (n 200, mean 0.36%/month). Alpha 6.2% ann., t 2.3 (EWU). Trades 183, WR 55.7%, PF 1.982, median names 1, early exits 0. Deflated excess Sharpe p 0.336.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 13.7% | 0.83% | 12.87 | 7 | 71.4% | 3.455 | 5.27% |
| 2 | 2025-04-03 | 2025-10-02 | 8.78% | 13.24% | -4.46 | 6 | 33.3% | 2.706 | 0.51% |
| 3 | 2025-10-03 | 2026-04-06 | 2.76% | 8.6% | -5.85 | 6 | 50% | 4.146 | 11.03% |
| 4 | 2026-04-07 | 2026-10-05 | 1.81% | 0.11% | 1.7 | 6 | 33.3% | 0.73 | 1.84% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | 5.67% | -0.55% |
| 2012 | 8.67% | 8.35% |
| 2013 | 16.03% | 14.86% |
| 2014 | -3.87% | -6.61% |
| 2015 | 12.21% | -9.39% |
| 2016 | -14.76% | -12.74% |
| 2017 | 16.43% | 15.89% |
| 2018 | -4.03% | -9.13% |
| 2019 | 2.99% | 3.59% |
| 2020 | -2.09% | -12.35% |
| 2021 | 16.84% | 12.6% |
| 2022 | 18.48% | -1.57% |
| 2023 | 2.49% | 1.69% |
| 2024 | 42.05% | 10.1% |
| 2025 | 13.55% | 20.72% |
| 2026 | 4.67% | 6.83% |

### k2 — FAIL

Fails on: windows: 10.22%/PF 2.273, 9.51%/PF 1.871, 5.74%/PF 7.587, -2.24%/PF 0.712; excess t -0.04 < 3; alpha t 0.84 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 63.86% vs benchmark 48.49% (excess 15.37 pp). Max DD 30.23% vs 47.02%. Monthly excess t -0.04 (n 200, mean -0.01%/month). Alpha 1.78% ann., t 0.84 (EWU). Trades 332, WR 53.6%, PF 1.333, median names 2, early exits 0. Deflated excess Sharpe p 0.038.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 10.22% | 0.83% | 9.39 | 14 | 64.3% | 2.273 | 3.05% |
| 2 | 2025-04-03 | 2025-10-02 | 9.51% | 13.24% | -3.73 | 12 | 41.7% | 1.871 | 1.19% |
| 3 | 2025-10-03 | 2026-04-06 | 5.74% | 8.6% | -2.86 | 11 | 72.7% | 7.587 | 3.98% |
| 4 | 2026-04-07 | 2026-10-05 | -2.24% | 0.11% | -2.35 | 12 | 50% | 0.712 | 3.08% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | 1.43% | -0.55% |
| 2012 | 0.71% | 8.35% |
| 2013 | 6.39% | 14.86% |
| 2014 | -5.96% | -6.61% |
| 2015 | 7.63% | -9.39% |
| 2016 | -6.62% | -12.74% |
| 2017 | 13.94% | 15.89% |
| 2018 | -1.19% | -9.13% |
| 2019 | -0.83% | 3.59% |
| 2020 | -7.48% | -12.35% |
| 2021 | 3.42% | 12.6% |
| 2022 | 4.46% | -1.57% |
| 2023 | -4.5% | 1.69% |
| 2024 | 25.34% | 10.1% |
| 2025 | 18.72% | 20.72% |
| 2026 | 0.59% | 6.83% |

## UK__long__12-1__plain

Plain 12-1 momentum, top 10, six-month hold in six sleeves (the live UK_LONG_MOMENTUM definition; k=1 row is the live book). Cell: UK long. LIVE as UK_LONG_MOMENTUM at k=1 (Experimental).

Universe (ever-members): ever-members 197, current 100, former 97 (32 with a price file). Candidates 197, priced 131.

Prior rows superseded: UK__long__k1 (executable-momentum 2026-10-06); docs/momentum-check-2026-10-07.md.

| Year | Members | With prices | Missing |
| --- | ---: | ---: | ---: |
| 2010 | 102 | 69 | 33 |
| 2011 | 102 | 71 | 31 |
| 2012 | 102 | 72 | 30 |
| 2013 | 103 | 78 | 25 |
| 2014 | 103 | 79 | 24 |
| 2015 | 103 | 80 | 23 |
| 2016 | 104 | 80 | 24 |
| 2017 | 104 | 81 | 23 |
| 2018 | 104 | 88 | 16 |
| 2019 | 102 | 85 | 17 |
| 2020 | 101 | 87 | 14 |
| 2021 | 101 | 87 | 14 |
| 2022 | 99 | 92 | 7 |
| 2023 | 99 | 95 | 4 |
| 2024 | 98 | 95 | 3 |
| 2025 | 99 | 98 | 1 |
| 2026 | 100 | 100 | 0 |

### research — FAIL

Fails on: excess t 1.27 < 3.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 226.18% vs benchmark 48.49% (excess 177.69 pp). Max DD 25.05% vs 47.02%. Monthly excess t 1.27 (n 200, mean 0.38%/month). Alpha 6.24% ann., t 2.06 (EWU). Trades 1840, WR 56.8%, PF 1.825, median names 10, early exits 0. Deflated excess Sharpe p 0.324.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 6.42% | 0.83% | 5.58 | 70 | 61.4% | 1.539 | 6.36% |
| 2 | 2025-04-03 | 2025-10-02 | 32.85% | 13.24% | 19.61 | 60 | 81.7% | 10.427 | 0% |
| 3 | 2025-10-03 | 2026-04-06 | 16.56% | 8.6% | 7.96 | 60 | 85% | 27.712 | 7.62% |
| 4 | 2026-04-07 | 2026-10-05 | 2.2% | 0.11% | 2.09 | 60 | 55% | 1.653 | 6.22% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -6.24% | -0.55% |
| 2012 | 16.73% | 8.35% |
| 2013 | 33.05% | 14.86% |
| 2014 | 7.1% | -6.61% |
| 2015 | 5.69% | -9.39% |
| 2016 | -7.89% | -12.74% |
| 2017 | 13.81% | 15.89% |
| 2018 | -3.04% | -9.13% |
| 2019 | 10.87% | 3.59% |
| 2020 | -1.49% | -12.35% |
| 2021 | -0.88% | 12.6% |
| 2022 | -7.75% | -1.57% |
| 2023 | 4.41% | 1.69% |
| 2024 | 13.5% | 10.1% |
| 2025 | 45.36% | 20.72% |
| 2026 | 13.17% | 6.83% |

### k1 — INCUBATION_ELIGIBLE

Fails on: windows: 3.37%/PF 1.013, 52.72%/PF ∞, 22.18%/PF ∞, 0.89%/PF 2.643; excess t 2.12 < 3.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 567.58% vs benchmark 48.49% (excess 519.09 pp). Max DD 27.13% vs 47.02%. Monthly excess t 2.12 (n 200, mean 0.78%/month). Alpha 11.11% ann., t 2.75 (EWU). Trades 184, WR 63%, PF 2.496, median names 1, early exits 0. Deflated excess Sharpe p 0.642.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 3.37% | 0.83% | 2.54 | 7 | 57.1% | 1.013 | 10.38% |
| 2 | 2025-04-03 | 2025-10-02 | 52.72% | 13.24% | 39.48 | 6 | 100% | ∞ | 0.16% |
| 3 | 2025-10-03 | 2026-04-06 | 22.18% | 8.6% | 13.58 | 6 | 100% | ∞ | 9.33% |
| 4 | 2026-04-07 | 2026-10-05 | 0.89% | 0.11% | 0.78 | 6 | 50% | 2.643 | 11.28% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -2.33% | -0.55% |
| 2012 | 22.67% | 8.35% |
| 2013 | 49% | 14.86% |
| 2014 | 8.19% | -6.61% |
| 2015 | 10.1% | -9.39% |
| 2016 | 17.33% | -12.74% |
| 2017 | 10.19% | 15.89% |
| 2018 | 1.45% | -9.13% |
| 2019 | 9.79% | 3.59% |
| 2020 | 2.19% | -12.35% |
| 2021 | -10.86% | 12.6% |
| 2022 | 3.32% | -1.57% |
| 2023 | 5.29% | 1.69% |
| 2024 | 8.96% | 10.1% |
| 2025 | 68.5% | 20.72% |
| 2026 | 19.81% | 6.83% |

### k2 — FAIL

Fails on: excess t 1.48 < 3.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 273.91% vs benchmark 48.49% (excess 225.43 pp). Max DD 27.16% vs 47.02%. Monthly excess t 1.48 (n 200, mean 0.44%/month). Alpha 7.1% ann., t 2.31 (EWU). Trades 368, WR 58.4%, PF 1.923, median names 2, early exits 0. Deflated excess Sharpe p 0.4.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 2.08% | 0.83% | 1.24 | 14 | 64.3% | 1.632 | 7.36% |
| 2 | 2025-04-03 | 2025-10-02 | 37.6% | 13.24% | 24.36 | 12 | 91.7% | 72.198 | 0% |
| 3 | 2025-10-03 | 2026-04-06 | 16.56% | 8.6% | 7.95 | 12 | 91.7% | 14.159 | 7.37% |
| 4 | 2026-04-07 | 2026-10-05 | 7.19% | 0.11% | 7.09 | 12 | 66.7% | 5.338 | 4.63% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -8.6% | -0.55% |
| 2012 | 17.61% | 8.35% |
| 2013 | 35.79% | 14.86% |
| 2014 | 9.24% | -6.61% |
| 2015 | 9.87% | -9.39% |
| 2016 | 2.96% | -12.74% |
| 2017 | 10.91% | 15.89% |
| 2018 | -6.2% | -9.13% |
| 2019 | 6.69% | 3.59% |
| 2020 | 2.83% | -12.35% |
| 2021 | -3.28% | 12.6% |
| 2022 | -6.95% | -1.57% |
| 2023 | 0.71% | 1.69% |
| 2024 | 14.04% | 10.1% |
| 2025 | 48.07% | 20.72% |
| 2026 | 18.66% | 6.83% |

## UK__medium__12-1__plain

Plain 12-1 momentum, top 10, one-month hold, monthly rebalance. Cell: UK medium. Not live.

Universe (ever-members): ever-members 197, current 100, former 97 (32 with a price file). Candidates 197, priced 131.

Prior rows superseded: B__UK__medium__momentum__regimeoff (new-strategy-types CANDIDATE, current constituents).

| Year | Members | With prices | Missing |
| --- | ---: | ---: | ---: |
| 2010 | 102 | 69 | 33 |
| 2011 | 102 | 71 | 31 |
| 2012 | 102 | 72 | 30 |
| 2013 | 103 | 78 | 25 |
| 2014 | 103 | 79 | 24 |
| 2015 | 103 | 80 | 23 |
| 2016 | 104 | 80 | 24 |
| 2017 | 104 | 81 | 23 |
| 2018 | 104 | 88 | 16 |
| 2019 | 102 | 85 | 17 |
| 2020 | 101 | 87 | 14 |
| 2021 | 101 | 87 | 14 |
| 2022 | 99 | 92 | 7 |
| 2023 | 99 | 95 | 4 |
| 2024 | 98 | 95 | 3 |
| 2025 | 99 | 98 | 1 |
| 2026 | 100 | 100 | 0 |

### research — FAIL

Fails on: windows: 9.01%/PF 1.492, 31.82%/PF 4.641, 12.53%/PF 1.571, -4.36%/PF 0.858; full sample does not beat benchmark; excess t -1.1 < 3; alpha t -0.71 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full -27.34% vs benchmark 48.49% (excess -75.82 pp). Max DD 63.91% vs 47.02%. Monthly excess t -1.1 (n 200, mean -0.37%/month). Alpha -2.42% ann., t -0.71 (EWU). Trades 1890, WR 48.8%, PF 0.983, median names 10, early exits 0. Deflated excess Sharpe p 0.002.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 9.01% | 0.83% | 8.17 | 70 | 61.4% | 1.492 | 5.37% |
| 2 | 2025-04-03 | 2025-10-02 | 31.82% | 13.24% | 18.58 | 60 | 65% | 4.641 | 0% |
| 3 | 2025-10-03 | 2026-04-06 | 12.53% | 8.6% | 3.93 | 60 | 53.3% | 1.571 | 8.62% |
| 4 | 2026-04-07 | 2026-10-05 | -4.36% | 0.11% | -4.47 | 60 | 43.3% | 0.858 | 9.72% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -17.84% | -0.55% |
| 2012 | 4.61% | 8.35% |
| 2013 | 20.22% | 14.86% |
| 2014 | -2.53% | -6.61% |
| 2015 | -2.68% | -9.39% |
| 2016 | 3.46% | -12.74% |
| 2017 | -2.42% | 15.89% |
| 2018 | -16.1% | -9.13% |
| 2019 | -0.55% | 3.59% |
| 2020 | -19.25% | -12.35% |
| 2021 | -11.38% | 12.6% |
| 2022 | -21.48% | -1.57% |
| 2023 | -4.84% | 1.69% |
| 2024 | 3.64% | 10.1% |
| 2025 | 50.82% | 20.72% |
| 2026 | 5.31% | 6.83% |

### k1 — FAIL

Fails on: windows: -5.95%/PF 0.953, 85.08%/PF 7.573, 38.78%/PF 2.543, -25.23%/PF 0.26; full sample does not beat benchmark; excess t 0.37 < 3; alpha t 0.52 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 3.83% vs benchmark 48.49% (excess -44.66 pp). Max DD 91.27% vs 47.02%. Monthly excess t 0.37 (n 200, mean 0.27%/month). Alpha 4.59% ann., t 0.52 (EWU). Trades 189, WR 51.3%, PF 1.18, median names 1, early exits 0. Deflated excess Sharpe p 0.083.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | -5.95% | 0.83% | -6.79 | 7 | 85.7% | 0.953 | 26.14% |
| 2 | 2025-04-03 | 2025-10-02 | 85.08% | 13.24% | 71.84 | 6 | 66.7% | 7.573 | 6.17% |
| 3 | 2025-10-03 | 2026-04-06 | 38.78% | 8.6% | 30.18 | 6 | 50% | 2.543 | 20.38% |
| 4 | 2026-04-07 | 2026-10-05 | -25.23% | 0.11% | -25.34 | 6 | 33.3% | 0.26 | 27.28% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -16.17% | -0.55% |
| 2012 | 19.44% | 8.35% |
| 2013 | 34.15% | 14.86% |
| 2014 | -10.5% | -6.61% |
| 2015 | -5.55% | -9.39% |
| 2016 | 44.42% | -12.74% |
| 2017 | -13.87% | 15.89% |
| 2018 | -27.02% | -9.13% |
| 2019 | -9.09% | 3.59% |
| 2020 | -37.39% | -12.35% |
| 2021 | -34.31% | 12.6% |
| 2022 | -28.96% | -1.57% |
| 2023 | 30.31% | 1.69% |
| 2024 | 85.32% | 10.1% |
| 2025 | 65.71% | 20.72% |
| 2026 | -5.22% | 6.83% |

### k2 — FAIL

Fails on: windows: 5.61%/PF 1.36, 56.85%/PF 7.859, 16.94%/PF 1.66, -19.97%/PF 0.462; full sample does not beat benchmark; excess t 0.12 < 3; alpha t 0.35 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 9.9% vs benchmark 48.49% (excess -38.59 pp). Max DD 75.92% vs 47.02%. Monthly excess t 0.12 (n 200, mean 0.07%/month). Alpha 2.27% ann., t 0.35 (EWU). Trades 378, WR 49.2%, PF 1.119, median names 2, early exits 0. Deflated excess Sharpe p 0.052.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 5.61% | 0.83% | 4.78 | 14 | 64.3% | 1.36 | 17.13% |
| 2 | 2025-04-03 | 2025-10-02 | 56.85% | 13.24% | 43.61 | 12 | 66.7% | 7.859 | 2.46% |
| 3 | 2025-10-03 | 2026-04-06 | 16.94% | 8.6% | 8.33 | 12 | 50% | 1.66 | 18.58% |
| 4 | 2026-04-07 | 2026-10-05 | -19.97% | 0.11% | -20.07 | 12 | 33.3% | 0.462 | 25.56% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -15.42% | -0.55% |
| 2012 | 7.2% | 8.35% |
| 2013 | 39.84% | 14.86% |
| 2014 | -4.23% | -6.61% |
| 2015 | -1.72% | -9.39% |
| 2016 | 29.94% | -12.74% |
| 2017 | 2.52% | 15.89% |
| 2018 | -23.5% | -9.13% |
| 2019 | 3.4% | 3.59% |
| 2020 | -20.18% | -12.35% |
| 2021 | -22.95% | 12.6% |
| 2022 | -33.68% | -1.57% |
| 2023 | 15.22% | 1.69% |
| 2024 | 25.09% | 10.1% |
| 2025 | 68.9% | 20.72% |
| 2026 | -11.99% | 6.83% |

## UK__medium__12-1__plain__currentSymbols

Same book on the current-constituent universe (reconciliation row; not a candidate). Cell: UK medium. Reconciliation only.

Universe (current constituents only): ever-members 197, current 100, former 97 (32 with a price file). Candidates 100, priced 100.

| Year | Members | With prices | Missing |
| --- | ---: | ---: | ---: |
| 2010 | 102 | 69 | 33 |
| 2011 | 102 | 71 | 31 |
| 2012 | 102 | 72 | 30 |
| 2013 | 103 | 78 | 25 |
| 2014 | 103 | 79 | 24 |
| 2015 | 103 | 80 | 23 |
| 2016 | 104 | 80 | 24 |
| 2017 | 104 | 81 | 23 |
| 2018 | 104 | 88 | 16 |
| 2019 | 102 | 85 | 17 |
| 2020 | 101 | 87 | 14 |
| 2021 | 101 | 87 | 14 |
| 2022 | 99 | 92 | 7 |
| 2023 | 99 | 95 | 4 |
| 2024 | 98 | 95 | 3 |
| 2025 | 99 | 98 | 1 |
| 2026 | 100 | 100 | 0 |

### research — FAIL

Fails on: windows: 17.6%/PF 2.345, 31.82%/PF 4.641, 12.53%/PF 1.571, -4.36%/PF 0.858; full sample does not beat benchmark; excess t -0.6 < 3; alpha t -0.14 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 2.39% vs benchmark 48.49% (excess -46.1 pp). Max DD 54.36% vs 47.02%. Monthly excess t -0.6 (n 200, mean -0.19%/month). Alpha -0.46% ann., t -0.14 (EWU). Trades 1890, WR 49.6%, PF 1.046, median names 10, early exits 0. Deflated excess Sharpe p 0.009.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 17.6% | 0.83% | 16.77 | 70 | 62.9% | 2.345 | 4.22% |
| 2 | 2025-04-03 | 2025-10-02 | 31.82% | 13.24% | 18.58 | 60 | 65% | 4.641 | 0% |
| 3 | 2025-10-03 | 2026-04-06 | 12.53% | 8.6% | 3.93 | 60 | 53.3% | 1.571 | 8.62% |
| 4 | 2026-04-07 | 2026-10-05 | -4.36% | 0.11% | -4.47 | 60 | 43.3% | 0.858 | 9.72% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -17.18% | -0.55% |
| 2012 | 5.65% | 8.35% |
| 2013 | 15.4% | 14.86% |
| 2014 | -1.79% | -6.61% |
| 2015 | -3.24% | -9.39% |
| 2016 | 8.16% | -12.74% |
| 2017 | 0.04% | 15.89% |
| 2018 | -13.8% | -9.13% |
| 2019 | -0.82% | 3.59% |
| 2020 | -20.1% | -12.35% |
| 2021 | -3.51% | 12.6% |
| 2022 | -14.7% | -1.57% |
| 2023 | -2.42% | 1.69% |
| 2024 | 13.18% | 10.1% |
| 2025 | 50.82% | 20.72% |
| 2026 | 5.31% | 6.83% |

### k1 — FAIL

Fails on: windows: -5.95%/PF 0.953, 85.08%/PF 7.573, 38.78%/PF 2.543, -25.23%/PF 0.26; full sample does not beat benchmark; excess t 0.58 < 3; alpha t 0.74 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 47.47% vs benchmark 48.49% (excess -1.02 pp). Max DD 87.58% vs 47.02%. Monthly excess t 0.58 (n 200, mean 0.42%/month). Alpha 6.3% ann., t 0.74 (EWU). Trades 189, WR 53.4%, PF 1.24, median names 1, early exits 0. Deflated excess Sharpe p 0.118.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | -5.95% | 0.83% | -6.79 | 7 | 85.7% | 0.953 | 26.14% |
| 2 | 2025-04-03 | 2025-10-02 | 85.08% | 13.24% | 71.84 | 6 | 66.7% | 7.573 | 6.17% |
| 3 | 2025-10-03 | 2026-04-06 | 38.78% | 8.6% | 30.18 | 6 | 50% | 2.543 | 20.38% |
| 4 | 2026-04-07 | 2026-10-05 | -25.23% | 0.11% | -25.34 | 6 | 33.3% | 0.26 | 27.28% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -16.17% | -0.55% |
| 2012 | 19.44% | 8.35% |
| 2013 | 34.15% | 14.86% |
| 2014 | -2.12% | -6.61% |
| 2015 | -12.76% | -9.39% |
| 2016 | 42.67% | -12.74% |
| 2017 | -13.87% | 15.89% |
| 2018 | -20.98% | -9.13% |
| 2019 | -15.1% | 3.59% |
| 2020 | -22.69% | -12.35% |
| 2021 | -25.13% | 12.6% |
| 2022 | -28.96% | -1.57% |
| 2023 | 30.31% | 1.69% |
| 2024 | 85.32% | 10.1% |
| 2025 | 65.71% | 20.72% |
| 2026 | -5.22% | 6.83% |

### k2 — FAIL

Fails on: windows: 10.85%/PF 1.631, 56.85%/PF 7.859, 16.94%/PF 1.66, -19.97%/PF 0.462; full sample does not beat benchmark; excess t 0.34 < 3; alpha t 0.61 < 2.

Sample 2010-03-01 → 2026-10-01, 200 months. Full 47.98% vs benchmark 48.49% (excess -0.51 pp). Max DD 75.22% vs 47.02%. Monthly excess t 0.34 (n 200, mean 0.19%/month). Alpha 3.85% ann., t 0.61 (EWU). Trades 378, WR 50.8%, PF 1.167, median names 2, early exits 0. Deflated excess Sharpe p 0.08.

| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2024-10-01 | 2025-04-02 | 10.85% | 0.83% | 10.02 | 14 | 71.4% | 1.631 | 17.13% |
| 2 | 2025-04-03 | 2025-10-02 | 56.85% | 13.24% | 43.61 | 12 | 66.7% | 7.859 | 2.46% |
| 3 | 2025-10-03 | 2026-04-06 | 16.94% | 8.6% | 8.33 | 12 | 50% | 1.66 | 18.58% |
| 4 | 2026-04-07 | 2026-10-05 | -19.97% | 0.11% | -20.07 | 12 | 33.3% | 0.462 | 25.56% |

| Year | Book | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 6.18% |
| 2011 | -16.8% | -0.55% |
| 2012 | 1.75% | 8.35% |
| 2013 | 47.6% | 14.86% |
| 2014 | 1.26% | -6.61% |
| 2015 | 2.8% | -9.39% |
| 2016 | 59.53% | -12.74% |
| 2017 | -0.8% | 15.89% |
| 2018 | -26.94% | -9.13% |
| 2019 | -20.63% | 3.59% |
| 2020 | -5.07% | -12.35% |
| 2021 | -6.02% | 12.6% |
| 2022 | -33.68% | -1.57% |
| 2023 | 15.22% | 1.69% |
| 2024 | 22.31% | 10.1% |
| 2025 | 68.9% | 20.72% |
| 2026 | -11.99% | 6.83% |

Machine-readable: `scripts/momentum-rescore-results.json`.
