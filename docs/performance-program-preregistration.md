# Performance Research Program — pre-registration

Frozen: 2026-09-29, before any program data fetch or backtest run.

## Scope and safeguards

- Research only. No live signal, bracket, order, risk, or execution change is authorized.
- Markets: US, Japan, Hong Kong, UK, Germany, France. Horizons: short, medium, long. Sides: buy, sell.
- Folds are date-aligned 504-session development / 126-session validation / 126-session holdout windows with embargoes of 20 / 63 / 180 sessions for short / medium / long respectively.
- The last available 126-session fold is reported as `CLEAN` only when it post-dates every prior study window; otherwise it is `OVERLAP_RISK` and cannot promote a live candidate.
- Benjamini-Hochberg correction applies across every tested cell and variant in this program.
- Promotion requires holdout win rate >=60%, PF >=1.3, and positive PnL. `FULL` requires n>=30 and two passing development folds. `THIN` requires n 15–29, exact binomial p<0.05 versus 50%, PF>=1.6, positive PnL, and two passing development folds.
- Every result reports n, win rate, PF, PnL, average win/loss, fold metrics, BH status, confidence, and holdout status. A cell with win >=60% but PF<1.3 is labelled `REJECTED_BLEEDER`.

## Point-in-time quality data

- Quality is built from quarterly statements, or observed half-yearly cadence where quarterly reporting is unavailable.
- A statement score becomes usable on the first trading session after `acceptedDate`, falling back to `filingDate`. Period-end dates are never used as availability dates.
- Per-market filing-lag distributions are retained. A market with constant/suspicious filing lags is excluded from statement-quality tests rather than estimated.
- Fundamental factors are eligible for medium and long horizons only; short-horizon fundamental candidates are ineligible by construction.

## Part A — PIT Piotroski-style F-score

The nine frozen components are profitability (ROA positive, operating cash flow positive, ROA improving, CFO > net income), leverage/liquidity (long-term leverage decreasing, current ratio improving, no dilution), and efficiency (gross margin improving, asset turnover improving). Scores range 0–9 and are computed only from consecutive eligible filings.

## Part B — exact live-engine replay

Replay the production trend entry and exit primitives unchanged: score/confidence >=62, RR >=1.1, Supertrend and market/sector/earnings overlays, TP1 partial, live TP2 runner exit, post-TP1 TSL, and existing time/signal exits. Replace only the current-only FMP score with the Part A PIT F-score. No other entry or exit change is permitted in the baseline.

## Part C — frozen exit grid

Entries are the Part B entries. Test TP1 at current, 0.75R, 1.0R, and 1.25R; stop-width cap `none` versus 4% / 8% / 12% for short / medium / long; time stops of 5/10, 15/30, and 40/80 bars; and TP1-only versus 50% TP1 + 50% TP2 blended RR. Any variant qualifying only by violating the current TP1 RR>=1.1 rule is flagged, not promotable.

## Part D — quality confirmation

Test F-score gates >=5, >=6, and >=7 on Part B medium/long trend entries and the frozen US/JP medium mean-reversion entries. The question is fold stability, not merely trade-count reduction.

## Part E — medium/long sells

Require all of: close below 200-day MA, benchmark tide down, RSI2>95 or close above upper Bollinger, and F-score<=3. Include borrow cost. Test the same structural rule without F-score as its control.

## Attached prior evidence — not re-run

- `scripts/backtest-production-factor-overlays-results.json`: price-only confirming-factor study; attach its recorded unsupported results.
- `scripts/backtest-usjp-regime-stabilize-results.json`: MR regime-detector study; retain its recorded `OVERLAP_RISK` label.

## Amendment — 2026-09-29, before Parts A–E

Reason: cached statement evidence shows vendor filing dates are placeholders outside the US: median lag is zero days for France, Germany, Hong Kong, Japan, and the UK. Treating those fields as publication timestamps would introduce lookahead.

This amendment replaces the prior availability-date and constant-lag exclusion language:

- Legal deadline by market and period type: US/Japan quarterly 45 days and annual 90 days; Hong Kong interim 60 days and annual 90 days; UK/Germany/France half-yearly or quarterly 90 days and annual 120 days. Unknown period type uses the longer deadline.
- A vendor date is plausible only when it is after period end, at least five days later, and not before the applicable market minimum. US `acceptedDate` is preferred when plausible.
- Availability date is the later of period end plus legal deadline and the plausible vendor date. A vendor date on/before period end contributes nothing; deadline-only availability is used.
- A score is usable on the first trading session after that availability date.
- Reporting records vendor-date versus deadline-only row counts, median availability lag, and symbol coverage with enough consecutive filings. Europe/UK half-yearly cadence is reported as a twice-yearly score update.

## Amendment — 2026-09-29, before Parts B–E

Decision A — missing quality data: replay the live distinction exactly. US and UK listings without a usable FMP snapshot are capped to Hold (`applyMissingFmpHold`); other markets skip the quality overlay when no snapshot exists. This is the existing live rule in `lib/strategy/market-tier.js`.

Decision B — gate mapping: the injected PIT object has the same shape as the live FMP score: `piotroski`, `altmanZ`, and `qualityScore`. The live quality blend uses Piotroski high/low thresholds (>=7 and <=3), quality-score bands (>=7, >=6, <=4, <=3), and Altman Z safe/distress thresholds (>2.99 and < or =1.81). Altman Z is not yet reproducible from the cached statements because market-cap history is absent; the replay must report that component as not replayable and may not synthesize it.

## Amendment — 2026-09-29, before Parts B–E (supersedes Altman limitation)

Historical market value of equity is defined as the decision-date close from the existing daily-price harness multiplied by the latest weighted-average shares outstanding from a statement available under the legal-deadline availability rule. Price and statements are converted to a common currency using the decision-date FX rate; LSE GBp prices are scaled to GBP before conversion.

PIT Altman Z uses working capital, retained earnings, total assets, and total liabilities from that latest available balance sheet, plus trailing-twelve-month EBIT and sales (four quarterly or two half-yearly filings). It uses the live threshold mapping: safe above 2.99 and distress at/below 1.81. The runner reports full-gate coverage (Piotroski and Altman) by market and applies the missing-data rule above to incomplete names.

The primary result is the exact Piotroski-plus-Altman parity replay. A Piotroski-only replay is additionally authorized as `NON_PARITY`; it is displayed side by side but is ineligible for promotion on its own.

## Amendment — 2026-10-01, before the Stage 1 extension and Part C rerun

The exact-live Part B baseline is extended to the short horizon in every market. It uses
the unchanged production short-horizon signal, overlay, missing-fundamentals behavior,
and exit simulation. Fundamental confirmation variants remain restricted to medium and
long horizons; this amendment does not authorize a short-horizon fundamental gate.

Part C is expanded from the initially approved Japan-buy subset to every market's
Part B buy entries (US, Japan, Hong Kong, UK, Germany, and France) and every horizon.
Sells are excluded. Development windows are pooled once per calendar window, the final
fold remains a separate holdout, and Benjamini-Hochberg is applied across the complete
Part C variant family. A variant can be recommended only when it improves the pooled
result and does not clearly harm a market with at least 30 pooled trades.

The US universe will use the same current FMP S&P 500 plus NASDAQ 100 constituent
source as the live engine. If FMP does not provide dated constituent history, all US
research output is explicitly labelled `SURVIVORSHIP_BIAS`; no current constituent is
treated as proven historical membership.
