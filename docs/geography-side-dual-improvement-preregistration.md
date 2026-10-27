# Geography/side dual-improvement follow-up

This follow-up is frozen before generating its result file. It does not alter
the original advanced-factor study or production trading rules.

## Objective

Select models independently for each geography × horizon × side cell. A
challenger is eligible on each development-validation fold only when it:

- has a strictly higher win rate than the current balanced baseline;
- has strictly higher net PnL than that baseline;
- retains positive net expectancy and PnL, profit factor at least 1.3, and the
  existing Bayesian and sample-size safeguards.

The existing 26 models, factor thresholds, three exit profiles, transaction
costs, folds, embargoes, next-open fills, and stop-first assumptions remain
unchanged.

## Untouched verification

The model/exit chosen from the three development folds is frozen before the
final holdout. A model is not recommended unless both development OOS and final
holdout win rate and PnL are strictly greater than baseline. Existing
requirements for 65% win rate, PF at least 1.3, positive PnL, minimum samples,
fold stability, and multiple-testing control also remain in force.

Models that improve only win rate or only PnL are reported as diagnostics but
are not recommended. Holdout results are never used to choose a replacement.
