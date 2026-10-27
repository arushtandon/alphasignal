# Regime-gated sells and index-hedge study — pre-registration

Frozen: 2026-10-05, after setup-book paper go-live. Research only.
This study does not block paper recommendations and does not enable any sell
or hedge book.

## Family

One Benjamini–Hochberg family (`alpha=0.05`) covers every variant below.

### Part A — regime-gated sells

Markets: US, Japan, Hong Kong, UK, Germany, France, India, Commodities, Crypto.
Horizons: short and medium. Side: sell only while the market benchmark is in a
confirmed downtrend (close below its 200-day MA and 50-day MA falling versus
the reading 10 sessions earlier).

- Trigger: `rsi2_gt_95`, `close_above_upper_bb20_2`, `williams_r10_gt_minus_5`.
- Regime filter: `none`, `vol_skip_top30`, `vol_skip_top30_and_ma50_flat_or_up`.
- Stop: 1.5 / 2.0 / 2.5 ATR above entry.
- Time stop: short 5 / 10 bars; medium 10 / 21 bars.
- Exit: full at −1 ATR, or 50/50 partial at −1 ATR with runner to −2 ATR.
- Costs: `implementation-cost-v1` including borrow (`side=sell`).

Entries are computed once per trigger/filter; exits vary on top.

Part A size: 9 × 2 × 3 × 3 × 3 × 2 × 2 = 1,944.

### Part B — index hedge

When a market benchmark enters that same downtrend, short its index ETF
(SPY, EWJ, EWH, EWU, EWG, EWQ) sized to that market's open buy-book exposure
and cover when the state ends. Report each current buy setup's per-window
results with and without the hedge.

Part B size: 5 buy setups × 2 hedge states = 10.

Total frozen family: 1,954.

## Scoring

Same protocol as the consistency study: four date-aligned folds, embargo
kept, pooled development windows counted once, final window labelled
`OVERLAP_RISK`, CONSISTENT = every window profitable and (sells) win % ≥ 60
or (hedge overlays) PF ≥ 1.2. Rank by worst-window PF, then smaller average
loss. Non-US index lists are `SURVIVORSHIP_BIAS` unless dated membership is
used.
