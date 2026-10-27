# Setup-book gates between an entry event and placeBracket

Checked 2026-10-27 against `ibkr-bridge/bridge.js` `handleEvent` → `placeBracket`
and `lib/risk/sizing.js`. "In the backtest" means the evidence run that
produced the setup (`lib/strategy/evidence-setup-book.js` simulate / the
momentum and TOM planners). A gate that was not in that run does not apply
to a row with `setupId`.

| Gate | In the backtest? | Setup-book rows |
| --- | --- | --- |
| Paper-only / live refuse / execution flag | no — operational | kept |
| Buy/Sell side | yes | kept |
| Error-trade blocklist | no — bad-fill quarantine | kept |
| 06:00 SGT release | no — it times the order to the tested session, it does not drop a name for a signal reason | kept |
| Missing entry, or missing stop on a book that has stops | yes (MR has stops; momentum/TOM are no-stop) | kept |
| History row is Hold | no | **removed** |
| Published-board membership | no | **removed** |
| 24h age | no — stops a stale replay placing | kept |
| Signals-only flag | yes (the cell is not traded) | kept |
| No IB contract / unresolved future | no — cannot send | kept |
| Already holding that commodity future | no — stops a second lot on the same contract | kept |
| **Spread cap 50 bps (`spread-limit`)** | **no** | **removed** (ALAB 2026-10-25, entry 257.16 / stop 207.27, was rejected here before the ticket) |
| Drawdown throttle and capital-stage block | no | **removed on paper** — see the note below |
| $30k / $10k ticket, one-lot floor | the ticket is the tested size | kept |
| Setup order shape (partial needs two lots) | yes | kept |
| Per-setup position cap and the 50-slot / 2× / 15% pool | no — the live capital plan, not a signal filter | kept |
| Legacy 75% available-capital utilisation | no | **removed** (the pool is the setup-book check) |
| US RTH chase cap (`SKIP-CHASE`) | no — the backtest fills at the open | **removed** |
| Bracket floor / +1.5pt stop widen | no | already skipped (`applyOpenLotExitWiden` returns on `row.setupId`) |
| Min R:R 1.1 | no — applied when a board pick is built, not in the setup simulator | not on this path |

`setupBook: true` on `calculateRiskSize` is what skips spread-limit, the
drawdown throttle and the capital-stage block. The ticket branch is unchanged.

The drawdown throttle (half size at 5% drawdown, quarter at 7.5%, flat at
10%) was removed for setup-book rows on the paper account so the live order
matches the backtest, which has no such throttle. It is not a decision about
a live-money account. Turn it back on, or replace it, explicitly before any
live-money use of these rows. The capital-stage block is in the same bucket.
