# Claude audit prompt — execution architecture (28 Aug 2026)

Copy everything below the horizontal rule into Claude. Attach (or grant repo access to) the files listed under **Attachments**. Also attach **both** audit documents: the original 6 Aug report and the 28 Aug operator report.

---

You are auditing **AlphaSignal** after three weeks of IBKR paper incidents. This is **not** a greenfield rewrite wishlist and **not** a style review.

Your job:

1. Audit the **changes since the 6 Aug 2026 Claude report** (findings B1/B2/B3/F1/F2).
2. Audit the **entire 28 Aug operator report** for holes, wrong facts, or band-aids dressed as fixes.
3. Concentrate on **execution architecture**: parent fill → TP1 + SL on IBKR, and why the same classes of bug keep returning (naked inventory, qty-pads, client-id zombies, venue GTC echo).

Do **not** re-litigate B1/B2/B3/F2 unless later commits broke them. Do **not** propose ticker-specific patches (`if (ticker === 'AFL')`). Do **not** recommend deleting Error PnL, disabling recon entirely, or auto-rearming every name at boot.

---

## Attachments

**Must read**

- `docs/AUDIT-REPORT-2026-08-28.md` (operator report this pass)
- Original 6 Aug Claude audit (`AlphaSignal_Audit_Report.md` / the B1–F4 table)
- `docs/CHANGES-SINCE-CLAUDE-AUDIT.md`
- `ibkr-bridge/bridge.js`
- `lib/ibkr/tp1-policy.js`
- `lib/ibkr/order-routing.js` (`shouldDeferProtectiveChildren`)
- `lib/ibkr/live-exit-authority.js`
- `server.js` (IBKR report/recon/qty-pad/AFL book — search `fillKeyIsFullyExited`, `bookAflStopLossFromIbPrint`, `closeOpenEventsIfFillFlat`)
- `scripts/lifecycle-invariants.js` (T21 / T21f)
- `ibkr-bridge/run-forever.ps1`
- `ibkr-bridge/restart-bridge.ps1`

**Context**

- `docs/claude-audit-prompt.md` (original full-system prompt)
- `docs/claude-audit-prompt-post-ibkr.md`
- `docs/claude-audit-prompt-full-system-aug2026.md`
- `docs/claude-feedback-c1-c5-scorecard.md`

**Live ops (no secrets)**

- App: `https://alphasignal-dvg5.onrender.com` (Render **Auto-Deploy Off**)
- Paper: IBKR `DU1764495`, Gateway **4002**
- One manager `clientId` **27**; workers 30–48; reserved one-shots 18/19/25–26/28–29
- Do not flatten FAST, DASH, or live BZ=F except to park missing TP1/SL

---

## What already happened (do not redo)

6 Aug findings **B1/B2/B3/F2** landed in `e7ea485`. C1–C5 Error-vs-model ingest landed in `58008d5` with refinements (quarantine **economics**, not “unauthorized because the entry event has not arrived yet”).

28 Aug execution contract (must verify in code, not trust the report):

- Splittable equity: 50% TP1 LMT + runner STP; TSL only after a **limit** TP1 print.
- 1-lot / 1-contract (incl. BZ=F): **100% TP1 LMT OCA with 100% STP**. No runner.
- Parent fill → `scheduleProtectiveBracket` parks missing children immediately (HK/JP lunch still deferred).
- Native 3-leg already submitted → do not mint a second bag.
- AFL 82 covered at NYSE open **116.44**, booked stop-loss; restore cannot re-pad a fully exited key; IB-flat pad-drop closes leftover entry events.

---

## Production incidents Claude must root-cause against **current** code

| Incident | What actually happened | Class |
|----------|------------------------|--------|
| **AFL** | Child STP $117.80 cancelled 12 Aug (`flattened 0`). 82 short naked. Covered 27 Aug OPG/MKT ~116.44, not at stop. Extra 410 that morning = Error. Site stayed “open” via qty-pad + leftover entry event → restore re-padded 82. | Naked inventory + ledger pad loop |
| **BZ=F 1 lot** | Touching TP1 did nothing: `tp1SoldQty(1,1)=0` skipped the LMT. User wants the **whole contract sold at TP1** on IBKR. | Policy hole, not a flake |
| **6098.T** | TSE bag children never ack; parent `transmit:false` all cash. Standalone parent later. | Venue bag vs standalone |
| **MNDI.L / BA.L** | LSE omits GTC from `reqOpenOrders`; bridge shrink/remint loop. | IB echo ≠ working order |
| **SU.PA (12 Aug)** | Alias miss → orphan flatten 28; re-arm 27; same day key mixed Error + model PnL. | Dual-list + recon invents economics |
| **Hold demote** | Conf refresh rewrote open history to Hold → bridge flattened live Asia as “signal/time exit”. | Book-of-record fight |
| **clientId 27** | Elevated zombie holds 27; non-elevated `run-forever` crash-loops; **new `bridge.js` never loads**. | Ops, but it made every code fix look like it “didn’t work” |

---

## Non-negotiable invariants (score each Pass / Partial / Fail)

| ID | Invariant |
|----|-----------|
| **E1** | Every **model-authorized parent fill** has a working **TP1 LMT** and **SL STP** on IBKR as soon as the venue will accept GTC (HK/JP lunch excepted). 1-lot = full qty OCA. |
| **E2** | Cancelling children with flatten qty 0 must **not** leave inventory naked. If IB still holds the side, re-park SL (and TP1 if not done) on the same tick. |
| **E3** | A fully exited fill key is never qty-padded. IB-flat pad-drop closes leftover **entry** events. |
| **E4** | Recon does not invent model realised (ghost-flat at entry, recover-entry doubles). Error economics stay on `\|cursor-err` / `errorTrade` keys. |
| **E5** | Exactly one bridge manager. A second process must **refuse**, not restart-loop on “27 in use”. |
| **E6** | `row.tp1Id` / `row.stopId` are caches. **IB working orders** (or a confirmed reject) are authoritative. LSE missing-echo must not mint duplicates. |
| **E7** | TSL never starts on a 1-lot. TSL never starts because Yahoo/last **touched** TP1 — only a TP1 **limit fill**. |
| **E8** | Dashboard top-N is a view. Open history + events + IB fills are the book. Scans cannot demote an open Buy/Sell to Hold. |

---

## What to audit (prioritized)

### P0 — Execution architecture

Current design is **event poll + native IB bag + JSON state + periodic sweep + recon pads**. It has too many writers.

Answer, with file/function evidence:

1. After a parent fill, what **exactly** guarantees TP1+SL hit IB? List every skip (`phase === 'closed'`, 15-min cooldown, `qtySold === 0`, Asia standalone, FUT filter, `tp1Id != null`). Which skips are still live after the fill-hook?
2. Is `scheduleProtectiveBracket` idempotent under `execDetails` + `orderStatus` double fire? Can it still double-place on US native bags if `stopId` is set but IB has not acked?
3. If IB cancels the STP (`flattened 0` / orphan sweep / `closeOut` remaining=0), what re-parks the stop **before** the next cash session? Would AFL 12 Aug still go naked?
4. Who owns “this lot’s protective orders”: `bridge-state.json`, IB `reqAllOpenOrders`, or the server fill ledger? Pick one and say what to delete.
5. Propose a **minimal** target architecture (one page) that would have made AFL + BZ=F + 6098 structurally impossible, not patched. Prefer:

   - **IB working orders as the child book of record**
   - **One function** `ensureProtectiveBracket(key)` adopt-or-place, called from fill **and** sweep
   - Recon that **cannot write economics** onto a live model key
   - Supervisor that **exits 0** if 27 is taken, instead of looping

### P0 — Report truth

6. Is `docs/AUDIT-REPORT-2026-08-28.md` accurate vs current code? Flag any claim that is hope, not a guarantee.
7. Which open names in §3 would **still** lack TP1/SL after this commit + an elevated restart, and why (venue closed, LSE echo, unfilled OPG)?

### P1 — Ledger / AFL class

8. Can `fillKeyIsFullyExited` + pad-drop + `closeOpenEventsIfFillFlat` still lose if the server restarts mid-drop, or if AUTH_TEST_BYPASS skips the AFL book path?
9. Are T21–T21f sufficient, or is there a missing test: “parent fill with `stopId=null` → STP+LMT transmitted once”?

### P1 — Ops

10. `restart-bridge.ps1` vs elevated `run-forever`. Concrete fix so “we deployed” means client 27 is running **this** file.
11. Render Manual Deploy vs bridge git pull in `restart-bridge.ps1` — can they diverge (site v8.2.0, bridge old)?

---

## Output format

### A. Executive summary (≤15 lines)
Is paper execution safe enough to keep running? Biggest structural risk?

### B. Scorecard
E1–E8: Pass / Partial / Fail + one-line evidence.

### C. Findings table
| ID | Severity | Area | File/fn | Scenario | Smallest fix |

### D. Delta vs 6 Aug audit
For B1, B2, B3, F1, F2, F3: still held / broken / superseded.

### E. Target execution architecture
One page. Name the single writer for (1) open model qty, (2) working TP1, (3) working SL. What the sweep is allowed to do. What recon is **forbidden** to do.

### F. Tests to add
5–10 concrete cases, including:
- 1-contract FUT fill → OCA LMT+STP full qty, no TSL
- Asia standalone parent fill during RTH → children placed same tick
- `closeOut` remaining 0 while IB still long → stop re-parked, not naked
- Fully exited key + leftover open entry event + boot restore → qty 0
- Second `run-forever` while 27 live → process exits, no 30s loop

### G. What not to do
Dangerous “fixes” that would recreate worse failures.

---

## Tone

Be skeptical of sweep-based safety. The operator’s requirement is:

> When IBKR executes a model parent, a bracket with TP1 and SL must be working on IBKR.  
> If that cannot be guaranteed, say so and propose the smallest architecture that can.

Audit the current codebase against that sentence first.
