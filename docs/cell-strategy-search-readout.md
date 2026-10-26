# Cell strategy search — readout

Generated: 2026-10-26T05:02:24.196Z

Research only. No live signal, setup-book cell, bracket, order, flag, or deployment setting changed.
Pre-registration: `docs/cell-strategy-search-preregistration.md`. Consistency rule: mean reversion needs every window profitable with win rate ≥ 60%; trend, momentum, breakout, reversal and earnings books need every window profitable with PF ≥ 1.2. Ranking: CONSISTENT first, fresh before STALE, then worst all-window PF, then smaller average loss. The fourth window is OVERLAP_RISK in every source.

## What is live (corrected 2026-10-25)

- `UK_LONG_MOMENTUM` is **plain 12-1 momentum, k=1** (one new name a month, six-month hold, six $30,000 slots), with **no Piotroski screen**. Experimental. `FRANCE_LONG_MOMENTUM` is the same design and is paused.
- The **US long Piotroski ≥ 6 book is not enabled**. `docs/us-long-piotroski-paper-design.md` is a paper design only; there is no setup-book cell, flag, tag, or order for it.
- The 2026-10-22 version of this readout said the two CONSISTENT rows were "already in the live book". That was wrong: `B__UK__long__piotroski6__regimeoff` is not the live UK definition, and `B__US__long__piotroski6__regimeoff` is not live at all.

## STALE results

Every reused frozen row computed on a **current-constituent universe** (survivorship label `SURVIVORSHIP_BIAS`: all UK, France, Germany, Hong Kong, Japan and India rows in the consistency study, new-strategy-types and amendment files, and the engine-short replay for those markets) or on the **old earnings event window** (the `A2__US__medium__react*` rows) is marked STALE. A STALE row stays in the tables but is never CONSISTENT, and it ranks behind fresh rows. The standards that replaced them are in `docs/strategy-gaps-amendment-2026-10-06.md` (ever-member universe; d0−1 → d0+1 abnormal-return window). The momentum rows surfaced by this search were re-scored under those standards in `docs/momentum-rescore-2026-10-25.md`; see the section below.

## Best strategy by requested cell

A row is the best available strategy for the cell, not an endorsement: only CONSISTENT cells clear the framework. Rows from the trend/momentum books report per-window book return (%) rather than $ PnL; the crypto trend rows are the same monthly-rebalanced book scored under the medium and long labels in the source study. "Fresh best" is the best row that is not STALE (US point-in-time rows, commodity and crypto rows).

| Market | Horizon | Verdict | Best row | Stale | Family | Worst PF | Pooled n | Pooled WR | Pooled PF | Why not consistent | Source | Membership |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Hong Kong | short | NONE | `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__full` | STALE | mean_reversion | 0.659 | 184 | 49.5% | 0.706 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| UK | short | NONE | `E__UK__short__worst5__regimeoff` | STALE | weekly_reversal | 0.555 | 2310 | 44.2% | 0.775 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | new-strategy-types 2026-10-05 | SURVIVORSHIP_BIAS |
| Germany | short | NONE | `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` | STALE | mean_reversion | 0.802 | 83 | 62.7% | 0.964 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| France | short | NONE | `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` | STALE | mean_reversion | 0.664 | 407 | 63.6% | 0.725 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| Commodities | short | NONE | `A__Commodities__short__close_below_lower_bb20_2__none__sl1.5__t10__full` | fresh | mean_reversion | 0.641 | 43 | 67.4% | 0.881 | window 1 lost money | consistency-study 2026-10-05 | NOT_APPLICABLE |
| Crypto | short | NONE | `D__Crypto__short__breakout20` | fresh | breakout | 0.122 | 1038 | 38.6% | 2.246 | window 2 PF 0.122 < 1.2 | new-strategy-types 2026-10-05 | NOT_APPLICABLE |
| US | medium | NONE | `A__US__medium__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` | fresh | mean_reversion | 0.746 | 1607 | 59.7% | 0.94 | window 1 lost money | consistency-study 2026-10-05 | POINT_IN_TIME |
| UK | medium | NONE | `B__UK__medium__momentum__regimeoff` | STALE | momentum | 1.149 | 1060 | 51.2% | 1.105 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | new-strategy-types 2026-10-05 | SURVIVORSHIP_BIAS |
| Germany | medium | NONE | `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full` | STALE | mean_reversion | 0.939 | 82 | 64.6% | 0.986 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | consistency-study 2026-10-05 | SURVIVORSHIP_BIAS |
| France | medium | NONE | `B__France__medium__momentum__regimeoff__longsample` | STALE | momentum | 0.92 | 1890 | 50.6% | 1.145 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | strategy-amendment 2026-10-06 | SURVIVORSHIP_BIAS |
| Crypto | medium | NONE | `D__Crypto__medium__trend12m` | fresh | trend | 0.133 | 712 | 20.8% | 5.478 | window 2 PF 0.372 < 1.2 | new-strategy-types 2026-10-05 | NOT_APPLICABLE |
| US | long | CONSISTENT | `B__US__long__piotroski6__regimeoff` | fresh | momentum | 2.102 | 2206 | 59.9% | 2.502 | — | new-strategy-types 2026-10-05 | POINT_IN_TIME |
| UK | long | NONE | `B__UK__long__piotroski6__regimeoff` | STALE | momentum | 1.478 | 975 | 52.4% | 1.478 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file | new-strategy-types 2026-10-05 | SURVIVORSHIP_BIAS |
| Crypto | long | NONE | `D__Crypto__long__trend12m` | fresh | trend | 0.133 | 712 | 20.8% | 5.478 | window 2 PF 0.372 < 1.2 | new-strategy-types 2026-10-05 | NOT_APPLICABLE |

The one remaining CONSISTENT cell (US long, `B__US__long__piotroski6__regimeoff`) passes the four-window framework rule on a point-in-time universe, but under the current standards it is **not validated**: re-scored on the ever-member file with next-open entry it is INCUBATION_ELIGIBLE at k=1 (excess t 2.17, alpha t 1.07 on SPY+QQQ, beats QQQ) and fails as the research book (excess t 1.69, alpha t 0.83, does not beat QQQ). See the re-score section.

Stale rows: 816 of 1276. Cells whose every row is STALE: Hong Kong short, UK short, Germany short, France short, UK medium, Germany medium, France medium, UK long.

## Re-scored under current standards (2026-10-25)

Source: `docs/momentum-rescore-2026-10-25.md` / `scripts/momentum-rescore-results.json`. docs/strategy-gaps-amendment-2026-10-06.md (ever-member universe, PIT Piotroski filing+45d, monthly excess t, alpha t, k=1/k=2, QQQ hurdle). VALIDATION_PASS: every window with trades profitable with PF ≥ 1.2; full sample beats benchmark; monthly excess t ≥ 3; alpha t ≥ 2 (US: SPY+QQQ two-factor; UK: EWU); US must beat QQQ. INCUBATION_ELIGIBLE: positive full-sample net excess; ≥ 3 of 4 windows positive; excess t ≥ 1.5; max DD < 50%.

| Book | Variant | Verdict | Months | Full | Benchmark | Excess t | Alpha ann. | Alpha t | Max DD | Windows + | Beats QQQ | Fails on |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `US__long__12-1__piotroski6` | research | INCUBATION_ELIGIBLE | 152 | 701.9% | 329.49% | 1.69 | 3.04% | 0.83 | 25.79% | 3/4 | false | windows: -1.23%/PF 3.829, 38.6%/PF 4.511, 4.36%/PF 1.983, 32.31%/PF 12.052; excess t 1.69 < 3; alpha t 0.83 < 2; does not beat QQQ |
| `US__long__12-1__piotroski6` | k1 | INCUBATION_ELIGIBLE | 152 | 1295.15% | 329.49% | 2.17 | 5.93% | 1.07 | 28.8% | 3/4 | true | windows: -2.98%/PF 9.328, 57.82%/PF 6.498, 13.95%/PF 2.052, 43.07%/PF ∞; excess t 2.17 < 3; alpha t 1.07 < 2 |
| `US__long__12-1__piotroski6` | k2 | FAIL | 152 | 625.38% | 329.49% | 1.38 | 2.21% | 0.53 | 30.47% | 4/4 | false | excess t 1.38 < 3; alpha t 0.53 < 2; does not beat QQQ |
| `UK__long__12-1__piotroski6` | research | FAIL | 200 | 114.27% | 48.49% | 0.61 | 3.26% | 1.41 | 32.8% | 3/4 | n/a | windows: 8.65%/PF 2.078, 12.4%/PF 6.657, 9.24%/PF 5.474, -0.78%/PF 1.201; excess t 0.61 < 3; alpha t 1.41 < 2 |
| `UK__long__12-1__piotroski6` | k1 | FAIL | 200 | 230.66% | 48.49% | 1.31 | 6.2% | 2.3 | 27.59% | 4/4 | n/a | windows: 13.7%/PF 3.455, 8.78%/PF 2.706, 2.76%/PF 4.146, 1.81%/PF 0.73; excess t 1.31 < 3 |
| `UK__long__12-1__piotroski6` | k2 | FAIL | 200 | 63.86% | 48.49% | -0.04 | 1.78% | 0.84 | 30.23% | 3/4 | n/a | windows: 10.22%/PF 2.273, 9.51%/PF 1.871, 5.74%/PF 7.587, -2.24%/PF 0.712; excess t -0.04 < 3; alpha t 0.84 < 2 |
| `UK__long__12-1__plain` | research | FAIL | 200 | 226.18% | 48.49% | 1.27 | 6.24% | 2.06 | 25.05% | 4/4 | n/a | excess t 1.27 < 3 |
| `UK__long__12-1__plain` | k1 | INCUBATION_ELIGIBLE | 200 | 567.58% | 48.49% | 2.12 | 11.11% | 2.75 | 27.13% | 4/4 | n/a | windows: 3.37%/PF 1.013, 52.72%/PF ∞, 22.18%/PF ∞, 0.89%/PF 2.643; excess t 2.12 < 3 |
| `UK__long__12-1__plain` | k2 | FAIL | 200 | 273.91% | 48.49% | 1.48 | 7.1% | 2.31 | 27.16% | 4/4 | n/a | excess t 1.48 < 3 |
| `UK__medium__12-1__plain` | research | FAIL | 200 | -27.34% | 48.49% | -1.1 | -2.42% | -0.71 | 63.91% | 3/4 | n/a | windows: 9.01%/PF 1.492, 31.82%/PF 4.641, 12.53%/PF 1.571, -4.36%/PF 0.858; full sample does not beat benchmark; excess t -1.1 < 3; alpha t -0.71 < 2 |
| `UK__medium__12-1__plain` | k1 | FAIL | 200 | 3.83% | 48.49% | 0.37 | 4.59% | 0.52 | 91.27% | 2/4 | n/a | windows: -5.95%/PF 0.953, 85.08%/PF 7.573, 38.78%/PF 2.543, -25.23%/PF 0.26; full sample does not beat benchmark; excess t 0.37 < 3; alpha t 0.52 < 2 |
| `UK__medium__12-1__plain` | k2 | FAIL | 200 | 9.9% | 48.49% | 0.12 | 2.27% | 0.35 | 75.92% | 3/4 | n/a | windows: 5.61%/PF 1.36, 56.85%/PF 7.859, 16.94%/PF 1.66, -19.97%/PF 0.462; full sample does not beat benchmark; excess t 0.12 < 3; alpha t 0.35 < 2 |
| `UK__medium__12-1__plain__currentSymbols` | research | FAIL | 200 | 2.39% | 48.49% | -0.6 | -0.46% | -0.14 | 54.36% | 3/4 | n/a | windows: 17.6%/PF 2.345, 31.82%/PF 4.641, 12.53%/PF 1.571, -4.36%/PF 0.858; full sample does not beat benchmark; excess t -0.6 < 3; alpha t -0.14 < 2 |
| `UK__medium__12-1__plain__currentSymbols` | k1 | FAIL | 200 | 47.47% | 48.49% | 0.58 | 6.3% | 0.74 | 87.58% | 2/4 | n/a | windows: -5.95%/PF 0.953, 85.08%/PF 7.573, 38.78%/PF 2.543, -25.23%/PF 0.26; full sample does not beat benchmark; excess t 0.58 < 3; alpha t 0.74 < 2 |
| `UK__medium__12-1__plain__currentSymbols` | k2 | FAIL | 200 | 47.98% | 48.49% | 0.34 | 3.85% | 0.61 | 75.22% | 3/4 | n/a | windows: 10.85%/PF 1.631, 56.85%/PF 7.859, 16.94%/PF 1.66, -19.97%/PF 0.462; full sample does not beat benchmark; excess t 0.34 < 3; alpha t 0.61 < 2 |

### Reconciliation — UK medium 12-1

Same definition in both readouts: top 10 names by 12-1 momentum, one-month hold, monthly rebalance, equal weight, costs at entry. The new-strategy-types row (`B__UK__medium__momentum__regimeoff`, +21.5% "overall", "profitable in all 4 windows") was scored on the **current constituents** with close-to-close marks and its four windows cover only **2024-10-01 → 2026-10-05** — the last two years, not the sample. The earlier momentum readout's −23% / 64% max DD was the **full 2010–2026 sample**. Both describe the same book; the 4-window lens was simply the wrong one for a monthly book.

Re-scored here: ever-member universe, next-open entry — full sample **-27.34%** vs EWU 48.49%, max DD **63.91%**, excess t -1.1, alpha t -0.71; windows 9.01% · 31.82% · 12.53% · -4.36%. On the current-constituent universe the same book is 2.39% (max DD 54.36%): survivorship adds about 29.7 pp. Executable k=1 / k=2: 3.83% / 9.9% with max DD 91.27% / 75.92%.

**Which is right:** the full-sample readout. UK medium 12-1 loses to EWU over the sample on either universe, with a drawdown that would breach any risk gate. It is not a candidate; the 2026-10-22 table's "near-miss" label is withdrawn.

### UK long Piotroski ≥ 6 — coverage caveat

Dated statements exist for 100 current FTSE 100 constituents only, and 30 of the 131 priced ever-members produce a Piotroski series (most UK filers report half-yearly, which the point-in-time builder rejects as an ineligible cadence). Former members with a score: 3. The UK quality screen is therefore a ~30-name survivor book and cannot be validated under the ever-member standard. The plain 12-1 book has no such limit.

## Per-cell detail

### Hong Kong · short — NONE

Variants scored: 114.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Hong_Kong__short__sector_off` (STALE) | 0 | 4 | 75% | 43.54 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| mean_reversion | 108 | 0 | `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__full` (STALE) | 0.659 | 184 | 49.5% | 0.706 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| weekly_reversal | 4 | 0 | `C__Hong_Kong__short__worst5__regimeoff` (STALE) | 0.501 | 2310 | 45.3% | 0.88 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2.5__t5__full` **STALE** — MR close_below_lower_bb20_2 · vol_skip_top30_and_ma50_flat_or_up · 2.5 ATR stop · t5 · full. $-2856.25 / PF 0.659 / n 41 · $-673.19 / PF 0.887 / n 49 · $-5493.24 / PF 0.665 / n 94 · $127.89 / PF 1.202 / n 6. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30__sl2.5__t5__full` **STALE** — MR close_below_lower_bb20_2 · vol_skip_top30 · 2.5 ATR stop · t5 · full. $-2925.64 / PF 0.653 / n 42 · $-673.19 / PF 0.887 / n 49 · $-5493.24 / PF 0.665 / n 94 · $-22.89 / PF 0.972 / n 8. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl2__t5__full` **STALE** — MR close_below_lower_bb20_2 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t5 · full. $-3471.17 / PF 0.614 / n 41 · $-548.09 / PF 0.906 / n 49 · $-5615.85 / PF 0.66 / n 95 · $-10.8 / PF 0.986 / n 6. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30__sl2__t5__full` **STALE** — MR close_below_lower_bb20_2 · vol_skip_top30 · 2 ATR stop · t5 · full. $-3540.56 / PF 0.609 / n 42 · $-548.09 / PF 0.906 / n 49 · $-5615.85 / PF 0.66 / n 95 · $-161.58 / PF 0.832 / n 8. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Hong_Kong__short__close_below_lower_bb20_2__vol_skip_top30__sl2.5__t10__full` **STALE** — MR close_below_lower_bb20_2 · vol_skip_top30 · 2.5 ATR stop · t10 · full. $-4725.33 / PF 0.605 / n 39 · $-2499.13 / PF 0.71 / n 46 · $-6297.18 / PF 0.675 / n 90 · $-261.39 / PF 0.792 / n 8. Source verdict: NOT_CONSISTENT. BH q 1.

### UK · short — NONE

Variants scored: 114.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__UK__short__sector_off` (STALE) | 0 | 0 | 0% | 0 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| mean_reversion | 108 | 0 | `A__UK__short__close_below_lower_bb20_2__none__sl2__t10__full` (STALE) | 0.372 | 340 | 64.1% | 0.536 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| weekly_reversal | 4 | 0 | `E__UK__short__worst5__regimeoff` (STALE) | 0.555 | 2310 | 44.2% | 0.775 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `E__UK__short__worst5__regimeoff` **STALE** — Weekly reversal, worst 5. -24.14% / PF 0.555 / n 125 · -0.04% / PF 1.033 / n 125 · -20.07% / PF 0.659 / n 130 · 11.39% / PF 1.265 / n 125. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `E__UK__short__worst10__regimeoff` **STALE** — Weekly reversal, worst 10. -23.64% / PF 0.509 / n 250 · -2.55% / PF 0.974 / n 250 · -25.33% / PF 0.584 / n 260 · 3.36% / PF 1.096 / n 250. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `E__UK__short__worst5__regimeon` **STALE** — Weekly reversal, worst 5, only above 200-day MA. -19.16% / PF 0.461 / n 80 · -5.95% / PF 0.899 / n 120 · -20.07% / PF 0.659 / n 130 · 11.39% / PF 1.265 / n 125. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `A__UK__short__close_below_lower_bb20_2__none__sl2__t10__full` **STALE** — MR close_below_lower_bb20_2 · none · 2 ATR stop · t10 · full. $-11114.76 / PF 0.372 / n 91 · $-2435.68 / PF 0.822 / n 101 · $-15826.96 / PF 0.504 / n 148 · $2324.99 / PF 1.221 / n 91. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__UK__short__williams_r10_lt_minus_95__none__sl1.5__t10__full` **STALE** — MR williams_r10_lt_minus_95 · none · 1.5 ATR stop · t10 · full. $-14505.83 / PF 0.366 / n 122 · $-7208.24 / PF 0.542 / n 116 · $-8415.11 / PF 0.658 / n 158 · $-4967.25 / PF 0.741 / n 122. Source verdict: NOT_CONSISTENT. BH q 1.

### Germany · short — NONE

Variants scored: 110.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Germany__short__sector_off` (STALE) | 0 | 3 | 66.7% | 1.141 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| mean_reversion | 108 | 0 | `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` (STALE) | 0.802 | 83 | 62.7% | 0.964 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` **STALE** — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t10 · full. $20.17 / PF 1.016 / n 12 · $-538 / PF 0.896 / n 47 · $151.33 / PF 1.04 / n 24 · $-757.53 / PF 0.802 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30__sl2.5__t5__full` **STALE** — MR williams_r10_lt_minus_95 · vol_skip_top30 · 2.5 ATR stop · t5 · full. $-630.97 / PF 0.778 / n 25 · $1157.45 / PF 1.281 / n 53 · $307.74 / PF 1.082 / n 28 · $-650.88 / PF 0.849 / n 30. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t5__partial` **STALE** — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t5 · 50/50 partial. $-152.62 / PF 0.845 / n 13 · $107.12 / PF 1.021 / n 50 · $390.08 / PF 1.127 / n 24 · $-994.72 / PF 0.756 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__close_below_lower_bb20_2__vol_skip_top30__sl1.5__t5__partial` **STALE** — MR close_below_lower_bb20_2 · vol_skip_top30 · 1.5 ATR stop · t5 · 50/50 partial. $-352.14 / PF 0.776 / n 13 · $-61.26 / PF 0.989 / n 51 · $745.05 / PF 1.202 / n 34 · $-714.85 / PF 0.747 / n 20. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__short__rsi2_lt_5__vol_skip_top30__sl2.5__t10__full` **STALE** — MR rsi2_lt_5 · vol_skip_top30 · 2.5 ATR stop · t10 · full. $-913.28 / PF 0.94 / n 125 · $4366.31 / PF 1.18 / n 218 · $-8210.69 / PF 0.773 / n 202 · $-5126.25 / PF 0.741 / n 116. Source verdict: NOT_CONSISTENT. BH q 1.

### France · short — NONE

Variants scored: 114.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__France__short__sector_off` (STALE) | 0 | 1 | 100% | 99 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| mean_reversion | 108 | 0 | `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` (STALE) | 0.664 | 407 | 63.6% | 0.725 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| weekly_reversal | 4 | 0 | `E__France__short__worst10__regimeon` (STALE) | 0.629 | 3120 | 45.5% | 0.769 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` **STALE** — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · 50/50 partial. $895.31 / PF 1.131 / n 60 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-2366.14 / PF 0.835 / n 88. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__short__rsi2_lt_5__vol_skip_top30__sl2__t10__partial` **STALE** — MR rsi2_lt_5 · vol_skip_top30 · 2 ATR stop · t10 · 50/50 partial. $540.75 / PF 1.079 / n 61 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-367.74 / PF 0.977 / n 109. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__short__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__full` **STALE** — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · full. $183.31 / PF 1.027 / n 62 · $-7523.74 / PF 0.682 / n 170 · $-12290.58 / PF 0.637 / n 194 · $-3747.32 / PF 0.76 / n 92. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__short__rsi2_lt_5__vol_skip_top30__sl2__t10__full` **STALE** — MR rsi2_lt_5 · vol_skip_top30 · 2 ATR stop · t10 · full. $299.59 / PF 1.044 / n 65 · $-7523.74 / PF 0.682 / n 170 · $-12290.58 / PF 0.637 / n 194 · $-1119.77 / PF 0.934 / n 114. Source verdict: NOT_CONSISTENT. BH q 1.
- `E__France__short__worst10__regimeon` **STALE** — Weekly reversal, worst 10, only above 200-day MA. -3.95% / PF 0.786 / n 90 · -16.09% / PF 0.711 / n 240 · -18.25% / PF 0.629 / n 230 · -0.68% / PF 0.991 / n 190. Source verdict: FAIL. Beat benchmark in 1/4 windows.

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
| earnings | 8 | 0 | `A2__US__medium__react0.03_d2_h60__longsample` (STALE) | 1.053 | 3591 | 41.8% | 1.313 | STALE — old earnings event window (pre strategy-gaps amendment §3) |
| mean_reversion | 108 | 0 | `A__US__medium__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` | 0.746 | 1607 | 59.7% | 0.94 | window 1 lost money |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__US__medium__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` — MR close_below_lower_bb20_2 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t10 · full. $-23161.95 / PF 0.746 / n 633 · $61.38 / PF 1.001 / n 357 · $9361.8 / PF 1.098 / n 617 · $-7259.52 / PF 0.902 / n 439. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__US__medium__close_below_lower_bb20_2__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full` — MR close_below_lower_bb20_2 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t21 · full. $-26331.54 / PF 0.732 / n 633 · $2682.52 / PF 1.06 / n 356 · $8223.56 / PF 1.083 / n 615 · $-11606.44 / PF 0.855 / n 439. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__US__medium__close_below_lower_bb20_2__vol_skip_top30__sl1.5__t10__full` — MR close_below_lower_bb20_2 · vol_skip_top30 · 1.5 ATR stop · t10 · full. $-26815.01 / PF 0.724 / n 649 · $61.38 / PF 1.001 / n 357 · $1126.97 / PF 1.01 / n 678 · $-7259.52 / PF 0.902 / n 439. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__US__medium__rsi2_lt_5__none__sl2__t21__partial` — MR rsi2_lt_5 · none · 2 ATR stop · t21 · 50/50 partial. $-175125.34 / PF 0.722 / n 3397 · $60847.4 / PF 1.195 / n 2458 · $-44791.85 / PF 0.924 / n 3155 · $-77288.14 / PF 0.888 / n 3212. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__US__medium__rsi2_lt_5__none__sl1.5__t21__partial` — MR rsi2_lt_5 · none · 1.5 ATR stop · t21 · 50/50 partial. $-178931.04 / PF 0.721 / n 3845 · $47949.82 / PF 1.146 / n 2704 · $-52096.19 / PF 0.916 / n 3580 · $-84172.12 / PF 0.885 / n 3655. Source verdict: NOT_CONSISTENT. BH q 1.

### UK · medium — NONE

Variants scored: 118.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__UK__medium__sector_off` (STALE) | 0 | 1 | 0% | 0 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| mean_reversion | 108 | 0 | `A__UK__medium__williams_r10_lt_minus_95__none__sl1.5__t21__full` (STALE) | 0.372 | 396 | 62.9% | 0.532 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| momentum | 8 | 0 | `B__UK__medium__momentum__regimeoff` (STALE) | 1.149 | 1060 | 51.2% | 1.105 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `B__UK__medium__momentum__regimeoff` **STALE** — 12-1 momentum. 4.26% / PF 1.288 / n 60 · 15.04% / PF 2.119 / n 60 · 15.53% / PF 1.714 / n 70 · 1.77% / PF 1.149 / n 50. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.
- `B__UK__medium__piotroski6__regimeoff` **STALE** — 12-1 momentum among Piotroski ≥ 6. 1.48% / PF 1.111 / n 60 · 3.62% / PF 1.198 / n 56 · 8.64% / PF 1.451 / n 70 · 2.58% / PF 1.252 / n 50. Source verdict: CANDIDATE. Beat benchmark in 3/4 windows.
- `B__UK__medium__momentum__regimeoff__longsample` **STALE** — 12-1 momentum. 2.5% / PF 1.156 / n 60 · 22.92% / PF 3.051 / n 60 · 10.13% / PF 1.548 / n 60 · -1.91% / PF 0.949 / n 60. Source verdict: CANDIDATE. Beat benchmark in 3/4 windows.
- `B__UK__medium__piotroski6__regimeoff__longsample` **STALE** — 12-1 momentum among Piotroski ≥ 6. -1.6% / PF 0.938 / n 60 · 9.94% / PF 1.785 / n 56 · 7.11% / PF 1.434 / n 60 · 1.63% / PF 1.131 / n 60. Source verdict: FAIL. Beat benchmark in 1/4 windows.
- `B__UK__medium__piotroski6__regimeon` **STALE** — 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA. -5.29% / PF 0.626 / n 40 · 3.62% / PF 1.198 / n 56 · 8.64% / PF 1.451 / n 70 · 2.58% / PF 1.252 / n 50. Source verdict: FAIL. Beat benchmark in 2/4 windows.

### Germany · medium — NONE

Variants scored: 110.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__Germany__medium__sector_off` (STALE) | 0 | 4 | 75% | 6.306 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| mean_reversion | 108 | 0 | `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full` (STALE) | 0.939 | 82 | 64.6% | 0.986 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t21__full` **STALE** — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t21 · full. $20.17 / PF 1.016 / n 12 · $-318 / PF 0.939 / n 46 · $151.33 / PF 1.04 / n 24 · $425.27 / PF 1.117 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl1.5__t10__full` **STALE** — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 1.5 ATR stop · t10 · full. $20.17 / PF 1.016 / n 12 · $-538 / PF 0.896 / n 47 · $151.33 / PF 1.04 / n 24 · $-757.53 / PF 0.802 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl2__t21__full` **STALE** — MR williams_r10_lt_minus_95 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t21 · full. $-349.07 / PF 0.787 / n 12 · $-135.99 / PF 0.974 / n 43 · $-1001.11 / PF 0.797 / n 24 · $-541.23 / PF 0.882 / n 28. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__williams_r10_lt_minus_95__vol_skip_top30__sl2.5__t21__full` **STALE** — MR williams_r10_lt_minus_95 · vol_skip_top30 · 2.5 ATR stop · t21 · full. $-368.18 / PF 0.878 / n 23 · $156.78 / PF 1.029 / n 46 · $-1426.28 / PF 0.771 / n 28 · $515.41 / PF 1.119 / n 29. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__Germany__medium__close_below_lower_bb20_2__vol_skip_top30__sl1.5__t21__full` **STALE** — MR close_below_lower_bb20_2 · vol_skip_top30 · 1.5 ATR stop · t21 · full. $-416.04 / PF 0.769 / n 13 · $-922.75 / PF 0.864 / n 51 · $2070.56 / PF 1.498 / n 34 · $-838.25 / PF 0.782 / n 22. Source verdict: NOT_CONSISTENT. BH q 1.

### France · medium — NONE

Variants scored: 118.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__France__medium__sector_on` (STALE) | 0 | 7 | 28.6% | 0.24 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| mean_reversion | 108 | 0 | `A__France__medium__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` (STALE) | 0.664 | 407 | 63.6% | 0.725 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| momentum | 8 | 0 | `B__France__medium__momentum__regimeoff__longsample` (STALE) | 0.92 | 1890 | 50.6% | 1.145 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `B__France__medium__momentum__regimeoff__longsample` **STALE** — 12-1 momentum. 3.85% / PF 1.276 / n 60 · 2.46% / PF 1.217 / n 60 · -2.41% / PF 0.937 / n 60 · -2.37% / PF 0.92 / n 60. Source verdict: FAIL. Beat benchmark in 2/4 windows.
- `B__France__medium__momentum__regimeoff` **STALE** — 12-1 momentum. 5.99% / PF 1.499 / n 60 · -4.91% / PF 0.705 / n 60 · 1.46% / PF 1.108 / n 70 · 0.62% / PF 1.051 / n 50. Source verdict: CANDIDATE. Beat benchmark in 3/4 windows.
- `A__France__medium__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__partial` **STALE** — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · 50/50 partial. $895.31 / PF 1.131 / n 60 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-2366.14 / PF 0.835 / n 88. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__medium__rsi2_lt_5__vol_skip_top30__sl2__t10__partial` **STALE** — MR rsi2_lt_5 · vol_skip_top30 · 2 ATR stop · t10 · 50/50 partial. $540.75 / PF 1.079 / n 61 · $-7358.53 / PF 0.664 / n 161 · $-10088.6 / PF 0.678 / n 186 · $-367.74 / PF 0.977 / n 109. Source verdict: NOT_CONSISTENT. BH q 1.
- `A__France__medium__rsi2_lt_5__vol_skip_top30_and_ma50_flat_or_up__sl2__t10__full` **STALE** — MR rsi2_lt_5 · vol_skip_top30_and_ma50_flat_or_up · 2 ATR stop · t10 · full. $183.31 / PF 1.027 / n 62 · $-7523.74 / PF 0.682 / n 170 · $-12290.58 / PF 0.637 / n 194 · $-3747.32 / PF 0.76 / n 92. Source verdict: NOT_CONSISTENT. BH q 1.

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

### UK · long — NONE

Variants scored: 10.

| Family | Variants | Consistent | Best variant | Worst PF | Pooled n | Pooled WR | Pooled PF | Fails on |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| current_engine | 2 | 0 | `B__UK__long__sector_off` (STALE) | 0 | 0 | 0% | 0 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |
| momentum | 8 | 0 | `B__UK__long__piotroski6__regimeoff` (STALE) | 1.478 | 975 | 52.4% | 1.478 | STALE — current-constituent universe (pre survivorship fix); re-score on the ever-member file |

Top five rows (window 1 · 2 · 3 · 4, PnL or book return / PF / trades):

- `B__UK__long__piotroski6__regimeoff` **STALE** — 12-1 momentum among Piotroski ≥ 6. 10.15% / PF 2.013 / n 60 · 5.93% / PF 5.41 / n 60 · 14.44% / PF 7.015 / n 66 · 2.09% / PF 1.478 / n 50. Source verdict: PASS. Beat benchmark in 3/4 windows. Framework rule alone would pass; STALE because of the universe/window.
- `B__UK__long__piotroski6__regimeoff__longsample` **STALE** — 12-1 momentum among Piotroski ≥ 6. 7.55% / PF 1.894 / n 60 · 13.54% / PF 7.605 / n 60 · 10.87% / PF 6.71 / n 56 · 0.37% / PF 1.408 / n 60. Source verdict: PASS. Beat benchmark in 4/4 windows. Framework rule alone would pass; STALE because of the universe/window.
- `B__UK__long__piotroski6__regimeon` **STALE** — 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA. -0.63% / PF 1.395 / n 40 · 4.2% / PF 4.798 / n 40 · 14.44% / PF 7.015 / n 66 · 2.09% / PF 1.478 / n 50. Source verdict: FAIL. Beat benchmark in 2/4 windows.
- `B__UK__long__piotroski6__regimeon__longsample` **STALE** — 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA. -1.74% / PF 1.272 / n 40 · 10.28% / PF 8.404 / n 40 · 10.87% / PF 6.71 / n 56 · 0.37% / PF 1.408 / n 60. Source verdict: FAIL. Beat benchmark in 2/4 windows.
- `B__UK__long__momentum__regimeoff` **STALE** — 12-1 momentum. 6.89% / PF 1.091 / n 60 · 15.63% / PF 3.697 / n 60 · 13.18% / PF 10.21 / n 70 · 15.11% / PF 2.426 / n 50. Source verdict: CANDIDATE. Beat benchmark in 4/4 windows.

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

