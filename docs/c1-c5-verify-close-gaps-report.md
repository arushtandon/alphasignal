# C1–C5 verify-and-close-gaps report (post-58008d5)

## Verification table

| Invariant | Verdict | Evidence |
|-----------|---------|----------|
| **I1** Ingest quarantines economics (errorTrade / synthetic / recon-family), not “unauthorized-at-write” | **PRESENT** | `shouldQuarantineFillToCursorErr` `server.js` ~13299–13309: returns `false` for real non-synthetic fills; re-keys error/synthetic/recon. Wired in `mutateFillLedger` ~13808 and report ingest via `quarantineFillForLedger`. Pre-open-entry cutoff in `quarantineErrorFillsOffModelKeys` ~13376–13392. `auditLog('ibkr_fill_rekey', …)` on every re-key. |
| **I2** Same-day re-entry hygiene | **GAP → FIXED** | Was only in `reArmModelEntry` (~13462). Now also in `emitTradeEvent('entry')` when prior fills exist on the live key (`entry-prior-cycle`). |
| **I3** Recon pairs synthetic close with exit + quarantine; GET read-only | **PRESENT** | Ghost-flat → `errKey` + `emitTradeEvent('exit')` + `quarantineKeyFillsToCursorErr` ~14457–14485. Idempotent via `_ibkrExecIds.has(execId)`. GET `/api/ibkr/trades` ~14938: read-only, no ledger mutate. |
| **I4** Boot fail-closed; no boot auto-rearm | **PRESENT** | `riskState` + `isNewEntryRiskBlocked` ~6927–6948 (block if not ready). Boot comment ~13891: re-arm on-demand only. `POST /api/ibkr/rearm` ~13913. |
| **I5** Shared aliases + skip flatten when alias open | **PRESENT** | `ibkr-bridge/listing-aliases.js`; server requires it ~12664; bridge requires it ~141. Skip + log aliases ~3195–3196 in `bridge.js`. |

## Known-bad patterns — not reintroduced

- No ticker/date-literal boot repairs / hardcoded SU.PA execIds  
- No boot auto-rearm  
- No mutating GET `/api/ibkr/trades`  
- No “quarantine every fill lacking provenance”  

## Tests

`node --check server.js` / `bridge.js` — pass.  
`node scripts/lifecycle-invariants.js` — **All T1–T16 passed** (T1–T6 preserved; T7–T13 from 58008d5; **T14–T16** additive for race-safe real fills, entry-prior quarantine, recon predicate shape).

## Commit

Follow-up: `Close C1-C5 gaps: entry-prior quarantine and additive T14-T16.`
