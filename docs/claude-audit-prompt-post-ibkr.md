# Claude audit prompt — post-IBKR hardening (after `e7ea485`)

Copy everything below the line into Claude. Attach (or paste relevant sections of):

- `server.js`
- `public/index.html`
- `ibkr-bridge/bridge.js`
- `ibkr-bridge/run-forever.ps1`
- `ibkr-bridge/flatten-tickers.js`
- `docs/CHANGES-SINCE-CLAUDE-AUDIT.md`

Optional context: live paper account `DU1764495`, Gateway port 4002, bridge clientId 27, app `https://alphasignal-dvg5.onrender.com`.

---

You are auditing **AlphaSignal** after a major IBKR paper-trading hardening pass.

## What already happened

A prior Claude audit produced findings **B1/B2/B3/F2**, fixed in commit `e7ea485`:

- Gate `entry_finalized` re-price on persisted fill + live position
- Cap exit flatten at runner qty when symbols are shared across horizons
- Reconcile sweep reads newest events via `tail=1`
- Scale Target2 with entry finalization

**That audit is the baseline.** Do **not** re-litigate those fixes unless you find they were broken by later work.

Since `e7ea485`, ~30 commits changed entry policy, Hold/unauthorized handling, Asia session logic, Conf/RR gates, MTM, and PnL reporting. Summary is in `docs/CHANGES-SINCE-CLAUDE-AUDIT.md`. Current HEAD includes `391ed82` (error-trade PnL + flatten netting).

## Critical incidents that motivated the new code (must be covered)

1. **Hold→Buy**: `tradeEventSnapshot` once defaulted Hold → `buy`, so FSLR/BMY/CVX/MPC/HSBA.L/AIR.* were paper-bought without real recommendations. Partially fixed; unauthorized still needed flatten + error-trade accounting.
2. **History Hold demote → flatten**: Conf≥62 refresh rewrote open history to Hold; bridge flattened live Asia fills (2914) labeled as “signal/time exit”.
3. **Dashboard 3 vs IBKR 5 “today”**: Dashboard = current filtered board; IBKR showed fill dates for Aug-6 Asia chases + wrongly re-seeded Aug-5 2914 short.
4. **2914 PnL**: Closed short +$14 and long partial flatten −$9 reported as +$14 in exit quality while totals showed +$32 (= 27+14−9). Fixed by ticker-net flatten stats + error-trade split.
5. **FSLR fill 248 vs open/entry ~236**: Late RTH MKT chase after bad emit; US RTH was also mis-tagged as MKT-EXT.
6. **Double entry**: 2914.T long entered twice after false `entryFilled` clear / re-arm.
7. **Asia policy flip**: Earlier audit said “missed entry stays missed”; user later required **chase unfilled HK/JP** while model open — this is an intentional policy change with new risk.

## What to audit now (prioritized)

### P0 — Money / wrong orders
1. Can Asia re-arm + seed + sibling-horizon logic still **double-enter** or enter the wrong horizon?
2. Can Hold-check, orphan flatten, or error-trade flatten ever close a **legitimate** open model position?
3. Is the error-trade blocklist (`IBKR_ERROR_TRADE_TICKERS` / `ERROR_TRADE_TICKERS`) safe long-term, or will it block a future valid FSLR/BMY Buy forever?
4. US pre gate + US RTH 100 bps chase skip: edge cases (no quote, delayed quote, short side, OPG leftover).
5. SEHK lunch / conId / lot / stop nudge: can parent transmit while stop is rejected, leaving naked risk?
6. `closeOut` + shared-symbol caps still correct after Asia chase / error flatten paths?

### P0 — PnL / reporting truth
7. `/api/ibkr/trades`: model vs error split; daily vs dailyError; tickerGroupRealized for flatten; FX/pence; shorts.
8. Can error fills fail to report (orphan flatten without `byKey` row) leaving “open” error positions in the UI forever?
9. Does UI double-count ticker-net flatten PnL anywhere?

### P1 — Recommendation consistency
10. Conf≥62 + RR≥1.1 + freeze-open-action + repair-from-IBKR-events: can these fight each other (e.g. repair restores Buy that Conf correctly demoted)?
11. Singapore day keys vs remaining host-local `toDateString()` — any remaining day-split bugs between Render and the Windows bridge?
12. Dashboard pane rotation (top-N) vs bridge executing older open history keys — how should “today’s recommendations” stay aligned with executions?

### P1 — Ops
13. `run-forever.ps1` + clientId 27 + handshake disconnect ignore — any path that leaves two bridges live or silent-dead?
14. MTM cascade FMP→IB→Yahoo: can sticky marks return (AIR alias, LSE pence, JP)?

### P2 — Hardening recommendations
15. Propose a minimal **invariant checklist** the bridge should assert every reconcile (e.g. no position without open Buy/Sell key; no open key without bracket or intentional defer; error tickers flat in RTH).
16. Propose tests (even lightweight Node scripts) for: Hold never emits; Asia seed age gate; flatten qty cap; PnL 14−9=5; error trades excluded from model totals.
17. Call out any intentional policy debt (Asia chase vs missed-stays-missed) and recommend a single coherent rule.

## Output format

For each finding:

- **ID** (e.g. C1, C2…)
- **File + function**
- **Severity**: critical / high / medium / low
- **Failure scenario** (concrete sequence)
- **Evidence** (what in the code allows it)
- **Concrete fix** (smallest correct change)

End with:

1. **Top 5 fixes to do immediately**
2. **What looks solid** (do not reopen)
3. **Recommended long-term architecture** for “dashboard recommendations ≡ IBKR executions ≡ history Buy/Sell” with no unauthorized path

Flag anything that could place unintended paper (or later live) orders as **critical**.
