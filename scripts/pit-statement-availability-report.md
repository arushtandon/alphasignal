# PIT Statement Availability Report

Generated: 2026-09-29T10:14:06.078Z

## Legal-deadline availability
Availability is the later of the applicable legal deadline and a plausible vendor date. A vendor date is accepted only when it is at least five days after period end and not before that deadline; US acceptedDate is preferred.

Market | Vendor-date rows | Deadline-only rows | Median availability lag (days) | F-score coverage | Cadence
--- | ---: | ---: | ---: | --- | ---
US | 5166 | 20742 | 45 | 51/68 (75%) | QUARTERLY_SCORE_UPDATE
Japan | 123 | 47915 | 45 | 97/223 (43.5%) | QUARTERLY_SCORE_UPDATE
Hong Kong | 2 | 12583 | 60 | 32/78 (41%) | QUARTERLY_SCORE_UPDATE
UK | 36 | 18632 | 90 | 33/100 (33%) | TWICE_YEARLY_SCORE_UPDATE
Germany | 0 | 8858 | 90 | 27/40 (67.5%) | TWICE_YEARLY_SCORE_UPDATE
France | 0 | 7181 | 90 | 18/40 (45%) | TWICE_YEARLY_SCORE_UPDATE

## Parts B–E status
BLOCKED: No genuine runner replays the production trend entry/exit primitives with cached PIT F-scores. scripts/backtest-performance-program.js only emits a blocked report and explicitly performs no execution, so Parts B–E were not run.

