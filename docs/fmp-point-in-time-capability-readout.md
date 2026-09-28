# FMP point-in-time capability readout

Probe environment: Render production service, 28 September 2026. The service
reported `credentialConfigured: true`; these are the real Render findings, not
the earlier local `NOT-CONFIGURED` output.

| Requirement | Endpoint | Render verdict | PIT decision |
|---|---|---|---|
| Analyst estimate revisions | `/stable/analyst-estimates` | CURRENT-only — forecast-period dates, but no publication, update, or revision timestamp proving when the estimate was knowable | Disqualified. Do not use for historical revision momentum. |
| Rating-change history | `/stable/grades-historical` | PRESENT-with-history | Eligible for point-in-time rating-change momentum, subject to the dated-row coverage captured below. |
| Earnings report / surprise | `/stable/earnings` | PRESENT-with-history — report date plus actual and estimated EPS are present | Eligible for post-earnings-drift research, respecting the existing earnings blackout. |
| Financial score | `/stable/financial-scores` | CURRENT-only | Disqualified. Never replay today's score in a historical test. |
| Price-target summary | `/stable/price-target-summary` | CURRENT-only | Disqualified for historical target-change research. |
| Legacy rating / upgrades | `/api/v3/historical-rating`, `/api/v4/upgrades-downgrades` | NOT-ON-PLAN | Not a substitute for `grades-historical`. |

## Research verdict

The estimate-revision lever is **not testable** on the current plan. A
forecast-period date is not a revision timestamp and must not be treated as
one. Two separate PIT research levers are available:

1. `grades-historical`: rating-change momentum.
2. `earnings`: post-earnings drift using the dated report, actual EPS, and
   estimated EPS.

## Extended capture

At each Render process start, the server writes the redacted capture to
`/var/data/fmp-capability-verdict.json`. The extended probe records:

- quarterly income statement, balance sheet, and cash flow schemas, specifically
  whether `filingDate` or `acceptedDate` is present. Only those timestamps can
  qualify a recomputed Piotroski F-score or Altman Z as an as-of filing quality
  gate;
- `grades-historical` earliest dated row and average row spacing;
- row-count coverage for `7203.T`, `0700.HK`, `SHEL.L`, `SAP.DE`, and `MC.PA`
  across grade history, earnings, and each quarterly statement.

Until the capture demonstrates an `acceptedDate` or `filingDate`, statement-
derived quality remains CURRENT-only for backtest use. The capture contains
only field names and allow-listed/redacted sample fields; it never persists the
FMP credential or raw provider response.
