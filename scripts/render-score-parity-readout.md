# Render Live Pick Score Parity Audit

Backtest-only. This report reads Render history with a machine bearer token and does not mutate Render, the live engine, orders, or strategy rules.
Render history: 1939 rows fetched 2026-10-02T10:58:18.424Z; source https://alphasignal-dvg5.onrender.com.
Comparison scope: every Buy/Sell recommendation with Singapore recommendation day from 2026-09-10 (Danelfin retired 2026-09-09).

## Distribution: current history snapshot minus causal replay
These deltas are diagnostic, not publication-time parity evidence, when score provenance is MUTABLE_REVALIDATED.
| Market | Horizon | Picks | Replayed | Score Δ n / min / median / max / mean | Conf Δ n / min / median / max / mean | Statuses |
| --- | --- | ---: | ---: | --- | --- | --- |
| Commodities | long | 2 | 0 | 0/UNKNOWN/UNKNOWN/UNKNOWN/UNKNOWN | 0/UNKNOWN/UNKNOWN/UNKNOWN/UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET:2 |
| France | long | 1 | 1 | 1/13/13/13/13.00 | 1/28/28/28/28.00 | MATCHED_DECISION_DATE:1 |
| Hong Kong | short | 1 | 1 | 1/-65/-65/-65/-65.00 | 1/0/0/0/0.00 | MATCHED_DECISION_DATE:1 |
| India | medium | 5 | 0 | 0/UNKNOWN/UNKNOWN/UNKNOWN/UNKNOWN | 0/UNKNOWN/UNKNOWN/UNKNOWN/UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET:5 |
| Japan | long | 1 | 1 | 1/-68/-68/-68/-68.00 | 1/0/0/0/0.00 | MATCHED_DECISION_DATE:1 |
| Japan | medium | 6 | 6 | 6/-27/1.5/37/4.17 | 6/4/11/28/14.67 | MATCHED_DECISION_DATE:6 |
| Japan | short | 2 | 2 | 2/-61/-48.5/-36/-48.50 | 2/0/6/12/6.00 | MATCHED_DECISION_DATE:2 |

## Component interpretation
For each matched replay decision, the JSON contains base technical score (before the quality/structural overlay), the resulting overlay delta, Supertrend state, market tier, PIT Piotroski/Altman values, conditions, and canonical gate. The production signal does not expose a numeric per-condition contribution, so this audit does not invent one.
- History horizon scores are mutable: applyAnalyticsSnapshotToTrade overwrites them during revalidation. Rows marked MUTABLE_REVALIDATED do not preserve the publication-time score and cannot establish original recommendation-score parity.
- The replay injects cache-derived PIT Piotroski and Altman Z. Render history stores the live FMP snapshot/score captured at recommendation time; these are intentionally not the same time-series source.
- The replay has historical benchmark regime but no dated live board shortlist, open-position suppression, board lock, live quote repricing, or publication-time cross-horizon selection state.
- No dated sector and company-earnings overlay event stream is injected into this audit; those live inputs are therefore UNKNOWN rather than treated as parity failures.

## Every post-cutover live pick
| Ticker | Market | Horizon | Side | SGT recommendation | Signal bar | History score | Provenance | Replay score | Δ score | History Conf | Replay Conf | Δ Conf | Status |
| --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 3407.T | Japan | medium | buy | 2026-10-02 | 2026-10-01 | 69 | MUTABLE_REVALIDATED | 63 | 6 | 66 | 50 | 16 | MATCHED_DECISION_DATE |
| 9503.T | Japan | short | buy | 2026-09-30 | 2026-09-29 | 11 | MUTABLE_REVALIDATED | 72 | -61 | 62 | 62 | 0 | MATCHED_DECISION_DATE |
| 9744.T | Japan | medium | buy | 2026-09-29 | 2026-09-28 | 45 | MUTABLE_REVALIDATED | 72 | -27 | 66 | 62 | 4 | MATCHED_DECISION_DATE |
| 9007.T | Japan | medium | buy | 2026-09-28 | 2026-09-25 | 47 | MUTABLE_REVALIDATED | 72 | -25 | 62 | 56 | 6 | MATCHED_DECISION_DATE |
| EICHERMOT.NS | India | medium | buy | 2026-09-24 | UNKNOWN | 30 | MUTABLE_REVALIDATED | UNKNOWN | UNKNOWN | 62 | UNKNOWN | UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET |
| 9532.T | Japan | long | buy | 2026-09-24 | 2026-09-18 | 4 | MUTABLE_REVALIDATED | 72 | -68 | 65 | 65 | 0 | MATCHED_DECISION_DATE |
| GRASIM.NS | India | medium | buy | 2026-09-22 | UNKNOWN | 45 | MUTABLE_REVALIDATED | UNKNOWN | UNKNOWN | 62 | UNKNOWN | UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET |
| 8604.T | Japan | short | buy | 2026-09-18 | 2026-09-17 | 25 | MUTABLE_REVALIDATED | 61 | -36 | 62 | 50 | 12 | MATCHED_DECISION_DATE |
| 5901.T | Japan | medium | buy | 2026-09-18 | 2026-09-17 | 61 | MUTABLE_REVALIDATED | 24 | 37 | 70 | 42 | 28 | MATCHED_DECISION_DATE |
| APOLLOHOSP.NS | India | medium | buy | 2026-09-17 | UNKNOWN | 66 | MUTABLE_REVALIDATED | UNKNOWN | UNKNOWN | 62 | UNKNOWN | UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET |
| BZ=F | Commodities | long | buy | 2026-09-17 | UNKNOWN | 35 | MUTABLE_REVALIDATED | UNKNOWN | UNKNOWN | 65 | UNKNOWN | UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET |
| CL=F | Commodities | long | buy | 2026-09-17 | UNKNOWN | 0 | MUTABLE_REVALIDATED | UNKNOWN | UNKNOWN | 65 | UNKNOWN | UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET |
| STMPA.PA | France | long | buy | 2026-09-17 | 2026-09-16 | 13 | MUTABLE_REVALIDATED | 0 | 13 | 70 | 42 | 28 | MATCHED_DECISION_DATE |
| TITAN.NS | India | medium | buy | 2026-09-16 | UNKNOWN | 38 | MUTABLE_REVALIDATED | UNKNOWN | UNKNOWN | 62 | UNKNOWN | UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET |
| 0267.HK | Hong Kong | short | buy | 2026-09-15 | 2026-09-14 | 7 | MUTABLE_REVALIDATED | 72 | -65 | 62 | 62 | 0 | MATCHED_DECISION_DATE |
| 9432.T | Japan | medium | buy | 2026-09-11 | 2026-09-10 | 48 | MUTABLE_REVALIDATED | 51 | -3 | 62 | 56 | 6 | MATCHED_DECISION_DATE |
| 5301.T | Japan | medium | buy | 2026-09-10 | 2026-09-09 | 61 | MUTABLE_REVALIDATED | 24 | 37 | 70 | 42 | 28 | MATCHED_DECISION_DATE |
| DIVISLAB.NS | India | medium | buy | 2026-09-10 | UNKNOWN | 61 | MUTABLE_REVALIDATED | UNKNOWN | UNKNOWN | 62 | UNKNOWN | UNKNOWN | NO_REPLAY_COVERAGE_FOR_MARKET |

## Previously omitted cited picks
- 8604.T short buy (2026-09-18): present in authoritative Render history; MATCHED_DECISION_DATE; history score provenance MUTABLE_REVALIDATED. The earlier local audit used a stale local history snapshot and therefore did not examine it.
- 5901.T medium buy (2026-09-18): present in authoritative Render history; MATCHED_DECISION_DATE; history score provenance MUTABLE_REVALIDATED. The earlier local audit used a stale local history snapshot and therefore did not examine it.

Unparseable history dates: 0. Unmapped ticker/horizon rows: 6.
Machine-readable details: scripts\render-score-parity-results.json.
