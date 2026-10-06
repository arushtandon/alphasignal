# Strategy gaps amendment — 2026-10-06

Frozen before the re-run. Research only. The bridge is not changed and nothing
is enabled.

This note corrects the implementation of the pre-registration
`b173577d0bfa8f377b5bf488bb320df5426a2eeb`
(`docs/strategy-gaps-preregistration-2026-10-06.md`). It does not add a
variant, change the four test windows, change the pass rule, or change the
trial counts. The pre-registered readout
(`docs/strategy-gaps-readout.md`) and `scripts/strategy-gaps-results.json`
are left as the original run. The re-run writes
`docs/strategy-gaps-amendment-results.md` and
`scripts/strategy-gaps-amendment-results.json`.

Trial counts that must come back unchanged: F1 288, F3 6, F4 6, F5 18,
F6 24, F7 54. F1 and F7 are copied from the original results file and are
not recomputed. F2 stays the original data gap and is not requested again.
k=1 and k=2 rows are executable scores of the same F4 variants. They are
not extra trials.

## 1. Universe — F3, F4, F5, F6

The candidate set is every symbol that was a member on any replayed date,
not `currentSymbols` alone.

Replay is the existing point-in-time function: start from `currentSymbols`,
and for each change after the as-of date remove `added` and add `removed`.
The candidate set is the union of `currentSymbols` and of that replay on
every change date. A signal still requires membership on the signal date.
A market with no dated membership file stays a data gap. A current
constituent list is not substituted.

Dated files used: `data/research/fmp/us-universe.json` (F3, F4, F5),
`data/research/index-membership/ftse100.json` (F5, F6),
`data/research/index-membership/cac40.json` (F5, F6).

Report, per calendar year, membership at 31 December of that year:
members, members with a loadable price file, and missing (members without
a price file). Years run from the first change year through the last year
in the benchmark.

A name that stops trading during a hold exits at its last close. The trade
is not dropped. A name with no bar on the entry date never opened and is
not counted. The re-run logs the early-exit count by family.

## 2. F4 excess return and k=1 / k=2

(a) The verdict stays on the raw monthly book return versus SPY, with the
original t-stat. In addition, each F4 variant reports the t-stat of monthly
excess return (book minus SPY in the same month) and the family deflated
Sharpe of those excess series. The deflated-Sharpe trial set is the same
six variants. Raw deflated Sharpe stays in the report.

(b) Each of the six variants is also scored as an executable book: the top
k names that month, $30,000 each, real lot sizing. k is 1 and k is 2.
Medium variants hold one month. Long variants hold six months in six
overlapping sleeves, so the slot count is 6 at k=1 and 12 at k=2. Medium
slot count is 1 and 2. Residual variants rank by residual alpha. Industry
variants rank the names inside the selected industries by their own
126-session return. These rows use the same windows and the same pass
rule. They do not enter the trial count.

## 3. F3 event window

The abnormal return is the stock's close from the session before d0 to the
session after d0, minus the same SPY close-to-close move. d0 is the first
session on or after the report date. Entry is the open of d0+2. Holds stay
21, 42, and 63 sessions. Sides stay long and short.

Decile cutoffs come from events whose d0 is strictly earlier, inside the
prior 63 benchmark sessions, and in an earlier calendar month. The same
month is never used. A cutoff sample smaller than 10 events does not
select. Top decile is long. Bottom decile is short. Width is
floor(sample / 10).

If the cached earnings files or one FMP earnings response carry a
before-open or after-close field, report the coverage. Do not move d0 or
the entry because of that field.

## 4. F5 Altman inputs

Financials and real estate are excluded from the Altman Z test. On the
current FMP profile the sector strings are `Financial Services` and
`Real Estate`. For those sectors Z is missing, so a Z rule cannot pass.
Piotroski is unchanged. A missing profile is not treated as a financial.

Liabilities are `totalLiabilities` only. The
`totalLiabilitiesAndStockholdersEquity` fallback is removed. If
`totalLiabilities` is missing, Z is missing.

## 5. No F1 or F7 re-run

F1 and F7 cells, and their deflated Sharpe rows, are copied from
`scripts/strategy-gaps-results.json`. Their code path is not executed.

## 6. QQQ hurdle — reporting only

For US long books only: F3 long (all three holds) and F4 (all six variants,
plus k=1 and k=2). The pass rule stays the SPY rule.

Report next to the SPY figures: QQQ full-sample return, book return minus
QQQ return in each of the four windows, book max drawdown against QQQ max
drawdown, and book monthly Sharpe against QQQ monthly Sharpe.

Regress the book's monthly returns on SPY and QQQ monthly returns together
(intercept plus two betas). Report the intercept annualized as 12 times the
monthly intercept, the t-stat of that monthly intercept, and both betas.

Add the column `beats QQQ`. It is true when the full-sample return is above
QQQ, or when the full-sample return equals QQQ and the book's max drawdown
is smaller.
