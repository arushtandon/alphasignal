# Stage 1 Fidelity Audit

Range: 2026-08-01 through 2026-09-29 (inclusive).
Parity comparison: 2026-09-10 through 2026-09-29; Danelfin retired from live scoring on 2026-09-09.
Backtest-only. No live history, preregistration, or execution behavior changed.

US universe: 518 current symbols / 808 PIT candidates; FMP historical membership available.

## History intake
Raw Buy/Sell rows: 149. Unparseable dates: 0. Unmapped tickers: 16. Pre-Danelfin-cutover rows excluded: 9.
| Market | Horizon | In requested range | Used by parity audit | Pre-cutover excluded |
| --- | --- | ---: | ---: | ---: |
| Germany | short | 1 | 0 | 1 |
| Hong Kong | medium | 1 | 0 | 1 |
| Hong Kong | short | 1 | 0 | 1 |
| Japan | long | 1 | 1 | 0 |
| Japan | short | 3 | 0 | 3 |
| US | long | 2 | 0 | 2 |
| US | short | 1 | 0 | 1 |

### Unmapped tickers
- INDUSINDBK.NS short: 2026-07-25
- BAJFINANCE.NS short: 2026-07-25
- NESTLEIND.NS medium: 2026-07-15
- HINDUNILVR.NS long: 2026-07-15
- ADANIENT.NS medium: 2026-07-16
- SUNPHARMA.NS medium: 2026-07-08
- KOTAKBANK.NS medium: 2026-07-08
- LT.NS long: 2026-07-07
- AXISBANK.NS long: 2026-07-07
- TECHM.NS short: 2026-07-07
- ASIANPAINT.NS short: 2026-06-17
- NESTLEIND.NS short: 2026-06-17
- EICHERMOT.NS short: 2026-06-17
- DRREDDY.NS medium: 2026-06-17
- DIVISLAB.NS long: 2026-06-17
- HDFCBANK.NS medium: 2026-06-17
## Exact-match results
| Market | Matched | Missed | Extra |
| --- | ---: | ---: | ---: |
| US | 0 | 0 | 5 |
| Japan | 0 | 1 | 5 |
| Hong Kong | 0 | 0 | 4 |
| UK | 0 | 0 | 0 |
| Germany | 0 | 0 | 4 |
| France | 0 | 0 | 23 |

Short-horizon history picks included after the dated scope amendment: 0.

## US / UK gate diagnostics
The production engine combines fundamental, structural, and Supertrend effects into its final score; these overlapping counts are diagnostics, not a sequential funnel.
| Market | Decisions | Score <62 | Conf <62 | RR | Supertrend unaligned | Overlay reduced <62 | Market policy | Pio unavailable | Altman unavailable | Missing data | Eligible |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| US | 19461 | 18810 | 12756 | 234 | 13455 | 927 | 271 | 0 | 0 | 4092 | 5 |
| UK | 3582 | 3488 | 2969 | 47 | 2200 | 263 | 22 | 0 | 0 | 2376 | 0 |

## Comparability note
The replay list is the production per-symbol entry ledger before daily board selection. History contains only published server-board picks after shortlist limits, top-five pane ranking, cross-horizon deduplication, open-position suppression, rotation, board lock, live-price repricing, and the final history writer checks. Without dated board snapshots and shortlist/open-position state, raw replay extras cannot be classified as live false positives. They are reported as unselected raw opportunities, not parity failures.

## Matched
| Market | Ticker | Horizon | Side | Date |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

## Missed live picks and current PIT funnel
| Market | Ticker | Horizon | Side | Date | Current gate | Reasons |
| --- | --- | --- | --- | --- | --- | --- |
| Japan | 9532.T | long | buy | 2026-09-23 | NOT_EVALUATED | No bar for exact UTC decision date |

## Extra current PIT picks
| Market | Ticker | Horizon | Side | Date |
| --- | --- | --- | --- | --- |
| US | GNRC | medium | sell | 2026-09-16 |
| US | HUBB | medium | sell | 2026-09-15 |
| US | LOW | medium | sell | 2026-09-16 |
| US | QCOM | medium | buy | 2026-09-14 |
| US | RKLB | medium | sell | 2026-09-16 |
| Japan | 4042.T | medium | buy | 2026-09-10 |
| Japan | 6326.T | short | buy | 2026-09-10 |
| Japan | 6326.T | short | buy | 2026-09-14 |
| Japan | 9503.T | short | buy | 2026-09-29 |
| Japan | 9532.T | long | buy | 2026-09-15 |
| Hong Kong | 0688.HK | medium | sell | 2026-09-11 |
| Hong Kong | 0016.HK | medium | sell | 2026-09-11 |
| Hong Kong | 0016.HK | medium | sell | 2026-09-14 |
| Hong Kong | 0868.HK | medium | sell | 2026-09-22 |
| Germany | HEN3.DE | long | buy | 2026-09-14 |
| Germany | HEI.DE | medium | sell | 2026-09-15 |
| Germany | HEI.DE | medium | sell | 2026-09-17 |
| Germany | PAH3.DE | medium | sell | 2026-09-28 |
| France | MC.PA | medium | sell | 2026-09-17 |
| France | MC.PA | medium | sell | 2026-09-21 |
| France | MC.PA | medium | sell | 2026-09-22 |
| France | MC.PA | medium | sell | 2026-09-23 |
| France | MC.PA | medium | sell | 2026-09-24 |
| France | MC.PA | medium | sell | 2026-09-25 |
| France | MC.PA | long | sell | 2026-09-14 |
| France | MC.PA | long | sell | 2026-09-15 |
| France | MC.PA | long | sell | 2026-09-16 |
| France | MC.PA | long | sell | 2026-09-17 |
| France | MC.PA | long | sell | 2026-09-21 |
| France | MC.PA | long | sell | 2026-09-22 |
| France | MC.PA | long | sell | 2026-09-23 |
| France | MC.PA | long | sell | 2026-09-24 |
| France | KER.PA | medium | sell | 2026-09-22 |
| France | KER.PA | medium | sell | 2026-09-23 |
| France | KER.PA | medium | sell | 2026-09-24 |
| France | KER.PA | medium | sell | 2026-09-25 |
| France | RMS.PA | medium | sell | 2026-09-10 |
| France | BN.PA | medium | sell | 2026-09-24 |
| France | BN.PA | long | sell | 2026-09-23 |
| France | BN.PA | long | sell | 2026-09-24 |
| France | BN.PA | long | sell | 2026-09-28 |

Machine-readable report: scripts\stage1-fidelity-audit-results.json
