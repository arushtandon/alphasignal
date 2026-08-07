# Changes since last Claude audit

**Audit baseline:** `e7ea485` — *Fix audit findings B1/B2/B3/F2* (entry_finalized gate, flatten cap, events `tail=1`, Target2 scale).

**Current HEAD:** `391ed82` — *Separate error-trade PnL and net flatten exits by ticker.*

**Scope:** `server.js`, `public/index.html`, `ibkr-bridge/bridge.js`, `ibkr-bridge/run-forever.ps1`, `ibkr-bridge/flatten-tickers.js`, `ibkr-bridge/error-tickers.txt`

**Period:** ~Aug 2026 (post-audit IBKR paper trading hardening)

---

## A. Recommendation / signal gates (`server.js`)

| Change | Why |
|--------|-----|
| Min R:R raised to **1.1:1**; never invent TP1 to pass (`b5c76d6`, `def475e`) | Undersized reward setups were still recommending |
| **Conf ≥ 62%** (`PICKS_MIN_CONF`) required for Buy/Sell on dashboard, history, IBKR emit (`149e5b2`) | UI “Conf %” = `winRateHint`; score≥62 alone let 49% Conf trades through |
| Open history **Buy/Sell frozen** on re-record; enrich won’t demote open rows to Hold (`c4a2774`) | Conf refresh rewrote history → Hold → bridge flattened live fills |
| Repair open Hold rows from IBKR entry events on boot (`c4a2774`) | Recover after demote bug |
| Singapore calendar day (`singaporeToDateString`) for IBKR keys / “today” (`c4a2774`) | Render UTC vs bridge SGT split recommendation days |
| IBKR listing aliases AIR.DE ↔ AIR.PA — no dual brackets (`b327c11`) | Same thesis traded twice |
| `ibkrHzAction` / `shouldEmitIbkrEntry` — **never default Hold→buy** (`b327c11`) | Root cause of FSLR/BMY/CVX/MPC/HSBA/AIR paper buys |
| Error-trade ticker blocklist on emit (`391ed82`) | Stop re-emitting unauthorized names |
| Blocklist default **empty** (`IBKR_ERROR_TICKERS`); legacy fills stamped once; auth by provenance | Permanent FSLR/BMY ban would block a future valid Buy |

## B. IBKR bridge lifecycle (`ibkr-bridge/bridge.js`)

### Entry policy (user-driven, **reverses** prior audit “missed stays missed”)
| Change | Why |
|--------|-----|
| Entries are **MOO / MKT**, not model-price LMT (`6e777d5`) | LMT at model price often missed |
| **Chase unfilled HK/JP** while model open; EU at open; US pre only if quote ≤ entry (buy) / ≥ entry (sell) (`a2b2299`) | User reversed “missed stays missed” for Asia |
| HK **lunch defer** 12:00–13:00 HKT; place with **conId + SEHK**; lot from `reqContractDetails`; tick rounding + stop nudge (`8395add`…`3dfb582`) | Error 200 / lot / STP rejects |
| Seed missing Asia state ≤24h; place **before** cancel on re-arm (`f7ad713`, `9014c34`) | State loss left Asia unfilled |
| Sibling horizons must not share false `entryFilled` (`e95e4c8`) | 2914 short filled marked long filled |
| US RTH chase skipped if quote **>100 bps** worse than model entry (`391ed82`) | FSLR filled 248 vs entry 236.8 |
| Fixed US RTH parent: was wrongly `MKT-EXT`/`outsideRth`; now true RTH MKT (`391ed82`) | Mis-labeled extended session |

### Hold / unauthorized / flatten
| Change | Why |
|--------|-----|
| Reject entry if side not buy/sell; re-check history Buy/Sell (`b327c11`, `391ed82`) | Hold→buy defense |
| Hold-check: **cancel unfilled only**; **never flatten filled** on Hold rewrite (`c4a2774`) | “signal/time exit” killed live Asia (+2914) |
| Error-trade force-close at session open; report `errorTrade:true` (`391ed82`) | Unauthorized still open at IB after state marked closed |
| Env kill-switch only for force-close; orphan flatten **2-sweep debounce** + recent-entry exempt | Avoid racing brand-new fills / day-key lag |
| Re-arm **cancel → wait → place** (not place-then-cancel) | Double parent filled 2914.T long |
| Orphan flatten retry 30 min; HK primaryExch pin (`242ede2`, `7e86c65`) | DAY MKT died when venue closed |
| Stale-cancel / re-open wrongly closed rows still held (`402b33a`) | 24h stale-cancel closed multi-day lives |

### Ops / stability
| Change | Why |
|--------|-----|
| `run-forever.ps1` foreground node; clientId **27**; ignore disconnect until handshake (`cc62df6`…`d6de97b`) | False restart loop / zombie clientId |
| `flatten-tickers.js` utility (`b327c11`) | Manual unauthorized flatten |

## C. MTM / IBKR UI (`server.js` + `public/index.html`)

| Change | Why |
|--------|-----|
| Mark cascade: FMP → fresh IB tick → Yahoo; session-aware Yahoo; lastTickAt (`4d559d0`…`ec82389`) | Sticky/delayed IB marks (e.g. FANG 194 vs 186) |
| IBKR tab auto-refresh / 5s MTM patch (`82ba3e7`) | Manual refresh needed |
| Dual-list mark alias AIR.PA↔AIR.DE (`d9423f4`) | MTM blank on alias |
| Phantom fill purge (rec day >3d before fill) (`a636410`) | AZN.L Jun-09 ghost |
| **Error trades** separate PnL + table; excluded from model totals (`391ed82`) | Unauthorized must not pollute model PnL |
| Flatten exit quality **nets sibling horizons** on same ticker (2914 +14/−9 → +5) (`391ed82`) | Partial flatten ignored in exit boxes |
| Fill date vs recommendation day labeling (`c4a2774`) | Dashboard 3 picks vs 5 “today” fills confusion |

## D. Known residual issues (for next audit)

1. Asia chase policy conflicts with original audit “missed stays missed” — can double-enter (2914 long ×2).
2. Unauthorized may still show open in `/api/ibkr/trades` until US RTH flatten fills report.
3. `repairOpenHistoryActionsFromIbkrEvents` can restore Buy on names that should stay Hold.
4. ~~Error-trade tagging is ticker-based~~ — fixed: empty default + fill stamps + provenance.
5. Timezone: mix of SGT helpers vs remaining `toDateString()` host-local calls (mostly SGT now).
6. Orphan flatten of 6690/3690 may still retry without AlphaSignal keys (debounce softens).
7. Conf gate + one-pick-per-pane filters can shrink board vs what bridge already traded.

---

## Commit list (`e7ea485..HEAD`)

```
391ed82 Separate error-trade PnL and net flatten exits by ticker.
c4a2774 Fix Hold demote flattening live IBKR fills and align recommendation days.
149e5b2 Require confidence >= 62% for any Buy/Sell recommendation.
b327c11 Stop IBKR from trading Holds and dual-listed duplicates; flatten unauthorized names.
3dfb582 Nudge HK stops one SEHK tick further so child STP rejects do not block parent transmit.
0803e9f Fix SEHK stop tick rounding (floor/ceil) and richer HK conId contracts for 2688.
9014c34 Tighten Asia seed to 24h; place HK orders on SEHK via conId.
f7ad713 Restore HK re-arms after lunch: seed missing Asia state; place before cancel.
8395add Defer HK entries during SEHK lunch; place conId-based orders after 13:00 HKT.
e95e4c8 Fix HK lot/tick on rearm and stop false fills from sibling symbols.
a2b2299 Entry rules: chase unfilled HK/JP; EU at open; US pre only if quote at/better than entry.
d6de97b Use IBKR clientId 27 so bridge can connect while elevated zombie holds 17.
f9c4df3 Ignore IB disconnect during connect handshake; only exit after ready.
cc62df6 Fix bridge supervisor: run node in-foreground so it no longer false-exits every 30s.
ec82389 Stabilize IBKR MTM: FMP-first live quotes; stop sticky IB portfolio marks from overriding FMP.
b5c76d6 Hard-drop recommendations below 1.1:1 R:R — never invent TP1 to pass the gate.
d9423f4 Alias IB portfolio marks across dual listings (AIR.PA ↔ AIR.DE).
def475e Fix recommendation min 1.1 R:R and IBKR MTM via account portfolio marks.
… (MTM / phantom / MOO commits back to e7ea485)
e7ea485 Fix audit findings B1/B2/B3/F2  ← LAST AUDIT BASELINE
```
