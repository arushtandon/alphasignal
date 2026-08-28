# AlphaSignal execution audit — 28 Aug 2026

**Account:** IBKR paper `DU1764495` · Gateway `4002` · bridge client **27**  
**App:** https://alphasignal-dvg5.onrender.com · build `20260828-fill-bracket-v8.2.1`  
**Baseline Claude audit:** 6 Aug 2026 (`docs` upload + `e7ea485` B1/B2/B3/F2)  
**This HEAD:** fill-time TP1+SL park (this commit) on top of `6b999eb`

Timezone for this note: **SGT (UTC+8)**. Do not flatten **FAST**, **DASH**, or live **BZ=F** except to park missing TP1/SL children.

---

## 1. What the 6 Aug Claude audit said (and what we did)

| ID | Severity | Finding | Status 28 Aug |
|----|----------|---------|----------------|
| **B1** | Critical | After restart, empty `orderFills` re-prices / re-places a filled parent → **double position** | **Fixed** in `e7ea485`: `entry_finalized` gated on persisted fill + live IB position |
| **B2** | Critical | `closeOut` caps at `qtyTotal` on a shared `SYMBOL\|CCY` bucket → **over-flattens sibling horizon** | **Fixed** in `e7ea485`: cap at runner after TP1 |
| **B3** | High | Reconcile `since=0&limit=1000` oldest-first → never sees new trades | **Fixed** in `e7ea485`: `tail=1` |
| **F2** | Medium | Entry finalization scaled TP1/SL but not **Target2** | **Fixed** in `e7ea485` |
| **F1** | High | Overlay stacking A×B×C suppresses medium/long buys | **Open** — behavioural; not re-opened here |
| **F3** | Confirm | SL floors 3/8/16 → 2.5/5/8 | Still in force; RR gate is 1.1:1 |

**Scope hole in that audit:** the first pass did not have `bridge.js`. Money-touching paths have since become the main failure class (AFL naked stop, 1-lot no TP1, Asia standalone parent, client-27 restart).

---

## 2. What changed since that audit (operator-relevant)

Full commit list is `e7ea485..HEAD`. The classes that actually moved PnL / orders:

### Execution (bridge)

- Parents are **MKT / OPG / through-limit**, not model-price LMT.
- **HK/JP:** parent transmits **standalone** (TSE/SEHK bag children often never ack). Children used to wait for a 60s/15m sweep. **Now they park on the parent fill.**
- **1-lot / 1-contract (BZ=F, 0669.HK, 0992.HK, 4062.T):** sell **100% at TP1**, OCA with the stop. No runner, no TSL until a 50% split exists.
- Splittable equities stay **50% TP1 LMT + runner STP** (TSL only after a real TP1 limit print).
- Undersized runner stops are **cancelled and replaced** (FAST/ABNB/SU/SAP/BRK-B qty=1 class).
- Venue: HK→SEHK, JP→TSEJ, LSE→LSE; `outsideRth` default on; 20-client exec pool.
- Hold rewrite **must not flatten** a filled lot. Unauthorized / recon economics go to **Error trades**, not model PnL.

### AFL (the repeat)

IB cancelled the $117.80 STP on 12 Aug (`Exit handled … flattened 0`). 82 short stayed **naked**. IB covered at the **27 Aug NYSE open ~$116.44**, not at the stop. Extra 410 that morning is **Error**, not SL.

Guards that must stay (not ticker one-offs):

1. Fully exited fill key **cannot be qty-padded** again (`fillKeyIsFullyExited` / T21f).
2. Boot restore **does not invent pads** from a stale on-disk recon file.
3. Dropping a qty-pad when IB is flat also **closes the leftover model entry event**.

Live AFL: **stop-loss (full), 82 @ 116.44, about −$383**, model PnL, not Error.

### Book of record

- Error vs model is a **ledger key rule** (C1–C5), not a UI colour.
- Conf ≥ 62, RR ≥ 1.1, never Hold→buy.
- Dashboard top-N is a view. Open history + `trade_events` + IB fills are the book.

---

## 3. Live IBKR book — 28 Aug ~11:08–11:15Z snapshot

**30** model lots matched IB. AFL closed.

### TP1 already banked — TSL only (correct)

| Name | Runner | Working SL |
|------|--------|------------|
| 0883.HK | 3,000 | STP 3,000 @ 22.94 |
| 9988.HK short | 300 | BUY STP 300 @ 123.80 |
| ANET | 27 | STP 27 @ 187.60 |

### 50% TP1 + stop present (working at dump)

0005.HK, 2688.HK, ABNB, ALLE, DASH, DELL, DXCM, FAST, GRMN, NTAP, NVDA, PH, PLTR, SAP.DE, SNDK, SU.PA, BRK-B, KHC, BA.L (TP1 165).

**Qty bugs on that dump (new bridge must repair):**

- **KHC** LMT 400 + STP 400 (should be ~200 / 200).
- **FAST / ABNB / SU / SAP / BRK-B** runner STP qty **1** (undersize replace).
- **NTAP / PH** duplicate LMT/STP (cancel extras).

### Unsplittable — need **full-qty TP1 OCA with SL**

| Name | Pos | SL on IB? | TP1 on IB at dump? | When |
|------|-----|-----------|--------------------|------|
| **BZ=F** | 1 | STP 1 @ 82.69 | **No** (old code skipped 1-lot FUT) | ICE open — park on bridge restart |
| **4062.T** | 100 | Yes | No | TSE closed — GTC on fill-path / next cash |
| **0669.HK** | 500 | Full STP | No | HK closed |
| **0992.HK** | 2,000 | STP (dup) | No | HK closed |

### Incomplete / venue echo

| Name | Issue |
|------|--------|
| **6501.T** | No TP1, no SL |
| **2914.T** | STP 200 of 300, no TP1 |
| **DSY.PA** | Full STP, no TP1 (splittable ~103) |
| **MNDI.L** | Bridge sends GTC 425/425; LSE often omits GTC from `reqOpenOrders` (shrink loop) |
| FOX / FOXA / PKG | Board shorts, **not** in IB (unfilled OPG) — no children until parent fills |

---

## 4. Why “the same issue” kept repeating

This is an **architecture** problem, not a missing if-ticker.

```
Model event  →  parent order  →  (hope IB native bag children ack)
                              →  60s sweep / 15m cooldown parks children
                              →  recon pads qty if site ≠ IB
                              →  restart restores pads from disk
```

Failure modes we actually hit:

1. **Children never attached** (Asia standalone, 1-lot skip, cash closed skip, 15-min “already sent” cooldown).
2. **Children cancelled** with flatten qty 0 (AFL) → naked inventory.
3. **Site ledger diverged** (qty-pad while IB flat, leftover open **entry** event) → next boot re-padded.
4. **New bridge code never loaded** because client **27** stayed on an elevated zombie; `restart-bridge.ps1` without elevation cannot kill it.

**This commit’s contract:** the parent **fill** is the trigger. If TP1 or SL were not submitted with the parent, park them **immediately** (skip lunch only on HK/JP). The 60s sweep remains belt-and-braces, not the primary attach.

---

## 5. What must stay true after every parent fill

| Lot type | On IBKR after fill |
|----------|--------------------|
| Splittable equity (2+ board lots) | LMT TP1 = 50% **and** STP = runner (full STP until TP1 working, then shrink) |
| 1 board lot / 1 future | LMT TP1 = **100%** OCA with STP 100% (no TSL) |
| After TP1 limit print | No TP1 child; STP = remaining qty at TSL (BE floor) |

Native US/EU 3-leg bags already send children with the parent — the fill hook **must not** mint a second bag.

---

## 6. Ops remaining (not code)

1. **Elevated** `ibkr-bridge\restart-bridge.ps1` so client 27 loads this file. Log must show `Bridge start` **without** “clientId 27 already in use”, then `attached 1-lot OCA TP1+SL` for **BZ=F**.
2. Render auto-deploy is **off** — manual deploy for `v8.2.1` (AFL pad-close lives on the server).
3. Do not run a second `run-forever.ps1`.

---

## 7. Suggested next architecture (for the Claude pass)

See `docs/claude-audit-prompt-execution-architecture.md`. Short version:

- Single **child-order owner**: IB working orders, not `row.tp1Id` in a JSON state file.
- Parent fill → **one** `ensureProtectiveBracket(key)` with idempotent adopt-or-place.
- Recon **must not invent economics** (no ghost flats, no qty-pad of a fully exited key).
- One bridge process; refuse a second client 27 rather than looping every 30s.
