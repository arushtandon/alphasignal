# Audit prompt for Claude

Copy everything below this line into Claude, attaching `server.js`, `public/index.html`, and `ibkr-bridge/bridge.js`.

---

You are auditing **AlphaSignal**, a Node.js/Express trading-signal platform (single `server.js`, ~13,000 lines; vanilla-JS frontend in `public/index.html`; a local order-execution bridge in `ibkr-bridge/bridge.js`). It generates daily buy/sell recommendations across US, EU, UK, Japan, Hong Kong and India equities on three horizons (short/medium/long), tracks them as paper trades with TP1/TP2/trailing-stop exits, and mirrors them into an IBKR paper account through a local bridge connected to TWS/IB Gateway. The server is deployed on Render (Standard instance, persistent disk); the bridge runs on the user's Windows PC next to IB Gateway.

The following changes were made over the last three weeks (July 16 – August 6, 2026). Audit the attached files for correctness, consistency and unintended interactions, with special attention to the areas listed at the end.

## 1. Signal-logic rework (server.js)

- **Market-momentum overlay**: each pick's buy/sell score is modulated by the trend/regime of a benchmark ("the tide"). Cascade: broad market (SPY or home-country index) → sector level. Regimes are computed from benchmark OHLCV (MA50/MA200, slope, distance) and cached (`_liveMarketRegime`, `_sectorRegimeCache`, `_etfSeriesCache`).
- **Sector-level, country-aware benchmark resolution**: each stock maps to a home-country sector index/ETF (e.g. Indian banks → `^NSEBANK`, US chips → SOXX, Japan tech → Japanese ETF, EU sector indices, commodity producers → the commodity benchmark). Explicit ticker-to-sector overrides exist for major index constituents; fallback is fundamentals-cache sector + country from ticker suffix. Check `sectorEtfForSymbol`, `countryOfSymbol`, `sectorKeyForSymbol`.
- **Sell-side pruning**: negative-expectancy sell setups were cut; sell picks are gated behind `SELL_PICKS_ENABLED` (currently disabled).
- **R:R floor**: no recommendation may be published with reward:risk below 1:1 (`PICKS_MIN_RR`, `levelsMeetMinRR`). For long horizon, entry passes if TP1-based RR ≥ 1.0 OR TP2-based RR ≥ 1.6.
- **Medium/long exit fixes**: `simulateHybridExit` no longer ratchets the trailing stop daily BEFORE TP1 for medium/long trades (stops stay entry-anchored pre-TP1). `signalFlipped` became horizon-aware (medium: opposing score must drop below 35; long: requires opposing score ≥ 66).
- **Supertrend soft cap**: medium/long buy signals below the horizon Supertrend are capped at 58, but softened to 66 when the structure is intact (above MA200 + golden cross + weekly uptrend), so quality pullback entries can clear the 62 pick threshold.
- **Quarterly-results / peer-earnings overlay**: for each sub-industry, earnings results of the top 5-6 leader companies modulate scores of peers ("earnings tide"), with an earnings-blackout window around each stock's own report date. Earnings data comes from a cascade: FMP stable endpoints → Yahoo quoteSummary → Alpha Vantage → Yahoo chart events (`_earnLeaderCache`, `_earnGroupCache`, `EARNINGS_OVERLAY_ENABLED`).

## 2. Risk guard + history fixes (server.js)

- Fixed a corrupted portfolio drawdown calculation that showed a 27,400,159% drawdown and made the risk-off banner permanent; the reset endpoint now rebases peak equity so the banner actually clears.
- Fixed a temporal-dead-zone bug (`Cannot access 'prev' before initialization`) in `addTradesToHistory` that silently crashed history recording (no trades recorded after July 15). Each trade in the batch is now wrapped in its own try/catch so one bad record cannot abort the batch. History records are de-duplicated by key.

## 3. Scheduler (server.js)

- Universe rescan fires at 04:45 SGT; picks regeneration from 05:00 SGT (was 06:00); scheduler tick every 5 min (was 15). Rationale: Japan/HK picks must be at IBKR before the Tokyo open (08:00 SGT). Overdue regen (>20h) still forces a refresh. `_lastPicksDateKey` only advances on SUCCESSFUL regen.

## 4. IBKR integration (server.js + ibkr-bridge/bridge.js + public/index.html)

- **Event feed**: server emits trade lifecycle events (`entry`, `entry_finalized`, `tp1_partial`, `tsl_update`, `exit`) to `data/trade_events.jsonl`, served at `GET /api/ibkr/events?since=<seq>`.
- **Bridge** (`ibkr-bridge/bridge.js`, runs on the user's PC): polls the feed every 15s and mirrors the model exactly: parent LMT entry (DAY; outsideRth for US) + full-quantity STP stop + partial-quantity LMT TP1 (children GTC). TP1 fill → stop resized to runner and raised to breakeven. `tsl_update` → stop modified in place, ratchet-only. `exit` → cancel children + flatten remainder at market. FX-converted $10k notional sizing with exchange lot rounding (HK/Japan lots of 100). All orders SMART-routed with `primaryExch` (direct routing tripped TWS API precautions). Order IDs floored to seconds-since-2025 to prevent duplicate-ID collisions across sessions/clients. NSE orders skipped by default.
- **Execution reporting**: bridge captures `execDetails`, maps fills to roles (entry/tp1/stop/flatten), queues them in its state file, POSTs to `/api/ibkr/report` (deduped by execId, appended to `data/ibkr_fills.jsonl`).
- **IBKR analysis tab** (`public/index.html` + `GET /api/ibkr/trades`): aggregates fills into per-trade realized/unrealized USD PnL (FX-converted, pence-scale handling for LSE), daily PnL table, summary cards, exit-quality/horizon/side breakdowns, entry-slippage vs recommendation, and per-trade exit reasoning joined from the trade-events log. Mark prices: Yahoo v7 bulk quote with a chart-endpoint last-close fallback (v7 401s from Render's datacenter IPs), cached 5 min.
- **Restart resilience** (latest changes, most audit-worthy):
  - `closeOut` sizes the flatten from the LIVE IB position (`reqPositions` subscription, `posMap`) instead of in-memory `orderFills`, which are lost on restart (the old code flattened zero shares after a restart, leaving positions running).
  - A reconciliation sweep every 5 min: (a) flattens any IB position in a ticker AlphaSignal has traded but no longer holds open per its event log (catches orphans from state-file loss), with a 30-min retry window because MKT DAY orders die when the exchange is closed; (b) marks state rows closed when flat at IB and the model has exited, reporting a synthetic stop-price execution if the real exit fill was missed while the bridge was down.
  - Guard: reconciliation is skipped until IB's initial position snapshot arrives (`positionsReady`).
  - **Policy decision**: a missed entry stays missed. Expired DAY entry orders are NEVER re-placed (an earlier re-arm feature was added and then deliberately reverted) — only a fresh entry event from the model opens a position.
- **24/7 operation**: `run-forever.ps1` supervisor restarts the bridge on crash with shared-read log redirection; Windows Task Scheduler auto-start on logon.
- `flatten-all.js` utility: cancels all open orders and closes all positions for a clean paper-account start.

## What to audit (prioritized)

1. **Money-touching paths in `bridge.js`**: can any sequence of events (restart mid-lifecycle, duplicate events, out-of-order events, exit for an unknown key, TP1 fill racing an exit, reconnection) place a wrong-sized or wrong-direction order, double-flatten, or leave an orphan order/position? Pay attention to `closeOut`'s position-based sizing when two trades share a symbol, and to the reconciliation sweep's flatten logic (could it ever flatten a position that SHOULD be open — e.g. key formats not matching between the event log and `toContract`, or an entry event missing from a truncated feed?).
2. **PnL correctness in `/api/ibkr/trades`** (server.js): FX conversion, pence scaling (ccyScale=100 for LSE) applied consistently between realized, unrealized and daily attribution; the average-entry method when there are multiple entry fills; short-side sign conventions.
3. **Scheduler**: timezone math (SGT = UTC+8 fixed), the interaction of `newSgtDay`/`overdue`/`pastRefreshHour`, whether a failed regen can wedge the day, and whether the 04:45 universe rescan can race the 05:00 picks regen.
4. **History recording** (`addTradesToHistory`): remaining crash paths, dedup-key correctness, whether the per-trade try/catch can silently swallow systemic failures.
5. **Overlay stacking**: market + sector + earnings overlays all modulate the same scores — check for double-counting, sign errors on the sell side, and whether caps (Supertrend 58/66) are applied before or after overlays consistently.
6. **The R:R floor**: confirm no code path can still publish a pick below 1:1 (including after entry finalization re-prices the entry).
7. Anything that would behave differently on Render (Linux, datacenter IPs, persistent disk under `data/`) vs the local Windows dev machine.

For each finding, give: file + function, severity (critical / high / medium / low), the failure scenario, and a concrete suggested fix. Flag anything that could place unintended real orders as critical.
