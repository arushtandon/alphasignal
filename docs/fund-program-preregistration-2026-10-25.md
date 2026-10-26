# Fund-style program — pre-registration (F12, F13, F14)

Frozen: 2026-10-25, committed before any backtest in this program. Research
only. Nothing here is enabled, the bridge is not modified, and no live or
paper book changes. Each family has its own script and readout; this file
is the single frozen specification for all three.

Data limits found in step 0 (`docs/fund-program-data-check-2026-10-25.md`)
are reported, not substituted: `RTY=F` starts 2017-07-10, `BTC-USD`
2014-09-17, `ETH-USD` 2017-11-09. Those instruments enter F13 on their
first date with a complete lookback. All other series are continuous from
January 2010. Yahoo `=F` series are front-month continuous contracts with
roll jumps; they are used as-is for signals and marks, and F13 charges an
explicit roll cost per contract-year instead of back-adjusting. Rates micros
at IBKR (10Y, 30Y, 5YY) are yield-quoted; research uses the ZN/ZB/ZF price
series and the sign inversion is an execution item, not a research change.

## Common definitions

- **Universes (equities)**: ever-member files only —
  `data/research/fmp/us-universe.json` (US, dated membership from
  2014-01-23), `data/research/index-membership/{ftse100,cac40,dax}.json`.
  A name is a candidate on a signal date only if it is a member on that date
  (`membershipAt`). Prices from `data/research/strategy-amendment-prices`
  then `data/research/exit-amendment-prices`. Names without a price file are
  counted in a coverage table and dropped; this is reported per year.
- **Fundamentals**: `data/research/fmp/{US,UK,France,Germany}/{symbol}/
  {income,balance,cashflow}.json`, point in time at filing date + 45 days
  (`shiftFiling`). Piotroski via `buildPitPiotroskiScores`; UK half-year
  filers are `INELIGIBLE_STATEMENT_CADENCE` and are excluded from any
  Piotroski gate (coverage reported). Sectors from
  `data/research/fmp-profiles/{symbol}.json`.
- **Timing**: all signals at a session close; all entries and rebalances at
  the next session's open; exits at the stated close or the next rebalance
  open. Trading only on CME weekdays for crypto proxies.
- **Costs**: equities via `estimateRoundTripCostPct({market, symbol, side})`
  (implementation-cost-v1; UK profile includes 50 bps SDRT on buys,
  including buy-to-cover). Micro futures round trip in percent of notional:
  equity 0.04, rates 0.03, FX 0.03, commodity 0.08, crypto 0.25; roll cost =
  one round trip per roll × rolls per year (table in
  `lib/research/fund-program-data.js`), charged pro rata to days held.
  `ISF.L`: 0.10% round trip, no stamp (ETF). Borrow (F14 only): 1%/yr,
  3%/yr when the price is below 5 in local units (USD 5, EUR 5, 500p).
- **Benchmarks**: US SPY (alpha on SPY+QQQ two-factor; QQQ hurdle); UK EWU;
  France EWQ; Germany EWG. F13: zero/cash, and 60/40 = 0.6 SPY + 0.4 AGG
  rebalanced monthly, reported alongside.
- **Windows**: the four test slices of `buildDateAlignedFolds` with
  `FOLD_SPEC` from `lib/research/consistency-study.js` on the benchmark's
  calendar, embargo by horizon (`EMBARGO`: short 20, medium 63, long 180).
  Horizon labels: short = holds of 10 sessions or fewer (F12-A), medium =
  monthly rebalance (F12-B, F13, F14-monthly), long = quarterly rebalance
  (F12-C, F14-quarterly).
- **Executable books**: $30k tickets (local-currency equivalent at the
  cached FX rate for non-USD), board lots for `.L` (pence) names, k names
  per slot, empty slots earn zero.
- **Trial counting for deflated Sharpe**: every scored book (research and
  executable, every variant, every market or instrument) is one trial.
  F12 (A+B+C together), F13 and F14 each compute a deflated Sharpe over all
  their trials; the trial count is printed.

## Pass rules (fixed)

**VALIDATION_PASS** — all of:
1. every window that has trades is profitable with profit factor ≥ 1.2
   (no trades = neutral; infinite PF clears);
2. full-sample net return positive and above the benchmark where one
   applies;
3. F12-B, F12-C, F14 long leg: monthly excess t ≥ 3 vs the market benchmark
   and alpha t ≥ 2 (US: two-factor SPY+QQQ, and the book must also beat
   QQQ); F14 short leg: hedged-spread monthly t ≥ 3; F14 combined: monthly
   t ≥ 3 vs zero; F13: monthly portfolio t ≥ 3 vs zero (Sharpe t);
   F12-A: per-trade t ≥ 3 vs zero and PF ≥ 1.2 over all trades.

**INCUBATION_ELIGIBLE** (flagged separately, never upgraded to a pass) —
all of: positive full-sample net excess (vs benchmark, or vs zero where no
benchmark), at least 3 of 4 windows with positive return, excess t ≥ 1.5,
maximum drawdown < 50%.

Every passing or incubation-eligible row is mapped to the cell
(market × horizon × side) it would fill, using the horizon labels above.
F13 is a multi-asset futures book and maps to a new cell `MULTI-ASSET ×
medium × long/short`, outside the 14 equity cells; this is stated as such.

## F12-A Turn-of-month (index level)

- Instruments: S&P 500 via `ES=F` (MES), Nikkei 225 `^N225` (MNK), Hang
  Seng `^HSI` (MHI), DAX `^GDAXI` (FDXS), CAC 40 `^FCHI` (CAC mini), FTSE
  100 `^FTSE` (Z; no micro) and FTSE 100 via `ISF.L` (ETF). 7 instruments.
- Day convention: day −1 = last trading day of the calendar month, +1 =
  first trading day of the next month. A variant `a..b` is long from the
  close of day a, executed at the open of the next session, to the close
  of day b. Variants: `−1..+3` (baseline, as specified: close of last
  trading day → close of trading day 3), `−1..+1`, `−2..+3`. Flat
  otherwise. 3 variants × 7 instruments = 21 trials.
- Costs: micro round trip (equity 0.04%) + roll pro rata; `ISF.L` 0.10%.
- Scores per instrument × variant: per-trade mean, t vs zero, PF, win
  rate; "vs index over the same days": per month, the trade's net return
  minus the index return over the same calendar days is the cost drag, so
  the informative comparison is the TOM-days return minus the mean return
  of the index over the rest of that month's sessions scaled to the same
  number of sessions (t over months, reported); full-sample compounding;
  per-year table (trades, return, win rate); four windows (short
  embargo); max drawdown of the strategy equity curve.
- Cell mapping: `{market} × short × long`.

## F12-B Low volatility (monthly)

- Markets: US, UK, France, Germany (ever-member files).
- Signal at the last session of each month: members on that date with at
  least 252 daily closes; vol = standard deviation of daily log returns
  over the past 252 sessions, annualized. Lowest quintile of the eligible
  members. Variant 1 additionally requires 12-1 return > 0 (close[t−252]
  → close[t−21]); variant 2 has no filter. Equal weight; rebalance
  monthly; only names entering or leaving are traded.
- Research book = the whole quintile. Executable books: lowest-vol k = 5
  and k = 10 names (after the filter in variant 1), $30k each. 4 markets
  × 2 variants × 3 books = 24 trials.
- Costs: market cost profile per round trip at entry (UK stamp included).
- Trades for PF: a name's continuous holding spell, net.
- Scores: monthly excess t vs benchmark, alpha and alpha t (US: SPY+QQQ;
  others one-factor on the ETF), QQQ hurdle for US, four windows (medium
  embargo), max DD, per-year table.
- Cell mapping: `{market} × medium × long`.

## F12-C Value + quality (quarterly)

- Markets: US, UK, France, Germany (ever-member files).
- Signal at the last session of each calendar quarter. Eligible: member on
  signal date, Piotroski ≥ 6 on the latest statement available by the
  signal date (filing + 45 days), price ≥ 252 sessions. Earnings yield =
  trailing four quarters (or two half-years) of `netIncome` from the
  statements available by the signal date ÷ (close × latest
  `weightedAverageShsOut`); book-to-price = latest `totalStockholdersEquity`
  ÷ (close × shares). Rank = average of the two percentile ranks among
  eligible names; top quintile; equal weight; quarterly rebalance.
- Research book = whole quintile; executable k = 10 ($30k). 4 markets × 1
  variant × 2 books = 8 trials.
- UK: half-year filers are ineligible for Piotroski, so the UK book is a
  ~30-name survivor sample; this is reported and the row carries a
  coverage caveat.
- Scores as F12-B with the long embargo; benchmark months are
  quarter-to-quarter. Cell mapping: `{market} × long × long`.

## F13 Managed-futures trend (CTA-style), long and short

- Instruments: the traded series from step 0 excluding `ISF.L` (an ETF
  duplicate of `^FTSE`): 10 equity index series, 3 rates, 5 FX, 7
  commodities, 2 crypto = 27 instruments. Each enters on its first date
  with a complete lookback and 63 sessions of volatility history.
- Signals: sign of the past return over the lookback at the signal close.
  Variants: (1) 1m = 21 sessions, rebalanced weekly at the last session of
  each week; (2) 3m+6m = mean of sign(63-session) and sign(126-session)
  ∈ {−1, 0, +1}, monthly; (3) 12m = 252 sessions, monthly; (4) blend = mean
  of the four signs (21, 63, 126, 252), monthly. 4 trials.
- Sizing: per-instrument weight = signal × 0.10 ÷ (annualized 63-session
  daily vol), capped at 4× notional per instrument. Instrument P&L summed
  with equal capital shares (1/N of instruments live that day). The
  portfolio is then scaled to 10% target vol by 0.10 ÷ trailing 63-session
  realized portfolio vol, scalar clipped to [0.25, 4], applied ex ante
  (computed through the signal date).
- Costs: micro round trip on the change in notional at each rebalance;
  roll cost on held notional pro rata by days.
- Scores: Sharpe (annualized from monthly returns) and its t vs zero;
  per-year table; four windows on the SPY calendar (medium embargo); max
  DD; monthly correlation to SPY; mean return in the worst 10% SPY months;
  60/40 same statistics for comparison; per-asset-class contribution;
  per-instrument long P&L and short P&L.
- Trades for PF: an instrument's continuous same-sign spell, net.
- Cell mapping: `MULTI-ASSET × medium × long/short` (new cell).

## F14 Multi-factor long/short equity

- Markets: US, UK, France, Germany (ever-member files); fundamentals dated
  filing + 45 days.
- Factors at the signal close, percentile-ranked **within sector** among
  members with the input available: 12-1 momentum; quality = Piotroski
  score when eligible, otherwise trailing-four-quarter ROA (`netIncome` ÷
  latest `totalAssets`) percentile within the sector (UK half-year
  filers); value = mean of earnings-yield and book-to-price percentiles;
  low vol = percentile of −(252-session vol). Composite A = mean of the
  four. Composite B adds 1-month reversal = −(close[t] / close[t−21] − 1).
  Sectors with fewer than 5 eligible names on a signal date are skipped
  that month.
- Books: long = top quintile within each sector, short = bottom quintile
  within each sector, equal weight within leg, each sector dollar-neutral.
  Short leg beta-hedged: hedge ratio = 252-session beta of the short
  basket to the market index, implemented as a long index future (MES /
  Z / FDXS / CAC mini) at beta × short notional; hedged spread = −(short
  basket) + beta × index future. Combined L/S = long leg + hedged short
  leg, each 1× capital (2× gross plus hedge).
- Rebalance: monthly (medium) and quarterly (long). 2 composites × 2
  rebalances × 4 markets = 16 variant-markets; each scores long leg,
  short leg, combined, plus executable k = 5 and k = 10 per side (top /
  bottom k by composite with at most 2 names per sector, $30k each,
  hedged the same way) → 5 books each = 80 trials.
- Costs: market round trip at entry (UK stamp on long buys and on
  buy-to-cover), borrow as above, micro round trip on hedge changes.
- Scores: long leg vs index (excess t, alpha t; US SPY+QQQ with QQQ
  hurdle); short leg alone (hedged-spread t); combined L/S (t vs zero, max
  DD, four windows). Trades for PF: a name's continuous spell per leg.
- Cell mapping: long leg → `{market} × {medium|long} × long`; short leg →
  `{market} × {medium|long} × short`; combined → `{market} × {medium|long}
  × long/short`.

## Not in scope

No parameter search beyond the variants listed. No change to any live
setup, book, or `evidence-setup-book.js`. Execution feasibility is a
write-up (`docs/fund-program-execution-feasibility-2026-10-25.md`), no
bridge code.
