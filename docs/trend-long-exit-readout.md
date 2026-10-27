# Live trend-long exit diagnostic readout

Status: blocked; no exit candidate was tested or promoted.

The requested comparison must preserve the exact historical production entry
events, then alter only exits. Those entry events include the FMP quality input.
The local research environment has neither a configured FMP credential nor a
verified point-in-time history of that score. Replacing it with today's value,
or omitting it, would select a different population of entries and falsely
present an entry-and-exit change as exit-only.

The approved 10% maximum holdout-PnL deterioration and all planned candidates
remain frozen in `docs/mean-reversion-winrate-preregistration.md`. Once a
point-in-time FMP feed is verified, replay the exact US/Japan/France
medium-and-long buy entry decisions, select exits only inside the development
folds, and evaluate the untouched holdout. No live bracket or recommendation
rule was changed.
