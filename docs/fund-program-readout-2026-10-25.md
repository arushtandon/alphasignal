# Fund-style program — consolidated readout (2026-10-25)

Research only; no bridge or live change. Pre-registration `docs/fund-program-preregistration-2026-10-25.md` (commit 43320cd) was frozen before any run. Family readouts: `docs/f12-readout-2026-10-25.md`, `docs/f13-readout-2026-10-25.md`, `docs/f14-readout-2026-10-25.md`. Data check: `docs/fund-program-data-check-2026-10-25.md`. Execution feasibility: `docs/fund-program-execution-feasibility-2026-10-25.md`.

## Verdict

201 trials (F12 53, F13 4, F14 144). **VALIDATION_PASS: 0. INCUBATION_ELIGIBLE: 18.** No empty cell is filled by a validated strategy.

Deviations from the pre-registration, all stricter or neutral: F14 scores the k = 5 / k = 10 books as separate long, short and L/S trials (144 rather than 80), so its deflated Sharpe uses more trials; the F12-A rest-of-month comparison uses the sessions of the two calendar months spanned by the trade (the pre-registration said "that month"). No book was added, removed or re-parameterised after seeing results.

## Data check (step 0)

All requested series are continuous daily from January 2010 except: `RTY=F` from 2017-07-10, `PA=F` from 2005-01-03, `BTC-USD` from 2014-09-17, `ETH-USD` from 2017-11-09. Reported, not substituted; those instruments enter F13 when their lookback is complete. Yahoo `=F` series are front-month continuous with roll jumps (used as-is; roll cost charged explicitly). IBKR micro Treasury contracts are yield-quoted (sign inversion is an execution item).

## Incubation-eligible rows and the cell each would fill

None is validated. Rows marked "beta" have an index β near or above 1 after construction and an alpha t below 2 — the return is market exposure, not a strategy.

| Family | Row | Cell | Periods | Net % | Bench / index % | t | Alpha t | Index β (diag) | Alpha t (diag) | Max DD % | PF (spells) | Windows | Why not validated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F12 | A TOM S&P 500 (ES=F) -1..+3 | `US × short × long` | 202 | 52.07 | 0 (vs zero) | 1.7 | — | — | — | 13.92 | 1.398 | −+++ | a window with trades is unprofitable or PF < 1.2; per-trade t 1.7 < 3 |
| F12 | A TOM FTSE 100 (^FTSE) -1..+3 | `UK × short × long` | 202 | 68.16 | 0 (vs zero) | 2.09 | — | — | — | 12.95 | 1.484 | −+++ | a window with trades is unprofitable or PF < 1.2; per-trade t 2.09 < 3 |
| F12 | A TOM FTSE 100 (^FTSE) -1..+1 | `UK × short × long` | 202 | 34.69 | 0 (vs zero) | 2.05 | — | — | — | 9.91 | 1.447 | +++− | a window with trades is unprofitable or PF < 1.2; per-trade t 2.05 < 3 |
| F12 | A TOM Hang Seng (^HSI) -1..+1 | `Hong Kong × short × long` | 120 | 26.78 | 0 (vs zero) | 1.86 | — | — | — | 7.63 | 1.597 | +++− | a window with trades is unprofitable or PF < 1.2; per-trade t 1.86 < 3 |
| F14 | F14 US monthly comp-A quintile L/S | `US × medium × long/short` | 152 | 176.81 | 329.49 | 2.31 | — | 0.669 | 0.44 | 20.76 | 0.867 | ++−+ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 2.31 < 3 |
| F14 | F14 US monthly comp-A k=5 L/S | `US × medium × long/short` | 152 | 404.92 | 329.49 | 2.09 | — | 1.385 | 1.52 | 33.43 | 0.972 | ++−+ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 2.09 < 3 |
| F14 | F14 US monthly comp-A k=10 L/S | `US × medium × long/short` | 152 | 223.05 | 329.49 | 1.9 | — | 1.107 | 1.12 | 34.72 | 0.885 | ++++ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 1.9 < 3 |
| F14 | F14 US quarterly comp-A quintile L/S | `US × long × long/short` | 50 | 158.76 | 307.4 | 2.26 | — | 0.822 | 0.58 | 21.71 | 0.852 | ++−+ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 2.26 < 3 |
| F14 | F14 US quarterly comp-A k=5 SHORT (hedged) | `US × long × short` | 50 | 241.19 | 307.4 | 2 | — | -0.354 | 2.19 | 27.4 | 0.846 | ++++ | a window with trades is unprofitable or PF < 1.2; monthly t 2 < 3 |
| F14 | F14 US quarterly comp-A k=5 L/S | `US × long × long/short` | 50 | 366.24 | 307.4 | 2.08 | — | 1.633 | 1.24 | 29.76 | 0.967 | ++−+ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 2.08 < 3 |
| F14 | F14 US quarterly comp-A k=10 L/S | `US × long × long/short` | 50 | 236.41 | 307.4 | 2.01 | — | 1.658 | 1.65 | 25.86 | 0.884 | ++++ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 2.01 < 3 |
| F14 | F14 US quarterly comp-B quintile L/S | `US × long × long/short` | 50 | 174.61 | 307.4 | 2.37 | — | 0.799 | 0.4 | 25.84 | 0.9 | ++−+ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 2.37 < 3 |
| F14 | F14 US quarterly comp-B k=5 SHORT (hedged) | `US × long × short` | 50 | 304.77 | 307.4 | 2.22 | — | -0.617 | 2.44 | 25.81 | 1.011 | +−++ | a window with trades is unprofitable or PF < 1.2; monthly t 2.22 < 3 |
| F14 | F14 US quarterly comp-B k=5 L/S | `US × long × long/short` | 50 | 622.73 | 307.4 | 2.65 | — | 1.658 | 1.76 | 29.89 | 1.112 | ++++ | **beta**; a window with trades is unprofitable or PF < 1.2; monthly t 2.65 < 3 |
| F14 | F14 US quarterly comp-B k=10 SHORT (hedged) | `US × long × short` | 50 | 132.62 | 307.4 | 1.84 | — | -0.374 | 2.69 | 24.6 | 0.841 | +−++ | a window with trades is unprofitable or PF < 1.2; monthly t 1.84 < 3 |
| F14 | F14 US quarterly comp-B k=10 L/S | `US × long × long/short` | 50 | 374.66 | 307.4 | 2.61 | — | 1.401 | 2.06 | 18.89 | 1.019 | +−++ | a window with trades is unprofitable or PF < 1.2; monthly t 2.61 < 3 |
| F14 | F14 France monthly comp-A k=5 L/S | `France × medium × long/short` | 200 | 161.7 | 74.29 | 1.74 | — | 0.4 | 1.38 | 30.83 | 1.115 | +−++ | a window with trades is unprofitable or PF < 1.2; monthly t 1.74 < 3 |
| F14 | F14 France monthly comp-A k=10 L/S | `France × medium × long/short` | 200 | 155.63 | 74.29 | 1.82 | — | 0.481 | 1.45 | 25.16 | 1.18 | +++− | a window with trades is unprofitable or PF < 1.2; monthly t 1.82 < 3 |

## Cell map — best row per cell across F12, F13, F14

"Best" = highest monthly t (per-trade t for F12-A). Cells not listed were not addressed by this program.

| Cell | Trials | Best row | t | Alpha t | Max DD % | Verdict |
|---|---|---|---|---|---|---|
| `France × long × long/short` | 6 | F14 France quarterly comp-A k=10 L/S | 1.69 | 1.31 | 24.66 | FAIL |
| `France × long × long` | 8 | F14 France quarterly comp-A quintile LONG | 1.75 | 2.41 | 28.48 | FAIL |
| `France × long × short` | 6 | F14 France quarterly comp-B k=10 SHORT (hedged) | 1.22 | 0.78 | 21.8 | FAIL |
| `France × medium × long/short` | 6 | F14 France monthly comp-A k=10 L/S | 1.82 | 1.45 | 25.16 | INCUBATION_ELIGIBLE |
| `France × medium × long` | 12 | F14 France monthly comp-A quintile LONG | 0.72 | 1.6 | 36.72 | FAIL |
| `France × medium × short` | 6 | F14 France monthly comp-A k=10 SHORT (hedged) | 1.28 | 0.83 | 21.68 | FAIL |
| `France × short × long` | 3 | A TOM CAC 40 (^FCHI) -1..+3 | 0.69 | — | 16.76 | FAIL |
| `Germany × long × long/short` | 6 | F14 Germany quarterly comp-B k=10 L/S | 1.5 | 0.98 | 34.22 | FAIL |
| `Germany × long × long` | 8 | F14 Germany quarterly comp-A quintile LONG | 0.66 | 1.32 | 41.29 | FAIL |
| `Germany × long × short` | 6 | F14 Germany quarterly comp-B k=10 SHORT (hedged) | 0.64 | 0.22 | 25.42 | FAIL |
| `Germany × medium × long/short` | 6 | F14 Germany monthly comp-A quintile L/S | 1.73 | 1.48 | 29.54 | FAIL |
| `Germany × medium × long` | 12 | F14 Germany monthly comp-A quintile LONG | 0.83 | 1.6 | 41.31 | FAIL |
| `Germany × medium × short` | 6 | F14 Germany monthly comp-B k=10 SHORT (hedged) | 0.98 | 0.56 | 22.57 | FAIL |
| `Germany × short × long` | 3 | A TOM DAX (^GDAXI) -2..+3 | 1.35 | — | 12.46 | FAIL |
| `Hong Kong × short × long` | 3 | A TOM Hang Seng (^HSI) -1..+1 | 1.86 | — | 7.63 | INCUBATION_ELIGIBLE |
| `Japan × short × long` | 3 | A TOM Nikkei 225 (^N225) -1..+1 | 0.37 | — | 12.75 | FAIL |
| `MULTI-ASSET × medium × long/short` | 4 | F13 trend 12m | 1.4 | — | 20.5 | FAIL |
| `UK × long × long/short` | 6 | F14 UK quarterly comp-A k=10 L/S | 0.08 | -0.19 | 32.76 | FAIL |
| `UK × long × long` | 8 | F14 UK quarterly comp-B quintile LONG | 0.49 | 1.29 | 21.89 | FAIL |
| `UK × long × short` | 6 | F14 UK quarterly comp-A k=10 SHORT (hedged) | -0.98 | -0.83 | 58.28 | FAIL |
| `UK × medium × long/short` | 6 | F14 UK monthly comp-A k=10 L/S | -0.03 | -0.34 | 48.23 | FAIL |
| `UK × medium × long` | 12 | B LowVol UK no filter quintile | 0.24 | 1.39 | 21.84 | FAIL |
| `UK × medium × short` | 6 | F14 UK monthly comp-A k=10 SHORT (hedged) | -0.83 | -0.7 | 57.77 | FAIL |
| `UK × short × long` | 6 | A TOM FTSE 100 (^FTSE) -1..+3 | 2.09 | — | 12.95 | INCUBATION_ELIGIBLE |
| `US × long × long/short` | 6 | F14 US quarterly comp-B k=5 L/S | 2.65 | 1.76 | 29.89 | INCUBATION_ELIGIBLE |
| `US × long × long` | 8 | C Value+Quality US P≥6 k=10 | 0.03 | 0.44 | 50.74 | FAIL |
| `US × long × short` | 6 | F14 US quarterly comp-B k=5 SHORT (hedged) | 2.22 | 2.44 | 25.81 | INCUBATION_ELIGIBLE |
| `US × medium × long/short` | 6 | F14 US monthly comp-A quintile L/S | 2.31 | 0.44 | 20.76 | INCUBATION_ELIGIBLE |
| `US × medium × long` | 12 | F14 US monthly comp-A k=5 LONG | -0.82 | 1.21 | 38.65 | FAIL |
| `US × medium × short` | 6 | F14 US monthly comp-A k=10 SHORT (hedged) | 1.09 | 1.23 | 41.06 | FAIL |
| `US × short × long` | 3 | A TOM S&P 500 (ES=F) -1..+3 | 1.7 | — | 13.92 | INCUBATION_ELIGIBLE |

## Deflated Sharpe by family (best trial)

| Family | Trials | Best trial | Sharpe (ann.) | SR0 (ann.) | P(deflated) |
|---|---|---|---|---|---|
| F12 | 53 | A TOM Hang Seng (^HSI) -1..+1 | 0.59 | 0.68 | 0.381 |
| F13 | 4 | F13 trend 12m | 0.34 | 0.32 | 0.535 |
| F14 | 144 | F14 US quarterly comp-B k=5 L/S | 1.3 | 1.32 | 0.481 |

No family produces a trial whose deflated-Sharpe probability exceeds 0.55; the best candidates are indistinguishable from the best of N noise trials.

## Family summaries

### F12-A turn-of-month

| Index | Variant | Trades | Mean/trade % | Per-trade t | PF | Net % | Buy & hold % | vs rest-of-month t | Max DD % | Windows | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S&P 500 (ES=F) | -1..+3 | 202 | 0.23 | 1.7 | 1.398 | 52.07 | 589.54 | 0.87 | 13.92 | −+++ | INCUBATION_ELIGIBLE |
| S&P 500 (ES=F) | -1..+1 | 202 | 0.04 | 0.56 | 1.119 | 7.88 | 589.54 | 0.43 | 13.52 | −−++ | FAIL |
| S&P 500 (ES=F) | -2..+3 | 201 | 0.2 | 1.43 | 1.314 | 43.82 | 610.43 | 0.24 | 12.55 | −+++ | FAIL |
| DAX (^GDAXI) | -1..+3 | 120 | 0.21 | 1.19 | 1.33 | 26.05 | 135.82 | 0.83 | 14.01 | ++−+ | FAIL |
| DAX (^GDAXI) | -1..+1 | 120 | -0.03 | -0.38 | 0.913 | -4.55 | 135.82 | -0.36 | 11.81 | +++− | FAIL |
| DAX (^GDAXI) | -2..+3 | 120 | 0.29 | 1.35 | 1.377 | 36.35 | 137.27 | 0.8 | 12.46 | ++−+ | FAIL |
| FTSE 100 (^FTSE) | -1..+3 | 202 | 0.28 | 2.09 | 1.484 | 68.16 | 95 | 2.01 | 12.95 | −+++ | INCUBATION_ELIGIBLE |
| FTSE 100 (^FTSE) | -1..+1 | 202 | 0.15 | 2.05 | 1.447 | 34.69 | 95 | 2.36 | 9.91 | +++− | INCUBATION_ELIGIBLE |
| FTSE 100 (^FTSE) | -2..+3 | 201 | 0.1 | 0.71 | 1.144 | 17.01 | 105.13 | 0.42 | 21.61 | −+++ | FAIL |
| FTSE 100 via ISF.L (ISF.L) | -1..+3 | 202 | 0.11 | 0.91 | 1.191 | 21.3 | 91.68 | 1.37 | 17.67 | −+++ | FAIL |
| FTSE 100 via ISF.L (ISF.L) | -1..+1 | 202 | -0.04 | -0.66 | 0.885 | -8.44 | 91.68 | 0.74 | 23.15 | +++− | FAIL |
| FTSE 100 via ISF.L (ISF.L) | -2..+3 | 201 | 0.09 | 0.62 | 1.126 | 14.34 | 97.83 | 0.77 | 22.87 | ++++ | FAIL |
| Nikkei 225 (^N225) | -1..+3 | 120 | -0.01 | -0.02 | 0.994 | -5.76 | 302.44 | -0.6 | 28.15 | +−−+ | FAIL |
| Nikkei 225 (^N225) | -1..+1 | 120 | 0.03 | 0.37 | 1.092 | 3.58 | 302.44 | 0.13 | 12.75 | −−−+ | FAIL |
| Nikkei 225 (^N225) | -2..+3 | 120 | 0.02 | 0.08 | 1.023 | -2.88 | 302.9 | -0.75 | 31.42 | −−−+ | FAIL |
| Hang Seng (^HSI) | -1..+3 | 119 | 0.25 | 1.16 | 1.314 | 30.53 | 4.45 | 1.28 | 21.02 | ++−+ | FAIL |
| Hang Seng (^HSI) | -1..+1 | 120 | 0.21 | 1.86 | 1.597 | 26.78 | 4.45 | 2.2 | 7.63 | +++− | INCUBATION_ELIGIBLE |
| Hang Seng (^HSI) | -2..+3 | 119 | 0.24 | 0.99 | 1.257 | 27.84 | 5.23 | 1.03 | 15.1 | ++−+ | FAIL |
| CAC 40 (^FCHI) | -1..+3 | 120 | 0.12 | 0.69 | 1.184 | 12.95 | 73.11 | 0.54 | 16.76 | ++−+ | FAIL |
| CAC 40 (^FCHI) | -1..+1 | 120 | -0.11 | -1.33 | 0.724 | -12.3 | 73.11 | -1.16 | 14.61 | +−+− | FAIL |
| CAC 40 (^FCHI) | -2..+3 | 120 | 0.09 | 0.44 | 1.111 | 8.23 | 73.36 | 0.12 | 19.06 | ++−+ | FAIL |

The effect is positive on most indices for the −1..+3 window (mean 0.2–0.3% per trade, PF 1.3–1.5) and it beats the rest of the month at t ≈ 2 on the FTSE and S&P, but no index reaches per-trade t ≥ 3, and each has at least one losing window. Nikkei shows nothing. Costs (micro round trip + pro-rata roll, 0.04% + ~0.0001%) are not the binding constraint.

### F12-B low volatility

| Book | Periods | Net % | Bench % | Excess t | Alpha t | Beats QQQ | Max DD % | Trades | PF | Windows | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B LowVol US +mom>0 quintile | 152 | 124.85 | 329.49 | -1.82 | 0.8 | no | 24.85 | 1483 | 1.981 | +−+− | FAIL |
| B LowVol US +mom>0 k=5 | 152 | 77.6 | 329.49 | -1.91 | 0.81 | no | 24.07 | 206 | 1.659 | +++− | FAIL |
| B LowVol US +mom>0 k=10 | 152 | 111.22 | 329.49 | -1.69 | 0.88 | no | 22.52 | 360 | 1.878 | +−+− | FAIL |
| B LowVol US no filter quintile | 152 | 140.69 | 329.49 | -1.74 | 1.32 | no | 24.58 | 1099 | 2.97 | +−−− | FAIL |
| B LowVol US no filter k=5 | 152 | 67.46 | 329.49 | -2.1 | 0.78 | no | 25.8 | 152 | 1.737 | +−+− | FAIL |
| B LowVol US no filter k=10 | 152 | 111.86 | 329.49 | -1.67 | 1.25 | no | 22.52 | 258 | 2.157 | +−+− | FAIL |
| B LowVol UK +mom>0 quintile | 200 | 31.8 | 48.49 | -0.38 | 0.43 | — | 31.58 | 362 | 1.355 | +−++ | FAIL |
| B LowVol UK +mom>0 k=5 | 200 | 84.3 | 48.49 | 0.17 | 1.16 | — | 28.56 | 210 | 1.567 | +−−− | FAIL |
| B LowVol UK +mom>0 k=10 | 200 | 76.44 | 48.49 | 0.08 | 1.14 | — | 18.37 | 365 | 1.595 | +−−+ | FAIL |
| B LowVol UK no filter quintile | 200 | 93.86 | 48.49 | 0.24 | 1.39 | — | 21.84 | 296 | 1.927 | +−++ | FAIL |
| B LowVol UK no filter k=5 | 200 | 40.07 | 48.49 | -0.25 | 0.57 | — | 24.41 | 149 | 1.393 | +−−+ | FAIL |
| B LowVol UK no filter k=10 | 200 | 54.46 | 48.49 | -0.14 | 0.82 | — | 18.36 | 214 | 1.607 | +−−− | FAIL |
| B LowVol France +mom>0 quintile | 200 | 123.82 | 74.29 | 0.11 | 1.3 | — | 23.55 | 185 | 1.611 | +++− | FAIL |
| B LowVol France +mom>0 k=5 | 200 | 172.1 | 74.29 | 0.42 | 1.79 | — | 21.8 | 221 | 1.954 | +++− | FAIL |
| B LowVol France +mom>0 k=10 | 200 | 135.14 | 74.29 | 0.2 | 1.5 | — | 25 | 375 | 1.826 | +−+− | FAIL |
| B LowVol France no filter quintile | 200 | 185.97 | 74.29 | 0.48 | 2.06 | — | 21.44 | 128 | 2.68 | +−+− | FAIL |
| B LowVol France no filter k=5 | 200 | 145.45 | 74.29 | 0.26 | 1.55 | — | 25.37 | 99 | 2.339 | +++− | FAIL |
| B LowVol France no filter k=10 | 200 | 182.75 | 74.29 | 0.48 | 2.04 | — | 23.57 | 165 | 2.841 | +−+− | FAIL |
| B LowVol Germany +mom>0 quintile | 200 | 132.02 | 100.49 | -0.08 | 1.28 | — | 28.64 | 144 | 1.539 | +−+− | FAIL |
| B LowVol Germany +mom>0 k=5 | 200 | 174.21 | 100.49 | 0.13 | 1.74 | — | 24.27 | 208 | 1.948 | +−+− | FAIL |
| B LowVol Germany +mom>0 k=10 | 200 | 174.41 | 100.49 | 0.16 | 1.74 | — | 22.13 | 360 | 2.003 | +−−− | FAIL |
| B LowVol Germany no filter quintile | 200 | 200.56 | 100.49 | 0.27 | 1.89 | — | 21.16 | 118 | 2.769 | +−+− | FAIL |
| B LowVol Germany no filter k=5 | 200 | 173.13 | 100.49 | 0.12 | 1.69 | — | 21.09 | 113 | 2.497 | +−+− | FAIL |
| B LowVol Germany no filter k=10 | 200 | 231.83 | 100.49 | 0.5 | 2.22 | — | 20.76 | 134 | 3.461 | +−+− | FAIL |

Low vol trails the index in the US (excess t −1.7 to −2.1 against SPY) and is flat to mildly positive in Europe (alpha t up to 2.2 for Germany k=10 but excess t ≤ 0.5 and a losing window in every variant). The 12-1 > 0 filter does not help.

### F12-C value + quality

| Book | Periods | Net % | Bench % | Excess t | Alpha t | Beats QQQ | Max DD % | Trades | PF | Windows | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C Value+Quality US P≥6 quintile | 50 | 99.16 | 307.4 | -1.46 | -0.56 | no | 46.06 | 1084 | 1.755 | −+++ | FAIL |
| C Value+Quality US P≥6 k=10 | 50 | 203.08 | 307.4 | 0.03 | 0.44 | no | 50.74 | 291 | 1.995 | −+++ | FAIL |
| C Value+Quality UK P≥6 quintile | 66 | 53.39 | 40.52 | 0.36 | 0.47 | — | 55.98 | 43 | 1.494 | −+−+ | FAIL |
| C Value+Quality UK P≥6 k=10 | 66 | 87.54 | 40.52 | 0.33 | 1.31 | — | 33.09 | 192 | 1.653 | −+−+ | FAIL |
| C Value+Quality France P≥6 quintile | 66 | 236.58 | 67.07 | 0.95 | 1.19 | — | 62.6 | 41 | 2.295 | +−++ | FAIL |
| C Value+Quality France P≥6 k=10 | 66 | 106.03 | 67.07 | -0.13 | 1.44 | — | 19.48 | 154 | 1.98 | +++− | FAIL |
| C Value+Quality Germany P≥6 quintile | 66 | -9.54 | 86.79 | -0.53 | -0.33 | — | 52.17 | 63 | 1.21 | +++− | FAIL |
| C Value+Quality Germany P≥6 k=10 | 66 | 161.01 | 86.79 | 0.18 | 1.45 | — | 23.36 | 266 | 1.78 | +−+− | FAIL |

With Piotroski ≥ 6 the UK, France and Germany pools are ~10 names a quarter (UK quarterly filers only), so the "quintile" is one or two names and the book is a concentration lottery (max DD 52–63%). The US pool is 124–300 names and still trails SPY (99% vs 307%). Not a candidate anywhere.

### F13 managed-futures trend

| Variant | Months | Net % | Ann. % | Realized vol % | Sharpe | t vs 0 | Max DD % | Corr SPY | Book in worst-10% SPY months | 60/40 Sharpe | Windows | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1m | 202 | -49.1 | -3.95 | 9.87 | -0.36 | -1.46 | 52.14 | -0.151 | 2.18% vs SPY -7.39% | 0.85 | −−−+ | FAIL |
| 3m+6m | 202 | 29.81 | 1.57 | 10.77 | 0.2 | 0.81 | 26.84 | 0.019 | -0.67% vs SPY -7.39% | 0.85 | −++− | FAIL |
| 12m | 202 | 65.22 | 3.04 | 10.28 | 0.34 | 1.4 | 20.5 | 0.132 | -0.88% vs SPY -7.39% | 0.85 | −+++ | FAIL |
| blend | 202 | 18.37 | 1.01 | 10.05 | 0.15 | 0.61 | 18.91 | -0.026 | -0.29% vs SPY -7.39% | 0.85 | −++− | FAIL |

Vol targeting works (realized 9.9–10.8% against a 10% target). 12-month trend is the only variant with a positive Sharpe worth naming (0.34, t 1.4) and it has a losing first window; 1-month trend loses 49% after costs. Crisis behaviour is the expected one only for the 1m variant (+2.2% in the worst-decile SPY months) — the slower variants are flat to slightly negative there. 60/40 earned a Sharpe of about 0.85 over the same sample. Per-instrument and per-class tables are in the F13 readout; equity index longs (NQ, ES, YM) and the yen carry the 12m book, FX and rates detract.

### F14 multi-factor long/short

Long legs: no market beats its index on excess t (best US long k=5 at −0.8; France quarterly quintile long has alpha t 2.4 but excess t 1.75 and a losing window). Hedged short legs: the US quarterly k=5/k=10 books are the only rows anywhere in the program with index-neutral alpha t above 2 (2.2–2.7), with t vs zero 1.8–2.2 and spell PF ≈ 0.85–1.0 — the single-name shorts lose money and the hedge earns it back with a negative net beta; incubation-eligible, not validated. Combined L/S rows are net long the index by construction (see the F14 readout caveat); their t vs zero is beta. UK shorts lose 50–85% in every variant (half-year filers excluded from quality, thin sectors).

## What this means for the cell grid

- No cell gains a validated strategy from F12, F13 or F14.
- Incubation-eligible, not beta-driven: F12-A FTSE 100 −1..+3 and −1..+1 (`UK × short × long`), F12-A S&P 500 −1..+3 (`US × short × long`), F12-A Hang Seng −1..+1 (`Hong Kong × short × long`), F14 US quarterly comp-A/B k=5 and comp-B k=10 SHORT (hedged) (`US × long × short`).
- Incubation-eligible but beta: every F14 L/S row (US, France) — index β 0.4–1.7 with alpha t < 2 except US quarterly comp-B k=10 L/S (alpha t 2.06, β 1.4).
- F13 does not fill the new `MULTI-ASSET × medium × long/short` cell.
- Execution work for micro futures, single-stock shorts and hedged baskets (feasibility write-up) is not warranted by these results.