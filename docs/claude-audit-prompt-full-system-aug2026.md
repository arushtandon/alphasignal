# Claude audit prompt — full AlphaSignal system (Aug 2026)

Copy everything below the horizontal rule into Claude. Attach (or grant repo access to) the files listed under **Attachments**.

---

You are auditing **AlphaSignal** — a live paper-trading system that generates equity Buy/Sell recommendations and mirrors them into Interactive Brokers paper via a local bridge.

## Goal

Produce a **full-system audit** of the *current* setup (as of HEAD ~`8d4f4f4`, Aug 12 2026), then give **prioritized, concrete improvement suggestions**.

This is **not** a style review and **not** a greenfield rewrite wishlist. Focus on:

1. Correctness of money-touching paths  
2. State ownership (what is the book of record?)  
3. Whether Error-trade PnL can leak into model PnL  
4. Recommendation → history → IBKR event → bridge → fills → UI consistency  
5. Operational fragility (Render + Windows bridge + Gateway)

For every finding: **file + function**, **severity** (critical / high / medium / low), **failure scenario**, **smallest concrete fix**. Flag anything that could place unintended orders or corrupt PnL as **critical**.

End with a ranked improvement roadmap (P0 / P1 / P2) and an optional target architecture sketch *only if* the current multi-ledger design cannot reliably hold the invariants below.

---

## Attachments (give Claude these)

**Core**
- `server.js`
- `public/index.html`
- `ibkr-bridge/bridge.js`
- `ibkr-bridge/run-forever.ps1`
- `ibkr-bridge/restart-bridge.ps1`
- `ibkr-bridge/telegram.js` (if present)
- `scripts/lifecycle-invariants.js`

**Context (optional but useful)**
- `docs/claude-audit-prompt.md` (older full audit)
- `docs/claude-audit-prompt-recommendation-stability.md` (stability-focused prior ask)
- Recent git log / this prompt’s “Incident history” section

**Live ops context (do not require secrets)**
- App: `https://alphasignal-dvg5.onrender.com` (Render; **Auto-Deploy Off** — Manual Deploy required)
- Paper account: IBKR `DU1764495`
- IB Gateway paper API port **4002**
- Bridge `clientId` **27** (only **one** `run-forever` instance allowed)
- Telegram alerts via gitignored `ibkr-bridge/local-secrets.ps1`

---

## System map (current)

```
Quant / scans (server.js)
    → dashboard picks (Conf ≥ 62, RR ≥ 1.1, Buy/Sell only)
    → trade history (open/closed per horizon)
    → trade_events.jsonl  (entry / tp1_partial / tsl_update / exit)
            ↓ poll ~15s
    ibkr-bridge (Windows + Gateway 4002)
    → native bracket (parent MKT/OPG/MKT-EXT + STP + TP1 LMT)
    → execDetails → POST /api/ibkr/report → ibkr_fills.jsonl
    → POST /api/ibkr/recon (IB positions vs site open qty)
            ↓
    GET /api/ibkr/trades → IBKR tab (Open trades vs Error trades + PnL)
```

**Markets:** US, EU (Euronext/Xetra), UK, Japan, Hong Kong (NSE often skipped).  
**Horizons:** short / medium / long.  
**Sizing:** ~$10k USD notional, FX-converted, exchange lot rounding.  
**Sessions:** RTH MKT; EU/Asia closed → OPG; US pre/post price-gated MKT-EXT else OPG.

---

## Non-negotiable product invariants

Treat these as hard requirements. If code cannot guarantee them, say so and propose the smallest architecture that can.

| ID | Invariant |
|----|-----------|
| **I1** | New Buy/Sell only if action is truly Buy/Sell, Conf ≥ 62, RR ≥ 1.1 on TP1 vs SL. Never default Hold → buy. |
| **I2** | Once open in history and/or an IBKR `entry` is emitted, later scans must **not** demote to Hold or blank levels until an explicit exit. |
| **I3** | Dashboard top-N is a *view*. **Open history + trade_events** are the book of record for “what the model recommended.” |
| **I4** | For model-authorized tickers, IB paper qty/avg should match AlphaSignal open lots (within tick). Ghosts closed; IB-only leftovers listed, not invented as model trades. |
| **I5** | **Error / unauthorized / Cursor-recon / orphan-flatten** lots are isolated under **Error trades**. Their realised PnL must **never** enter model realised PnL. |
| **I6** | Model open lots must never be flattened by orphan/recon logic while a live `entry` (no matching `exit`) exists — except explicit user/error paths with clear tagging. |
| **I7** | One bridge instance only; no clientId fights; missed DAY entries are not silently re-armed forever without a fresh model entry (except intentional repair paths that are one-shot and audited). |
| **I8** | Same-day key is SGT calendar day (`ticker\|hz\|Wed Aug 12 2026`). Dual-list aliases (e.g. SU.PA ↔ SU.DE ↔ bare SU, DHL.DE ↔ DHL.PA) must not double-count or orphan-flatten the other listing. |

---

## Incident history Claude must learn from (Aug 2026)

These are **production paper** failures. Root-cause them against current code; check whether fixes are durable or still band-aids.

### A. SU.PA long — the teaching case (Aug 12)

1. Valid model **long Buy** filled (~28 @ ~309).  
2. Bridge **orphan-flattened** because IB symbol `SU` / `SU.DE` was not aliased to open `SU.PA`.  
3. Site recon then invented ghost flats / recover-entry → qty disasters (28→56 narratives).  
4. Commission / invented PnL wrongly hit **model** realised (~$5 then ~$11 class errors).  
5. Repair path emitted `exit` with reason `ib-orphan-flatten-repair` in a loop (zero-edge void deleted flatten → repair re-added → spam).  
6. Boot **re-arm** ran *before* `riskState` init → TDZ inside `shouldEmitIbkrEntry` → history `entryDate` updated but **no entry event** → “still no SU.PA execution.”  
7. After force re-arm: bridge placed **27 @ ~309.75** with TP/SL (genuine model trade).  
8. UI still showed open **27 under Error trades** because orphan **28 + flatten @ ~309.55** shared the same live key; any `errorTrade` fill painted the whole trade Error, and orphan realised leaked into model realised.  
9. Intended end state (must verify code enforces this permanently):
   - **Error trades:** closed wrong **28** @ ~309.5 → realised loss in **Error PnL only**  
   - **Open trades:** live **27** @ 309.75 → model open / unrealised only  

Relevant recent commits (for orientation): `bcfb341`, `7641553`, `47c434d`, `9770b6f`, `8f78b62`, `0b4284b`, `8d4f4f4`.

### B. Other recurring classes

- **BP.L** Telegram “Order NOT executed” spam for stale / Hold / unfilled entries.  
- **AIR.PA / AIR.DE** dual-list Hold→Buy error episodes.  
- Site open vs IB flat / IB open vs site flat flip-flops under recon + phantom purge.  
- Open history demoted to Hold while reason string still says Buy @ levels.  
- Two `run-forever` windows → clientId collision → disconnect loop.

---

## What to audit (prioritized)

### 1. Money & PnL (critical)

- `/api/ibkr/trades` aggregation: FX, LSE `ccyScale`, short sign, multi-entry avg.  
- **Error vs model bucket** (`isIbkrErrorTrade`, `|cursor-err`, `errorTrade` fill stamps). Can any path put orphan flatten realised into `totals.realizedUsd`?  
- `splitSuPaOrphanCycleFromLiveModel` + `partitionSuPaFillsForTradesView` — durable design or SU.PA one-off? Generalize?  
- Synthetic fills: `recon-flat-*`, `recover-entry-*`, `repair-ibflat-*`, zero-edge void — can they recreate the SU.PA loop?

### 2. Bridge execution (`ibkr-bridge/bridge.js`)

- `placeBracket` / `parentEntrySpec` (MKT, OPG, MKT-EXT, chase caps, lunch defer).  
- Duplicate entry skip vs re-entry after `closed` state row.  
- Orphan flatten vs model-open provenance (`hasOpenEmittedEntry` / aliases).  
- Restart: `closeOut` from live IB position; recon sweep; `positionsReady` gate.  
- Dual-list aliases completeness (SU, DHL, AIR, HSBA, etc.).  
- Exec report key assignment — can morning fills re-attach to a re-armed live key?

### 3. Server event & history lifecycle (`server.js`)

- Emit gates: `shouldEmitIbkrEntry`, risk/liquidity off, Conf/RR, open-alias duplicate.  
- Boot order hazards (anything that still runs before `riskState` / fill ledger init).  
- Abandon-unfilled / Hold-abandon exits — false positives on live Buys?  
- History demote vs latch (`repairOpenHistoryActionsFromIbkrEvents`, `_freezeOpenAction`).  
- Same-day re-recommend while open same direction.

### 4. Recon authority conflict

- Who owns open qty: fills ledger, IB snapshot overlay, events provenance?  
- Grace windows (15m) vs “IB flat is authoritative.”  
- Can recon flatten a freshly re-armed unfilled/partial model entry?

### 5. Ops & reliability

- Render Manual Deploy + persistent disk under `data/`.  
- Single-instance bridge enforcement.  
- Telegram EOD / unfilled alerts — signal vs noise.  
- Observability: can an operator answer “why is this Error vs Open?” in one API call?

### 6. Signal quality (secondary but in scope)

- Conf 62 / RR 1.1 gates still airtight?  
- Overlay stacking (market / sector / earnings) double-count?  
- Sell path status (`SELL_PICKS_ENABLED`).  
- Backtests under `scripts/backtest-*.js` — do they match live gates?

---

## Deliverable format

### A. Executive summary (≤15 lines)
Is the system safe enough for continued paper trading? Biggest structural risk?

### B. Findings table
| ID | Severity | Area | File/fn | Scenario | Fix |

### C. Invariant scorecard
For I1–I8: **Pass / Partial / Fail** + one-line evidence.

### D. Improvement roadmap
- **P0 (this week):** must-fix before trusting PnL / execution again  
- **P1 (next 2 weeks):** remove whole classes of glitches (not more one-ticker patches)  
- **P2 (later):** simplify architecture, tests, observability  

Prefer improvements that:
1. Establish a **single writer** for “open model position” state  
2. Make Error vs model PnL a **ledger rule**, not UI filtering  
3. Replace ticker-specific repairs (`SU.PA|…`) with general policies  
4. Add **lifecycle invariant tests** (extend `scripts/lifecycle-invariants.js`) that would have caught the Aug 12 failures  
5. Reduce recon’s ability to invent economics (ghost flats at entry, recover-entry doubles)

### E. Suggested tests (concrete)
List 5–10 automated checks, e.g.:
- “Live key with post-rearm entry only → Open, realised 0, not Error”  
- “Pre-rearm entry+flatten on same calendar key → Error realised only”  
- “Alias SU vs SU.PA cannot orphan-flatten while entry open”  
- “Boot never calls shouldEmit before riskState init”  
- “Two run-forever processes → detector / refuse second clientId”

### F. What not to do
Call out dangerous “fixes” (e.g. broader auto-rearm, deleting Error PnL, disabling recon entirely) if they would recreate worse failures.

---

## Tone

Be direct and skeptical of band-aids. The operator’s requirement is simple and must drive the design:

> Wrongly executed / recon-invented closes belong in **Error trades** and **Error PnL**.  
> Genuine model recommendations that are open in IB belong in **Open trades** and **model PnL**.  
> Those two must never mix.

Audit the current codebase against that sentence first; then suggest how to make it structurally impossible to violate.
