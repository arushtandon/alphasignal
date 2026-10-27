# Consistency-first all-market study — pre-registration

Frozen: 2026-10-05, before any consistency-study run.

This study replaces the Japan-only follow-up. It is backtest-only. Paper
candidates may be designed from CONSISTENT cells, but they are not enabled.

Amendment recorded 2026-10-05 after the first mechanical score pass and before
accepting any result: the original text below incorrectly limited consistency
and ranking to development windows. The user's frozen instruction says “every
window,” so consistency and worst-window ranking use all four windows. The
final window remains separately displayed and labelled `OVERLAP_RISK`.
Benjamini–Hochberg p-values use the pooled development sample, not the final
window. This correction changes no signal, exit, cost, universe, fold, or
variant and was applied uniformly to the frozen 1,982-cell family.

Long-horizon scoring amendment frozen 2026-10-05 15:34 SGT, before the
go-live prerequisite replay: for the live trend engine's long-horizon buy
book, a trade belongs to the test window containing its **entry date**. Its
exit may occur after that window ends. The existing 180-session embargo,
next-open entry, implementation costs, same-symbol overlap rule, universes,
signals, and exits remain unchanged. The replay reports sector-overlay OFF
for Japan, Hong Kong, Germany, France, Commodities, and India separately and
as one pooled book. Eligibility requires positive PnL and PF >= 1.2 in every
window of the pooled book.

## Scope

Markets: US, Japan, Hong Kong, UK, Germany, France, India, Commodities, Crypto.

- US uses the point-in-time S&P 500 + Nasdaq 100 research snapshot and
  `membershipAt`.
- Non-US index lists use dated membership only if an authenticated FMP endpoint
  provides it. Otherwise results are labelled `SURVIVORSHIP_BIAS`.
- Commodities comprise the existing continuous futures plus
  `ZW=F,ZC=F,ZS=F,GLD,SLV,USO,UNG,DBC,PDBC,GSG,DBA,WEAT,COPX`.
- Crypto is `BTC-USD,ETH-USD`.
- India and crypto paper candidates remain signals-only.
- Part A uses price data only; no FMP quality overlay.

## Common protocol

- Four date-aligned folds: 504 training, 126 validation, 126 test sessions.
- Embargo: short 20, medium 63, long 180 sessions.
- Next-open entry, `implementation-cost-v1`, stop-first, and no overlapping
  same-symbol positions within each scored window.
- The first three test windows are development windows. They are reported
  separately and pooled once. The final test window is reported separately as
  `OVERLAP_RISK`; under the amendment above it participates in the literal
  all-window consistency check and worst-window ranking.
- One Benjamini–Hochberg family (`alpha=0.05`) includes every Part A, B and C
  variant in this study.

## Part A — mean-reversion consistency grid

Short and medium, buy side, every market.

Common structural gates: close above SMA200; benchmark not down/risk-off;
sector/asset proxy not below SMA200 with falling SMA50; valid ATR and next open.
Entries are computed once per trigger/filter, then exit variants are applied.

- Trigger: `rsi2_lt_5`, `close_below_lower_bb20_2`,
  `williams_r10_lt_minus_95`.
- Regime: `none`, `vol_skip_top30`,
  `vol_skip_top30_and_ma50_flat_or_up`.
- Stop: 1.5, 2.0, 2.5 ATR.
- Time stop: short 5/10 bars; medium 10/21 bars.
- Target: entry plus 1 ATR.
- Realisation: full target or 50% at target plus 50% runner to +2 ATR with stop
  moved to entry.

Part A family size: 9 entry definitions × 12 exits × 2 horizons × 9 markets =
1,944 variants.

## Part B — exact live trend engine, sector overlay on versus off

Medium and long, buy side, every market. Both variants use the same production
`backtestSignal`, score/confidence/RR gates and live hybrid exit.

- `sector_off`: country/asset benchmark only.
- `sector_on`: `sectorEtfForSymbol` regime, falling back to country benchmark.

Japan long is reconciled against performance-program v3 Part B (58 development
trades, reported PF 1.817; earlier summaries rounded/referred to ~2.09). The
report must attribute differences to sector-regime input, PIT quality
injection, fold containment, or overlap policy.

Part B family size: 2 variants × 2 horizons × 9 markets = 36 variants.

## Part C — US Wave 3 survivorship check

Wave 3 long-buy baseline, identical windows and exits:

- old 68-name `US_CORE`;
- full point-in-time US research universe.

Part C family size: 2 variants.

Total frozen BH family size: 1,982 variants.

## Consistency and ranking

Every development window and the final window reports trades, win %, PF, PnL,
average win/loss, breakeven win rate
`abs(avgLoss)/(avgWin+abs(avgLoss))`, and win-rate margin over breakeven.

- MR is `CONSISTENT` only if every window is profitable and has
  win rate at least 60%.
- Trend is `CONSISTENT` only if every window is profitable and has
  PF at least 1.2.
- Rank CONSISTENT variants by worst all-window PF, then by smaller
  absolute average loss. Total PnL is diagnostic only.

## Paper candidates

Each best CONSISTENT market × horizon cell is designed as a tagged paper-only
book with frozen rules and a separate PnL view. Nothing is enabled.

Forward pass requires:

- at least 30 closed trades;
- profitable overall;
- win rate at least breakeven plus 5 percentage points;
- no two-month stretch losing more than one average month's gain.

