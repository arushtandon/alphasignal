# Validated Setup Book Readout

Generated: 2026-10-02T11:43:05.248Z

Research only. No feature flag was enabled and no live recommendation, order, or deployment setting was changed.
All 37 tested control/setup rows share one Benjamini-Hochberg family. The trailing holdout is OVERLAP_RISK and cannot produce a VALIDATED verdict.

## One-page recommendation specification
| Market | Horizon | Setup | Verdict | Dev Conf / WR | Holdout WR | Holdout PF | Picks / month |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| Commodities | long | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| Commodities | medium | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| France | long | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| Germany | medium | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| Japan | long | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| Japan | medium | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| Japan | short | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| UK | long | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| UK | medium | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| UK | short | No preregistered short setup; prior US short development folds all lost money. | NO_VALIDATED_SETUP | —% | —% | — | — |
| US | long | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| US | medium | No setup passed the frozen safeguards. | NO_RECOMMENDATION | —% | —% | — | — |
| US | short | No preregistered short setup; prior US short development folds all lost money. | NO_VALIDATED_SETUP | —% | —% | — | — |

## Full setup results
| Market | Hz | Setup | Verdict | Dev n | Picks/mo | Dev WR | Dev PF | Dev PnL | Avg win/loss | Conf | Holdout n | Holdout WR | Holdout PF | Holdout PnL | BH q | Why rejected |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| US | short | V0 current live rules (control) | CONTROL | 2 | 0.095 | 100% | 99 | $1043.14 | 5.216% / —% | 100% | 1 | 0% | 0 | $-427.91 | FAIL (1) | — |
| US | medium | V0 current live rules (control) | CONTROL | 9 | 0.429 | 55.6% | 0.602 | $-384.06 | 1.163% / -2.414% | 55.6% | 1 | 0% | 0 | $-654.03 | FAIL (1) | — |
| US | long | V0 current live rules (control) | CONTROL | 1 | 0.048 | 100% | 99 | $1436.67 | 14.367% / —% | 100% | 0 | —% | — | $0 | FAIL (1) | — |
| UK | short | V0 current live rules (control) | CONTROL | 0 | 0 | —% | — | $0 | —% / —% | —% | 0 | —% | — | $0 | FAIL (1) | — |
| UK | medium | V0 current live rules (control) | CONTROL | 1 | 0.048 | 0% | 0 | $-501.26 | —% / -5.013% | 0% | 0 | —% | — | $0 | FAIL (1) | — |
| UK | long | V0 current live rules (control) | CONTROL | 0 | 0 | —% | — | $0 | —% / —% | —% | 0 | —% | — | $0 | FAIL (1) | — |
| Japan | short | V0 current live rules (control) | CONTROL | 13 | 0.619 | 53.8% | 0.739 | $-692.15 | 2.793% / -4.412% | 53.8% | 5 | 40% | 0.505 | $-755.69 | FAIL (1) | — |
| Japan | medium | V0 current live rules (control) | CONTROL | 38 | 1.81 | 47.4% | 0.935 | $-336.16 | 2.692% / -2.591% | 47.4% | 15 | 46.7% | 1.676 | $1284.46 | FAIL (1) | — |
| Japan | long | V0 current live rules (control) | CONTROL | 14 | 0.667 | 21.4% | 0.474 | $-5334.46 | 16.004% / -9.214% | 21.4% | 6 | 16.7% | 0.68 | $-1626.13 | FAIL (1) | — |
| Germany | medium | V0 current live rules (control) | CONTROL | 4 | 0.19 | 75% | 6.306 | $1116.74 | 4.424% / -2.105% | 75% | 0 | —% | — | $0 | FAIL (1) | — |
| France | long | V0 current live rules (control) | CONTROL | 3 | 0.143 | 0% | 0 | $-2700.28 | —% / -9.001% | 0% | 2 | 0% | 0 | $-1993.65 | FAIL (1) | — |
| Commodities | medium | V0 current live rules (control) | CONTROL | 2 | 0.1 | 50% | 1.77 | $172.69 | 3.971% / -2.244% | 50% | 1 | 0% | 0 | $-220.29 | FAIL (1) | — |
| Commodities | long | V0 current live rules (control) | CONTROL | 4 | 0.2 | 50% | 2.457 | $4352.18 | 36.695% / -14.934% | 50% | 0 | —% | — | $0 | FAIL (1) | — |
| US | medium | Wave 3 trend/breakout baseline | REJECTED | 1373 | 65.381 | 28.7% | 0.827 | $-85539.44 | 10.394% / -5.057% | 28.7% | 455 | 30.8% | 0.897 | $-18351.29 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| US | long | Wave 3 trend/breakout baseline | REJECTED | 3346 | 159.333 | 20% | 0.573 | $-474558.35 | 9.51% / -4.149% | 20% | 1362 | 23.6% | 0.746 | $-113855.44 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| US | medium | BB lower / 1 ATR / t21 / 2.5 ATR / 50-50 + vol30 + MA50 | REJECTED | 1585 | 75.476 | 71.5% | 1.008 | $2390.39 | 2.608% / -6.484% | 71.5% | 458 | 59.4% | 0.812 | $-19520.07 | PASS (0.000097) | UNSTABLE_DEVELOPMENT_FOLDS |
| Germany | medium | Live trend + PIT Piotroski >=5 | REJECTED | 2 | 0.095 | 100% | 99 | $1150.47 | 5.752% / —% | 100% | 0 | —% | — | $0 | FAIL (1) | INSUFFICIENT_HOLDOUT_SAMPLE |
| France | long | Wave 3 trend/breakout baseline | REJECTED | 181 | 8.619 | 19.9% | 0.582 | $-21896.41 | 8.485% / -3.617% | 19.9% | 55 | 16.4% | 0.161 | $-17717.49 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| Commodities | medium | Wave 3 trend/breakout baseline | REJECTED | 30 | 1.5 | 43.3% | 1.674 | $8026.34 | 15.339% / -7.008% | 43.3% | 3 | 0% | 0 | $-1455.33 | FAIL (1) | INSUFFICIENT_HOLDOUT_SAMPLE |
| Commodities | long | Wave 3 trend/breakout baseline | REJECTED | 77 | 3.85 | 22.1% | 0.694 | $-11350.69 | 15.113% / -6.174% | 22.1% | 19 | 5.3% | 0.037 | $-12281.25 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| UK | medium | Wave 3 trend/breakout baseline | REJECTED | 241 | 11.476 | 30.7% | 0.661 | $-25868.89 | 6.826% / -4.574% | 30.7% | 53 | 32.1% | 0.333 | $-12716.15 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| UK | medium | Wave 3 trend/breakout baseline + PIT Piotroski >=5 | REJECTED | 72 | 3.429 | 27.8% | 0.73 | $-5743.7 | 7.78% / -4.097% | 27.8% | 19 | 21.1% | 0.136 | $-7593.14 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| UK | long | Wave 3 trend/breakout baseline | REJECTED | 465 | 22.143 | 24.7% | 0.832 | $-24767.94 | 10.684% / -4.218% | 24.7% | 193 | 16.1% | 0.267 | $-54795.33 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| UK | long | Wave 3 trend/breakout baseline + PIT Piotroski >=5 | REJECTED | 141 | 6.714 | 23.4% | 0.979 | $-962 | 13.522% / -4.221% | 23.4% | 41 | 19.5% | 0.28 | $-13239 | FAIL (1) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | long | Exact live-v3 trend engine | REJECTED | 14 | 0.667 | 21.4% | 0.474 | $-5334.46 | 16.004% / -9.214% | 21.4% | 6 | 16.7% | 0.68 | $-1626.13 | FAIL (1) | INSUFFICIENT_HOLDOUT_SAMPLE |
| Japan | short | Frozen Japan short MR + baseline | REJECTED | 451 | 21.476 | 68.3% | 0.761 | $-20210.4 | 2.089% / -5.913% | 68.3% | 203 | 76.8% | 2.45 | $37530.41 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | short | Frozen Japan short MR + vol_skip_top20 | REJECTED | 306 | 14.571 | 75.5% | 1.146 | $6158.55 | 2.091% / -5.62% | 75.5% | 130 | 78.5% | 3.237 | $35933.45 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | short | Frozen Japan short MR + vol_skip_top30 | REJECTED | 253 | 12.048 | 76.3% | 1.194 | $6549.57 | 2.085% / -5.617% | 76.3% | 116 | 79.3% | 3.702 | $35572.05 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | short | Frozen Japan short MR + ma50_flat_or_up | REJECTED | 429 | 20.429 | 67.4% | 0.729 | $-22378.49 | 2.086% / -5.904% | 67.4% | 180 | 75% | 2.211 | $29726.79 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | short | Frozen Japan short MR + vol_skip_top20_and_ma50_flat_or_up | REJECTED | 285 | 13.571 | 75.1% | 1.124 | $4896.23 | 2.076% / -5.568% | 75.1% | 116 | 76.7% | 2.933 | $28916.77 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | short | Frozen Japan short MR + vol_skip_top30_and_ma50_flat_or_up | REJECTED | 239 | 11.381 | 76.2% | 1.176 | $5581.24 | 2.052% / -5.572% | 76.2% | 102 | 77.5% | 3.367 | $28555.37 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | medium | Frozen Japan medium MR + baseline | REJECTED | 449 | 21.381 | 74.2% | 0.795 | $-18753.28 | 2.188% / -7.897% | 74.2% | 209 | 83.3% | 2.01 | $32622.89 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | medium | Frozen Japan medium MR + vol_skip_top20 | REJECTED | 312 | 14.857 | 80.1% | 1.189 | $8128.3 | 2.043% / -6.927% | 80.1% | 131 | 85.5% | 2.642 | $27825.32 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | medium | Frozen Japan medium MR + vol_skip_top30 | REJECTED | 260 | 12.381 | 81.2% | 1.285 | $9522.65 | 2.033% / -6.809% | 81.2% | 117 | 87.2% | 2.897 | $27718.65 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | medium | Frozen Japan medium MR + ma50_flat_or_up | REJECTED | 429 | 20.429 | 73.4% | 0.761 | $-21496.38 | 2.178% / -7.904% | 73.4% | 185 | 82.7% | 1.913 | $27310.45 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | medium | Frozen Japan medium MR + vol_skip_top20_and_ma50_flat_or_up | REJECTED | 292 | 13.905 | 79.5% | 1.13 | $5382.62 | 2.019% / -6.908% | 79.5% | 117 | 84.6% | 2.445 | $22889.46 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |
| Japan | medium | Frozen Japan medium MR + vol_skip_top30_and_ma50_flat_or_up | REJECTED | 246 | 11.714 | 81.3% | 1.27 | $8434.84 | 1.981% / -6.779% | 81.3% | 103 | 86.4% | 2.686 | $22782.79 | PASS (0) | UNSTABLE_DEVELOPMENT_FOLDS |

Per-year breakdowns and fold-level results are in `scripts/validated-setup-book-results.json`.

## Reference only
The August Danelfin-era paper results remain historical operational evidence only. They were not used for selection, confidence, BH testing, or promotion.

## Live router
No VALIDATED setup. The designed `SETUP_BOOK_ENABLED` router is not wired into pick generation or IBKR. The flag stays off and every cell remains `NO RECOMMENDATION` / `NO_VALIDATED_SETUP`.

