# Omitted-geography rescue study preregistration

Frozen: 25 September 2026, before any data retrieval or rescue-study run.

## Scope and live guardrail

This is a backtest-only study of France, Germany, Hong Kong, the UK, and
commodities. It makes no change to the live recommendation engine, published
brackets, or paused sell books.

## Fresh holdout ledger

Prior research artifacts used rolling test windows through 24 September 2026,
including the latest 26 March–24 September 2026 final holdout. The final
rescue-study holdout is the latest earlier 126-session window outside those
recorded test and validation windows: 21 March–15 September 2023, subject to
the final benchmark-calendar alignment recorded in the result JSON. It is
never used for model selection.

The development folds immediately preceding it use 504 training sessions, 126
validation sessions, a horizon-specific embargo, and 126 out-of-sample test
sessions. No candidate may inspect the final-holdout metrics before selection.

## Execution and costs

- Daily OHLCV; next-session-open entries; same-bar stop before target.
- Existing $10,000-notional cost model and no same-symbol overlap.
- Existing production/MR long entry and exit logic is replayed unchanged for
  the expansion baseline. New factors are gates only.
- Benjamini–Hochberg control is applied across every eligible cell in this
  study, not across ineligible factor/horizon combinations.

## Research-only universe expansion

- France: CAC 40 plus a static, audited SBF 120 registry.
- Germany: DAX plus a static, audited HDAX registry.
- Commodities: existing contracts plus liquid continuous contracts and broad or
  sector commodity ETFs. Each symbol and economic exposure is listed in output.

Only successfully loaded instruments with sufficient history count toward
sample breadth. The output reports requested, loaded, and traded counts.

## Frozen horizon eligibility

| Factor | Short | Medium | Long |
|---|---|---|---|
| Liquidity top decile | Eligible | Eligible | Eligible |
| HK Southbound net flow / acceleration | Ineligible | Eligible, buy only | Eligible, buy only |
| HK A/H discount | Ineligible | Eligible, buy only | Eligible, buy only |
| UK domestic versus overseas partition | Ineligible | Eligible, buy only | Eligible, buy only |
| Weak-GBP overlay for UK overseas earners | Ineligible | Eligible, buy only | Eligible, buy only |
| Earnings / fundamental momentum | Ineligible | Eligible only with verified PIT FMP | Eligible only with verified PIT FMP |

Every factor requested outside this matrix is emitted as
`ineligible: factor-horizon mismatch`; it is not run. UK short and HK short are
price-only with the liquidity filter as their only rescue overlay.

## Candidate registry

1. Expanded-universe baseline, unchanged production/MR long logic.
2. Baseline plus top-decile trailing 20-session dollar-volume filter.
3. HK medium/long buy: baseline plus point-in-time Southbound flow gate.
4. HK medium/long buy: baseline plus pre-mapped A/H discount gate.
5. UK medium/long buy: domestic and overseas partitions as separate cells.
6. UK overseas medium/long buy: partition plus weak-GBP trend gate.
7. Medium/long earnings/fundamental gate only if the FMP capability report
   contains timestamped historical observations.

The full candidate list, including any data-gated skips, is written into the
result JSON before metrics. The final holdout cannot select a candidate.

## Promotion rule

Every candidate requires holdout win rate at least 60%, PF at least 1.3, and
positive net PnL, plus BH MTC survival.

- **FULL**: holdout n >= 30, and at least two development tests independently
  have win rate >=60%, PF >=1.3, and positive PnL.
- **THIN**: holdout n 15–29, one-sided exact binomial p <0.05 versus 50%,
  PF >=1.6, positive PnL, and at least two independently qualifying
  development tests.
- **FAIL**: all other outcomes.

Each cell reports n, win rate, PF, PnL, average win, average loss,
fold-by-fold win/PF/PnL, sample confidence, factor eligibility, and promotion
decision. A cell with win rate >=60% only because PF is below 1.3 is named as a
rejected bleeder.
