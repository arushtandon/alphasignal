# Omitted-geography rescue readout

Run: 2026-09-25T11:38:59.209Z

Backtest only. No live rule, live bracket, or paused sell-book setting changed.

## Per-cell holdout results

| Geography | Horizon | Model | n | Win % | PF | PnL | Avg win % | Avg loss % | Confidence | Decision |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| France | short | rsi2_lt_5__prior_close__t3__sl2__full | 174 | 37.4 | 0.553 | -3245.41 | 0.618 | -0.666 | FAIL | promotion thresholds or sample-confidence safeguard not met |
| France | medium | rsi2_lt_5__ma20__t21__sl2.5__full | 113 | 53.1 | 0.531 | -9083.96 | 1.717 | -3.658 | FAIL | promotion thresholds or sample-confidence safeguard not met |
| Germany | short | williams_r10_lt_minus_95__one_atr__t10__sl2.5__full | 32 | 62.5 | 0.93 | -307.47 | 2.052 | -3.676 | FAIL | rejected bleeder: win target with PF below 1.3 |
| Germany | medium | williams_r10_lt_minus_95__one_atr__t21__sl2.5__full | 31 | 71 | 0.991 | -43.96 | 2.223 | -5.484 | FAIL | rejected bleeder: win target with PF below 1.3 |
| HK | short | close_below_lower_bb20_2__one_atr__t10__sl2.5__full | 11 | 72.7 | 1.755 | 767.17 | 2.229 | -3.388 | FAIL | promotion thresholds or sample-confidence safeguard not met |
| HK | medium | close_below_lower_bb20_2__one_atr__t21__sl2.5__partial | 9 | 77.8 | 1.836 | 1045.61 | 3.28 | -6.253 | FAIL | promotion thresholds or sample-confidence safeguard not met |
| UK | short | rsi2_lt_5__prior_close__t3__sl2__full | 568 | 15.8 | 0.136 | -47534.27 | 0.834 | -1.151 | FAIL | promotion thresholds or sample-confidence safeguard not met |
| UK | medium | rsi2_lt_5__prior_close__t10__sl2__full | 557 | 18.9 | 0.169 | -43345.14 | 0.841 | -1.154 | FAIL | promotion thresholds or sample-confidence safeguard not met |
| Commodities | short | rsi2_lt_5__prior_close__t3__sl2__full | 229 | 27.1 | 0.211 | -15891.14 | 0.687 | -1.206 | FAIL | promotion thresholds or sample-confidence safeguard not met |
| Commodities | medium | rsi2_lt_5__prior_close__t10__sl2__full | 216 | 30.6 | 0.263 | -15634.16 | 0.844 | -1.414 | FAIL | promotion thresholds or sample-confidence safeguard not met |

## PROMOTABLE

None. The trailing holdout overlaps prior studies, so any metric pass is candidate-only.

## REJECTED

- France short buy: promotion thresholds or sample-confidence safeguard not met.
- France medium buy: promotion thresholds or sample-confidence safeguard not met.
- Germany short buy: rejected bleeder: win target with PF below 1.3.
- Germany medium buy: rejected bleeder: win target with PF below 1.3.
- HK short buy: promotion thresholds or sample-confidence safeguard not met.
- HK medium buy: promotion thresholds or sample-confidence safeguard not met.
- UK short buy: promotion thresholds or sample-confidence safeguard not met.
- UK medium buy: promotion thresholds or sample-confidence safeguard not met.
- Commodities short buy: promotion thresholds or sample-confidence safeguard not met.
- Commodities medium buy: promotion thresholds or sample-confidence safeguard not met.

## NOT EVALUABLE

None.

## RETIRE

- France: no retirement decision: trailing holdout overlap risk.
- Germany: no retirement decision: trailing holdout overlap risk.
- HK: no retirement decision: trailing holdout overlap risk.
- UK: no retirement decision: trailing holdout overlap risk.
- Commodities: no retirement decision: trailing holdout overlap risk.

## Data-gated factors

- France SBF-120 and Germany HDAX expansion were not represented as successful tests until dated pre-holdout constituent snapshots are supplied; using today’s membership would be survivorship bias.
- HK Southbound/A-H, UK revenue/GBP, and FMP earnings gates are reported as unavailable/ineligible unless their dated point-in-time sources are verified.
- Ineligible factor-horizon combinations were not tested by construction.
