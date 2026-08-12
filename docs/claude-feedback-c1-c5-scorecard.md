# Feedback prompt for Claude — which C1–C5 suggestions held up

Copy everything below the horizontal rule into Claude. Attach (optional): the original structural-fix brief Claude wrote, plus current `server.js` / `ibkr-bridge/bridge.js` / `ibkr-bridge/listing-aliases.js` / `scripts/lifecycle-invariants.js` at HEAD `58008d5` if you want Claude to reconcile against the landed code.

---

You previously proposed a structural fix for AlphaSignal (Error vs model PnL separation + boot-order safety), labeled Changes **C1–C5** plus tests **T1–T7**.

That brief was **verified against production code and incident history**, then **implemented with refinements** (commit `58008d5`). Your job now is **not** to re-propose the same plan. Instead:

1. Read the **scorecard below** (good / bad / mixed).  
2. Internalize the **reasoning** so future AlphaSignal advice avoids the failure modes we already hit.  
3. Reply with a short acknowledgment: what you will keep doing, what you will stop recommending, and **one** improved rule of thumb for “Error PnL vs model PnL” designs.

Do **not** invent new refactors unless asked. Do **not** re-litigate deleted SU.PA one-offs as if they should return.

---

## Context (one paragraph)

AlphaSignal mirrors model Buy/Sell into IBKR paper via a local bridge. The Aug-12 **SU.PA** incident mixed (a) a wrongly orphan-flattened ~28-lot cycle and (b) a genuine re-armed ~27-lot open on the **same SGT day key**. Per-trade `errorTrade` boolean then mis-bucketed realised PnL. Claude proposed enforcing separation at ingest and deleting ticker-specific patches.

---

## Scorecard

### C1 — Quarantine unauthorized / error fills at ingest → `|cursor-err`

**Verdict: GOOD (with a critical refinement)**

**Why good**
- Correct root diagnosis: Error vs model must be a **ledger key rule**, not a UI colour on a mixed fill bag.
- Making `mutateFillLedger` the choke point matches the existing single-writer design.
- Audit logging of re-keys is the right observability.

**What was wrong / incomplete in the original wording**
- “Re-key if **not** `isPositionAuthorizedByProvenance`” is **too aggressive** for **real, non-synthetic** bridge fills. Fills often arrive in a race before the `entry` event exists; blind unauthorized→Error would mis-file legitimate model fills.
- Pure “unauthorized at write” does **not** fully explain SU.PA: the morning **28 entry was authorized when written**. Mixing happened later via **synthetic ghost-flat + same-day re-arm** on the same key.
- Needed extras we added:
  - Re-key when `errorTrade` / `synthetic` / recon-family (`ghost-flat`, `recover-entry`, `repair-ibflat`, `recon-flat`, …).
  - **Same-day re-entry hygiene**: before a fresh entry / re-arm, move **prior fills on that key** to `|cursor-err`.
  - Boot migration: move error/recon fills off model keys, and move fills **older than the latest open entry event** on that key (generalizes the SU.PA cutoff without date literals).

**Rule of thumb to keep:**  
Quarantine **economics that are system/recon/error**, not every fill that momentarily lacks provenance.

---

### C2 — Kill boot-order TDZ around `riskState` / `isNewEntryRiskBlocked`

**Verdict: GOOD (accept as written)**

**Why good**
- Matches a real production bug: boot re-arm ran before `let riskState` → TDZ → history `entryDate` advanced with **no entry event** (“still no SU.PA execution”).
- Null-safe “if not ready, **block** (return true)” is the correct fail-closed behaviour.
- Init-before-use beats “must NOT call here” comments.

**Minor note**
- After init is safe, **still do not auto-rearm at boot** (see C3). Boot safety ≠ auto-trading.

---

### C3 — Delete SU.PA-specific remediation; generic `reArmModelEntry` + on-demand API

**Verdict: GOOD (after C1 lands)**

**Why good**
- Ticker/date literals (`SU.PA|long|Wed Aug 12 2026`, hard-coded exec IDs, boot auto-rearm) do not generalize and keep re-running forever.
- On-demand `POST /api/ibkr/rearm { key, force? }` is the right operator control.
- “Do not delete Error PnL data” is correct.

**What would have been bad if done first**
- Removing SU.PA split/seed **before** general ingest quarantine would have left the UI broken again.
- Boot auto-rearm must stay gone; it caused the TDZ incident class and surprises operators.

---

### C4 — Recon may fix qty/avg but must not invent model realised on a live key

**Verdict: MIXED → good only with the pairing rule**

**Why the intent was good**
- Synthetic families (`recon-flat-*`, `recover-entry-*`, …) created the 28→56 narrative and fake realised.
- Idempotent recon is mandatory.

**What was bad / dangerous if taken literally**
- “Write ghost-flat only to `|cursor-err`” **without** also **exiting / quarantining the paired open entry cycle** leaves **site open vs IB flat** (ghost open qty on the model key).
- That pairing failure is exactly how operators lose trust in the IBKR tab.

**Landed refinement**
- Synthetic close → `|cursor-err` **and** idempotent `exit` + `quarantineKeyFillsToCursorErr` for the live key when a model entry was still open.
- Restore GET `/api/ibkr/trades` to **read-only** (mutating GET broke lifecycle idempotency).

---

### C5 — Complete + share dual-list alias resolution

**Verdict: MOSTLY GOOD (but overstated as “missing”)**

**Why good**
- Shared source of truth prevents server/bridge drift.
- Orphan-flatten must resolve **all** aliases before treating IB `SU` as IB-only vs open `SU.PA`.
- Logging aliases when skipping a flatten helps ops.

**What was overstated**
- By the time of the brief, **SU/SU.DE/bare SU and DHL/AIR aliases already existed** on both sides. The Aug-12 orphan flatten happened when aliases were incomplete **earlier**; the remaining work was **share + assert + test**, not invent the table from scratch.
- Prefer a tiny shared module over duplicating large tables “by hand” in two files.

---

### Tests T1–T7 (as originally numbered)

**Verdict: GOOD intent; numbering collided with existing suite**

**Why good**
- Ingest re-key, alias protection, boot null-safety, recon idempotency, and Error/model bucket closure are the right invariants.

**What was bad operationally**
- The repo already had `scripts/lifecycle-invariants.js` **T1–T6**. Overwriting those numbers would destroy coverage (Hold demote latch, phantom purge, Hold→buy emit, etc.).
- Landed as **additive T7–T13** instead.

**Also:** “GET trades mutates once to heal” fought an existing invariant (GET must be byte-identical). Healing belongs in boot/recon/ingest, not GET.

---

## Summary table (for Claude)

| Item | Score | One-line reason |
|------|-------|-----------------|
| C1 ingest quarantine | **Good + refine** | Right invariant; don’t re-key all unauthorized real fills; handle same-day re-arm |
| C2 boot TDZ / null-safe risk | **Good** | Exact production failure mode |
| C3 delete SU.PA one-offs + on-demand rearm | **Good (after C1)** | Generalize; no boot auto-rearm |
| C4 recon no model realised | **Mixed** | Needs exit+quarantine pairing; no mutating GET |
| C5 shared aliases | **Mostly good** | Share/test; table largely already present |
| Tests | **Good intent** | Extend existing suite; don’t renumber |

---

## What Claude should stop recommending

1. **Ticker-specific boot repairs** with hard-coded keys/dates/execIds.  
2. **Boot auto-rearm** of live orders.  
3. **Mutating GET `/api/ibkr/trades`** as a “heal the ledger” side effect.  
4. **Re-keying every fill that fails provenance** at the moment of write (race with entry events).  
5. Claiming dual-list aliases are “missing” without grepping both `server.js` and `bridge.js` first.

## What Claude should keep recommending

1. **Ledger-key separation** (`|cursor-err`) as the Error PnL boundary.  
2. **Single writer** (`mutateFillLedger`) for fills.  
3. **Fail-closed risk gates** and init-before-use.  
4. **Same-day re-entry hygiene** (quarantine prior cycle before new entry).  
5. **Lifecycle invariants** that fail first on mixed Error/model keys and alias orphan-flatten.

---

## Required reply format

```
## Keep
- …

## Stop
- …

## One rule of thumb
<one sentence on Error vs model PnL>

## Confidence
<high/medium/low> that this feedback matches what was shipped
```

Be concise. Do not propose a new multi-week roadmap unless asked.
