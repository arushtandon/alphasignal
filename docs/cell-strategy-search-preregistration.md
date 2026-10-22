# Cell strategy search — pre-registration

Frozen: 2026-10-22, before any scoring run. Research only. No live signal,
setup-book cell, bracket, order, flag, or deployment setting is changed by this
study.

## Question

For the market × horizon cells that have no live setup today, which strategy
family gives the best result under the framework already used for the live
setup book?

| Horizon | Markets requested |
| --- | --- |
| Short | Hong Kong, UK, Germany, France (Europe), Commodities, Crypto |
| Medium | US, UK, Germany, France (Europe), Crypto |
| Long | US, UK, Crypto |

Europe is scored as Germany and France separately, as every prior study did.
Twelve cells in total (14 market × horizon rows).

## Same framework, per horizon

The protocol is the consistency-first study protocol, unchanged:

- Four date-aligned folds: 504 training, 126 validation, 126 test sessions.
- Embargo: short 20, medium 63, long 180 sessions.
- Next-open entry, `implementation-cost-v1`, stop-first, no overlapping
  same-symbol positions inside a scored window, $10,000 notional per trade.
- The three development windows are reported separately and pooled once; the
  final window is reported separately and labelled `OVERLAP_RISK`.
- Consistency: mean reversion is `CONSISTENT` only when every one of the four
  windows is profitable with win rate ≥ 60%; trend, momentum, breakout and
  reversal books are `CONSISTENT` only when every window is profitable with
  profit factor ≥ 1.2.
- Ranking inside a cell: `CONSISTENT` first, then worst all-window PF, then
  smaller absolute average loss. Total PnL is diagnostic only.
- Sell books stay paused; everything here is buy side.

The strategy families follow the live framework's logic for each horizon:

| Horizon | Families scored |
| --- | --- |
| Short | Part A mean-reversion grid (3 triggers × 3 regimes × 3 stops × 2 time stops × 2 realisations = 108 per market); exact live engine, short horizon, sector overlay off and on; 20-day breakout (commodities, crypto only); weekly worst-5/worst-10 reversal (Hong Kong, UK, France). |
| Medium | Part A mean-reversion grid; exact live engine, medium horizon, sector off/on; ranked 12-1 momentum and Piotroski ≥ 6 books (UK, France); post-earnings drift and earnings-reaction (US); 3-month and 12-month trend (crypto). |
| Long | Exact live engine, long horizon, sector off/on; ranked 12-1 momentum and Piotroski ≥ 6 books (US, UK); Wave 3 breakout baseline (US); 3-month and 12-month trend (crypto). |

## Sources

Variants already scored under this protocol are **reused, not re-run**, so the
earlier frozen results cannot be re-selected after the fact:

- `scripts/consistency-study-results.json` (2026-10-05): Part A grid for
  short/medium, Part B live engine for medium/long, Part C Wave 3.
- `scripts/new-strategy-types-results.json` (2026-10-06) and
  `scripts/strategy-amendment-results.json` (2026-10-06): momentum, reversal,
  trend/breakout, earnings books. Their windows are portfolio-book returns;
  "profitable" means window return > 0 and PF is the reported window PF.
  Their own PASS/CANDIDATE/FAIL verdicts (which also require beating the
  passive benchmark in 3 of 4 windows) are carried through unchanged.
- `scripts/backtest-omitted-geo-rescue-results.json` (2026-09-25) uses a
  different fold calendar; it is reported as reference only and is not ranked.

One new computation is added, because the live engine was never scored at
the short horizon:

- `B__{market}__short__sector_off` and `__sector_on` for Hong Kong, UK,
  Germany, France, Commodities and Crypto. Equity markets replay the exact
  production `backtestSignal` from the cached stage-1 contexts (same bars,
  same causal PIT quality provider); sector OFF buy events are the cached
  primary events and sector ON is recomputed with `sectorEtfForSymbol`.
  Commodities and crypto use the consistency-study universes and 10-year
  daily bars. These twelve rows form their own Benjamini–Hochberg family
  (`alpha = 0.05`) on the pooled development win-rate p-value against the
  breakeven rate. No other row's BH value is recomputed.

## Membership labels

US is `POINT_IN_TIME` (`membershipAt`). Hong Kong, UK, Germany and France are
`SURVIVORSHIP_BIAS` (current index lists). Commodities and crypto are
`NOT_APPLICABLE`.

## Verdicts per cell

- `CONSISTENT`: the top-ranked row is consistent under the rule above. It is a
  paper-candidate design only, with the forward-pass bar of the consistency
  study (≥ 30 closed trades, profitable, win rate ≥ breakeven + 5pp, no
  two-month stretch losing more than one average month). Promotion still
  needs a dated approval.
- `NONE`: nothing in the cell is consistent. The least-bad row is shown with
  its failure reason so the cell can be closed rather than re-searched.
- `BLOCKED`: the family cannot be evaluated with current data (for example
  US earnings-drift without point-in-time EPS estimates).

## Outputs

- `scripts/cell-strategy-search-results.json`
- `scripts/cell-strategy-search-engine-short.json` (new replay trades)
- `docs/cell-strategy-search-readout.md`
