# Exit amendment pre-registration

Frozen: 2026-10-05, before the replay. Research only until a cell passes.

## Question

For each paper-live cell, do the operator exit rules stay profitable on the
same entries as the consistency study?

## Rules under test

Entries, universes, costs (`implementation-cost-v1`), folds and non-overlap
are unchanged. Each baseline entry is reused; exits are resimulated.

1. No time exit and no signal-flip exit. A position closes only at a target
   or a stop. A position still open at the last bar is unresolved and is
   excluded from closed-trade PnL.
2. Position size targets $30,000. One exchange lot, or one mapped micro
   future, is bought when it costs more than $30,000. That single-lot
   position treats TP1 as a trigger: the stop moves to entry, then the
   existing post-TP1 daily-percent ratchet tightens only and never goes
   below entry. The runner target is entry + 2 ATR for mean reversion and
   the current engine's own TP2 otherwise.
3. Multi-lot mean reversion keeps its tested target and stop, without the
   time stop. Multi-lot current-engine trades keep their tested TP1, trailing
   stop and TP2, without the horizon time limit.

## Cells

Mean reversion: `JAPAN_MEDIUM_MR`, `JAPAN_SHORT_MR`,
`COMMODITIES_MEDIUM_MR`, `US_SHORT_MR`.

Current engine, sector overlay on: Japan long, Hong Kong medium, Hong Kong
long, Germany medium, Germany long, France long, India long, Commodities long.

## Approval

Apply the new exits only when combined four-window PnL stays positive and no
window whose baseline PnL was non-negative becomes negative. Every other cell
keeps the exits already tested.
