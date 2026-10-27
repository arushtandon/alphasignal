# US/JP mean-reversion regime stabilization readout

Run: 2026-09-27T17:01:48.032Z

Holdout status: OVERLAP_RISK. It is a reserved trailing fold but overlaps earlier research, so no result is promotable.

## Baseline versus frozen regime variants

| Cell | Variant | Dev pass folds | Holdout n | Holdout win % | PF | PnL | Confidence | Verdict |
|---|---|---:|---:|---:|---:|---:|---|---|
| US short buy | baseline | 0 | 428 | 65.7 | 1.483 | 9900.53 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 55.5%/0.549/$-12264.71 · 50.3%/0.722/$-3513.16 · 55.5%/0.681/$-9538.69 |  |  |  |  |  |  |
| US short buy | vol_skip_top20 | 0 | 337 | 67.7 | 1.391 | 7040.94 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 57.3%/0.504/$-9004.05 · 50.3%/0.72/$-3544.46 · 55.5%/0.681/$-9538.69 |  |  |  |  |  |  |
| US short buy | vol_skip_top30 | 0 | 306 | 67.3 | 1.287 | 5073.9 | FAIL | rejected bleeder: win target with PF below 1.3 |
|  | folds 1/2/3 | 57.3%/0.468/$-8254.31 · 50%/0.691/$-3766.44 · 55.3%/0.664/$-9949.44 |  |  |  |  |  |  |
| US short buy | ma50_flat_or_up | 0 | 396 | 66.2 | 1.482 | 9597.61 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 54.5%/0.531/$-10973.65 · 50%/0.703/$-3625.73 · 55.7%/0.722/$-7618.59 |  |  |  |  |  |  |
| US short buy | vol_skip_top20_and_ma50_flat_or_up | 0 | 337 | 67.7 | 1.391 | 7040.94 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 56.5%/0.487/$-9317.12 · 50%/0.703/$-3625.73 · 55.7%/0.722/$-7618.59 |  |  |  |  |  |  |
| US short buy | vol_skip_top30_and_ma50_flat_or_up | 0 | 306 | 67.3 | 1.287 | 5073.9 | FAIL | rejected bleeder: win target with PF below 1.3 |
|  | folds 1/2/3 | 56.7%/0.453/$-8471.37 · 49.8%/0.689/$-3699.24 · 55.5%/0.704/$-8029.34 |  |  |  |  |  |  |
| US medium buy | baseline | 1 | 67 | 70.1 | 1.203 | 2696.6 | FAIL | rejected bleeder: win target with PF below 1.3 |
|  | folds 1/2/3 | 61%/0.541/$-14195.94 · 85%/2.282/$3909.46 · 74.2%/1.297/$4888.06 |  |  |  |  |  |  |
| US medium buy | vol_skip_top20 | 1 | 57 | 70.2 | 1.229 | 2666.8 | FAIL | rejected bleeder: win target with PF below 1.3 |
|  | folds 1/2/3 | 59%/0.435/$-12650.12 · 84.6%/2.198/$3652.48 · 74.2%/1.297/$4888.06 |  |  |  |  |  |  |
| US medium buy | vol_skip_top30 | 1 | 51 | 70.6 | 1.36 | 3239.95 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 58.8%/0.418/$-12596.25 · 84.2%/2.06/$3230.53 · 73.9%/1.292/$4806.47 |  |  |  |  |  |  |
| US medium buy | ma50_flat_or_up | 2 | 66 | 69.7 | 1.203 | 2690.26 | FAIL | rejected bleeder: win target with PF below 1.3 |
|  | folds 1/2/3 | 67.3%/0.672/$-7125.06 · 84.6%/2.198/$3652.48 · 76.4%/1.457/$6666.56 |  |  |  |  |  |  |
| US medium buy | vol_skip_top20_and_ma50_flat_or_up | 2 | 57 | 70.2 | 1.229 | 2666.8 | FAIL | rejected bleeder: win target with PF below 1.3 |
|  | folds 1/2/3 | 60%/0.457/$-11436.63 · 84.6%/2.198/$3652.48 · 76.4%/1.457/$6666.56 |  |  |  |  |  |  |
| US medium buy | vol_skip_top30_and_ma50_flat_or_up | 2 | 51 | 70.6 | 1.36 | 3239.95 | FULL | CANDIDATE_ONLY_OVERLAP_RISK |
|  | folds 1/2/3 | 59.7%/0.44/$-11382.76 · 84.2%/2.06/$3230.53 · 76.1%/1.451/$6584.97 |  |  |  |  |  |  |
| Japan short buy | baseline | 1 | 96 | 77.1 | 3.252 | 23618.8 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 62.5%/1.124/$511.02 · 80.8%/1.381/$947.58 · 64.8%/0.569/$-12575.91 |  |  |  |  |  |  |
| Japan short buy | vol_skip_top20 | 1 | 56 | 78.6 | 3.442 | 17052.55 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 52.6%/0.913/$-358.75 · 80.8%/1.304/$800.53 · 78%/1.107/$1068.56 |  |  |  |  |  |  |
| Japan short buy | vol_skip_top30 | 1 | 53 | 79.2 | 3.498 | 16654.03 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 50%/0.767/$-860.97 · 80.8%/1.304/$800.53 · 76.2%/1.105/$794.5 |  |  |  |  |  |  |
| Japan short buy | ma50_flat_or_up | 1 | 79 | 74.7 | 2.7 | 15836.24 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 62.5%/1.198/$434.45 · 80.8%/1.381/$947.58 · 63.5%/0.552/$-13074.35 |  |  |  |  |  |  |
| Japan short buy | vol_skip_top20_and_ma50_flat_or_up | 1 | 49 | 77.6 | 3.308 | 13567.95 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 45.5%/0.801/$-435.32 · 80.8%/1.304/$800.53 · 76.4%/1.057/$570.11 |  |  |  |  |  |  |
| Japan short buy | vol_skip_top30_and_ma50_flat_or_up | 1 | 46 | 78.3 | 3.367 | 13169.42 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 33.3%/0.464/$-937.54 · 80.8%/1.304/$800.53 · 76.2%/1.105/$794.5 |  |  |  |  |  |  |
| Japan medium buy | baseline | 1 | 96 | 83.3 | 2.774 | 20992.8 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 73.9%/1.008/$35.94 · 88.5%/2.075/$1992.86 · 71.7%/0.692/$-8480.25 |  |  |  |  |  |  |
| Japan medium buy | vol_skip_top20 | 1 | 56 | 82.1 | 2.667 | 12616.44 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 66.7%/0.775/$-994.48 · 88.5%/2.672/$2406.97 · 79.7%/0.953/$-482.28 |  |  |  |  |  |  |
| Japan medium buy | vol_skip_top30 | 1 | 53 | 83 | 2.726 | 12409.71 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 64.3%/0.767/$-858.25 · 88.5%/2.672/$2406.97 · 78.6%/0.949/$-382.64 |  |  |  |  |  |  |
| Japan medium buy | ma50_flat_or_up | 1 | 79 | 82.3 | 2.517 | 15542.88 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 75%/0.997/$-9.15 · 88.5%/2.075/$1992.86 · 70.6%/0.673/$-8995.33 |  |  |  |  |  |  |
| Japan medium buy | vol_skip_top20_and_ma50_flat_or_up | 1 | 49 | 81.6 | 2.594 | 10309.33 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 63.6%/0.644/$-1039.57 · 88.5%/2.672/$2406.97 · 78.2%/0.903/$-997.36 |  |  |  |  |  |  |
| Japan medium buy | vol_skip_top30_and_ma50_flat_or_up | 1 | 46 | 82.6 | 2.659 | 10102.61 | FAIL | promotion thresholds or sample-confidence safeguard not met |
|  | folds 1/2/3 | 66.7%/0.853/$-221.09 · 88.5%/2.672/$2406.97 · 78.6%/0.949/$-382.64 |  |  |  |  |  |  |

## Verdict

Metric-qualified variants: US medium vol_skip_top30_and_ma50_flat_or_up. They remain overlap-risk diagnostics, not live candidates.

A filter that merely reduces trade count without increasing qualifying development folds is not treated as stabilization.
