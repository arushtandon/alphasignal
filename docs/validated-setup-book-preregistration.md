# Validated Setup Book — pre-registration

Frozen: 2026-10-02, before the setup-book revalidation run.

This amendment supersedes the US/UK FMP-tier overlay experiment (V1–V3).
Those variants are not in the test family and must not be reintroduced.

## Scope

- Research only. No live signal, bracket, order, risk, execution, or deployment
  change is authorized by this study.
- `FMP_TIER_OVERLAY` is not a study variant and must not be added.
- V0 (current live rules) is a descriptive control row inside this study only.
- US and UK short have no preregistered setup. They are reported as
  `NO_VALIDATED_SETUP` unless a later dated amendment adds one.

## One statistical family

Every control and setup listed in the frozen registry shares **one**
Benjamini–Hochberg family (`alpha = 0.05`) on the holdout one-sided binomial
win-rate p-value versus 50%.

Protocol (all setups):

- Four date-aligned folds: 504 / 126 / 126 sessions.
- Embargoes: short 20, medium 63, long 180.
- Entry: next open after the signal bar.
- Costs: current `implementation-cost-v1`.
- Same-bar stop/target conflict: stop first.
- Same-symbol positions cannot overlap.
- Development test windows are pooled once (calendar window counted once).
- The final fold is a separate holdout and never feeds selection or Conf.
- Conf = pooled development win rate only.
- US membership uses the current cached constituent snapshot and remains
  `SURVIVORSHIP_BIAS`.
- The trailing holdout overlaps prior studies through 24 September 2026 and is
  labelled `OVERLAP_RISK`. It cannot produce a `VALIDATED` verdict.

## Verdicts

- `VALIDATED`: clean holdout (`CLEAN` only), n ≥ 30, win rate ≥ 60%, PF ≥ 1.3,
  PnL > 0, at least two development folds meeting the same metrics, BH pass,
  and development win rate and PnL both beat the V0 control for that cell
  (MR variants beat their own baseline variant).
- `CANDIDATE`: the predeclared thin rule (n 15–29, exact binomial p < 0.05,
  PF ≥ 1.6, positive PnL, two development folds, BH pass, beats control) **or**
  the same full/thin metrics on an `OVERLAP_RISK` holdout. Paper-test only.
- `REJECTED`: everything else, including high-win / PF < 1.3 bleeders.
- `NO_VALIDATED_SETUP`: US/UK short by construction.
- `NO_RECOMMENDATION`: a cell whose tested setups are all `REJECTED`.

## Frozen registry

| ID | Market | Horizon | Kind | Exact rule |
| --- | --- | --- | --- | --- |
| `v0_live__{market}__{horizon}` | US, UK, Japan, Germany, France, Commodities | listed cells | live control | Production `backtestSignal` / cached Part B primary buy events. Score/conf ≥ 62, geography gates unchanged. |
| `live_v3__japan__long` | Japan | long | live v3 | Exact live trend engine as replayed in performance-program v3. |
| `wave3_baseline__us__medium` / `__long` | US | medium, long | Wave 3 baseline | Simplified breakout **baseline** only (no post-hoc factor). Medium: 55-bar breakout + MA50 > MA200 + close > MA200. Long: 12-to-1-month momentum > 0 and close > MA200. Wave 3 exits. Full available universe. |
| `mr_bb_atr_t21_partial__us__medium__vol30_ma50` | US | medium | mean reversion | Lower Bollinger (20,2) trigger, 1 ATR target, 21-bar time stop, 2.5 ATR stop, 50/50 partial, plus `vol_skip_top30` and `ma50_flat_or_up`. Structural MR gates unchanged. |
| `mr_frozen__japan__{short,medium}__{variant}` | Japan | short, medium | mean reversion | Frozen MR bases: short `t10` partial; medium `t21` full. All six regime variants from the stabilisation study. |
| `live_pio5__germany__medium` | Germany | medium | live + PIT | Live trend engine gated by causal PIT Piotroski ≥ 5. |
| `wave3_baseline__france__long` | France | long | Wave 3 baseline | Wave 3 baseline, full available universe. |
| `wave3_baseline__commodities__{medium,long}` | Commodities | medium, long | Wave 3 baseline | Wave 3 baseline. Commodities remain technical-only. |
| `wave3_baseline__uk__{medium,long}` | UK | medium, long | Wave 3 baseline | Wave 3 baseline, full available universe. |
| `wave3_baseline_pio5__uk__{medium,long}` | UK | medium, long | Wave 3 + PIT | Same baseline plus causal PIT Piotroski ≥ 5. |

BH family size = every row in this registry (13 controls + 24 setups = 37).

## Current live control rules (V0)

These are the production rules being replayed as controls. They are not changed.

### Rating derivation

`deriveActionRating` in `lib/strategy/decision-engine.js`:

- Buy side wins: Strong Buy if buy ≥ 78, Buy if buy ≥ 62, else Hold.
- Sell side wins: Strong Sell if sell ≥ 74, Sell if sell ≥ 62, else Hold.
- `applyTierScoreCaps` re-derives the rating after overlays. Confidence
  (`winRateHint`) below 62 demotes Buy/Sell to Hold.

### `angloPickAllowed` (US and UK only)

- Short buy: requires `mtfShortBuyConfirmed` (Supertrend 10,3 + momentum/HLC +
  structural S/R). Rating is ignored.
- Every other Anglo side/horizon: rating must match Strong Buy or Strong Sell.
- Non-Anglo symbols always pass.

### `minRrForSymbol`

- Global floor: `PICKS_MIN_RR` ≥ 1.1.
- US/UK: `max(PICKS_MIN_RR, 1.4)` → typically 1.4.
- All other listings: `PICKS_MIN_RR` → typically 1.1.

### `applyHorizonQualityBlend`

- Short: Piotroski ≥ 7 adds a small buy boost; Piotroski ≤ 3 or quality ≤ 3
  cuts buy by 45%. Conf is not raised.
- Medium: quality ≥ 7 boosts buy and floors Conf at 66; quality ≤ 4 cuts buy
  by 55%; Altman < 1.81 cuts buy by 30%; Altman > 2.99 adds +3.
- Long: quality ≥ 7 and Altman > 2.99 boosts buy and floors Conf at 68;
  quality ≤ 4 or Altman ≤ 1.81 cuts buy by 60%; Piotroski ≥ 7 / ≤ 3 is a
  smaller add/cut.
- US/UK listings without a usable FMP snapshot are forced to Hold
  (`applyMissingFmpHold`).

## Live follow-up (not authorized by this freeze)

If and only if at least one setup is `VALIDATED`, a later change may implement
a shared default-off router behind `SETUP_BOOK_ENABLED` (default off) with
immutable publication-time score, Conf, setup id, and inputs. This
preregistration does not enable that flag.

## Reference only

August Danelfin-era paper results are historical operational evidence only.
They are excluded from selection, Conf, BH testing, and promotion.
