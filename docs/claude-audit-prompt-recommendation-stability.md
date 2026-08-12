# Claude audit prompt — recommendation stability (remove recurring glitches)

Copy everything below the line into Claude. Attach (or give Claude access to) these files:

**Core**
- `server.js`
- `public/index.html`
- `ibkr-bridge/bridge.js`
- `ibkr-bridge/run-forever.ps1`
- `ibkr-bridge/list-positions.js` (optional)

**Context docs**
- `docs/CHANGES-SINCE-CLAUDE-AUDIT.md`
- `docs/claude-audit-prompt-post-ibkr.md` (prior audit scope — do not re-litigate fixed items unless regressed)

**Optional live context**
- App: `https://alphasignal-dvg5.onrender.com`
- Paper: IBKR `DU1764495`, Gateway `4002`, bridge `clientId=27`
- Recent HEAD includes recon (`/api/ibkr/recon`), IB overlay on `/api/ibkr/trades`, session/avg-exit columns, and Hold-demote latch fix for open long history (`3cb7034` and neighbors)

---

You are auditing **AlphaSignal** with one goal:

> **Make recommendations a smooth, trustworthy system** — once the model issues a Buy/Sell, the board, history, IBKR tab, and paper account stay aligned until the model exits (or an explicit unauthorized/error path). Stop the recurring “glitches.”

This is **not** a style review and **not** a feature wishlist. Focus on **state ownership, demotions, reconciliation races, and recommendation lifecycle**.

## Recurring failure modes (must explain root cause + permanent fix)

These have happened repeatedly in production paper trading. Treat them as symptoms of deeper design debt:

1. **Open recommendation wiped to Hold**  
   Example: same scan emitted **RCL short Buy** + **SU.PA long Buy**; later SU.PA showed **Hold** with blank entry/TP/SL while `reason` still said `Buy @ 302.25 · TP1 … · SL …` and `longStatus=open`. Cause class: revalidation / `applyServerPriceLevels` / wrong per-horizon action defaults (`longAction` falling through to Hold) fighting “open trade” latching.

2. **IBKR tab ≠ paper account**  
   Site open qty drifted (e.g. 0005 400 vs IB 800; 0883 3000 vs 6000); ghosts stayed open on site after IB flat (VTR/FANG/AIR); IB leftovers not on site (0001, 1810, KHC, …). Recon wrote synthetic fills then older **phantom key-age purge** deleted them → flip-flop until overlay/exempt landed.

3. **Unauthorized / error trades vs model trades**  
   Hold→Buy emits, dual-list AIR.PA vs AIR.DE, orphan flatten almost closing real shorts (9988). Rule intended: **only execute & keep model recommendations; close only explicit error-tagged unauthorized**.

4. **Conf ≥ 62% / RR ≥ 1.1:1 gates**  
   Correct for *new* picks, but historically rewrote *open* history and triggered bridge flattens. Latch/repair paths now exist — audit whether they still fight each other.

5. **Deploy / ops races**  
   Render lag, local Windows bridge, clientId collisions, missed fills while Asia session open → “glitches” that look like model bugs.

6. **Dashboard “today” vs history vs IBKR events**  
   Users see 2 trades then 1; panes rotate; SGT day keys vs host-local dates; IBKR entries without matching board rows (or the reverse).

## Non-negotiable product invariants (design toward these)

State these as hard invariants. If current code cannot guarantee them, propose the smallest architecture that can:

| ID | Invariant |
|----|-----------|
| I1 | A **new** Buy/Sell appears only if Conf ≥ 62, RR ≥ 1.1 on TP1 vs SL, and action is truly Buy/Sell (never Hold→buy). |
| I2 | Once a recommendation is **accepted into history as open Buy/Sell** (and/or IBKR `entry` emitted), later scans **must not** demote it to Hold or blank levels until an explicit exit. |
| I3 | **Dashboard picks** (rotating top-N) are a *view*; **open history + trade events** are the *book of record* for live trades. |
| I4 | Paper account positions for **tracked** tickers match AlphaSignal open qty + avg entry (within tick); ghosts closed; IB-only leftovers listed but not auto-invented as model trades. |
| I5 | Error/unauthorized names are isolated in PnL and may be flattened; **model** names are never flattened by orphan/recon logic. |
| I6 | One coherent session story: recommendation day = SGT; fill session tag = Market / Pre / Post / Lunch / After hours. |

## What to audit in the files

### A. Recommendation lifecycle (`server.js` + `public/index.html`)
- Path from quant signal → dashboard pane → history add → IBKR `entry` event.
- Every place action can become Hold or levels cleared: `applyServerPriceLevels`, `applyTierScoreCaps`, `filterDashDataByMinRR`, history revalidate / `enrichHistoryTradeRecord`, client `renderPicksPane` / Conf gates.
- Whether `hz` + `action` vs `shortAction`/`mediumAction`/`longAction` is a structural footgun.
- Repair helpers (`repairOpenHistoryActionsFromIbkrEvents`, reason-based repair) — band-aids or sufficient?

### B. Execution bridge (`ibkr-bridge/bridge.js`)
- What may place, re-arm, or flatten; interaction with open model keys vs error tags.
- Recon post to `/api/ibkr/recon` vs local orphan/unauthorized logic — overlapping authority?
- Asia chase / EU open / US pre gates vs “only recommended trades.”

### C. IBKR ledger (`server.js` `/api/ibkr/*`)
- Fill store, phantom purge, `correct-avg`, `recon`, trades overlay.
- Can purge/recon/overlay fight? Single writer for open qty?

### D. Consistency UX
- How should the UI present: **Today’s new picks** vs **Open recommendations** vs **IBKR executions** so users never think a trade “vanished” when it was demoted, rotated off the pane, or only lived in history.

## Deliverable (required structure)

### 1. Root-cause map
For each recurring glitch (1–6 above): **root cause class**, **why it recurs**, **which invariant it violates**.

### 2. Target architecture (recommendation system)
Propose a **single coherent lifecycle** (short prose + optional mermaid):

`signal → gate → open recommendation (immutable) → optional IBKR fill → manage → exit`

Define the **source of truth** for each stage (who may write action, levels, openQty, status).

Prefer **fewer writers**, explicit state machine (`pending | open | tp1_open | closed | error`), and **no silent Hold demote** of open rows.

### 3. Ranked fix plan
Table of changes:

| Priority | Change | Files | Why it stops the glitch | Risk |
|----------|--------|-------|-------------------------|------|

Separate **must-do for smoothness** from **nice-to-have**.

### 4. Concrete code-level findings
For each finding:

- **ID** (R1, R2…)
- **File + function**
- **Severity**: critical / high / medium / low
- **Failure scenario**
- **Evidence**
- **Concrete fix** (smallest correct change)

### 5. Test / invariant checklist
List automatable checks (Node scripts or assert-in-reconcile) that would have caught SU.PA demote, recon flip-flop, Hold→buy, and 9988 orphan close.

### 6. Explicit non-goals
Call out what **not** to do (e.g. permanent ticker ban lists, flattening IB leftovers that aren’t error-tagged, “fix” open trades by blanking levels).

## Constraints
- Paper trading first; do not assume live account.
- User direction: **only execute trades the model recommended**; do not auto-close genuine open recommendations.
- Keep Conf ≥ 62 and RR ≥ 1.1 for **new** entries.
- Prefer minimal, durable design over more reconcile heuristics.
- Do **not** re-open settled debates from the prior IBKR audit unless current code regresses them.

## Success definition
After your plan is implemented, a user should be able to say:

> “If the model recommended it, it stays on Open until the model exits; the IBKR tab matches paper; nothing vanishes overnight because a rescan lowered the score.”

End with a **short executive summary** (≤10 bullets) of the path to that outcome.
