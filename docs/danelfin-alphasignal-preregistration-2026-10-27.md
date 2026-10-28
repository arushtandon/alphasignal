# Danelfin + AlphaSignal — pre-registration

Written 2026-10-27. Amended 2026-10-28. Not run. Do not start the history pull or the study until this file is approved.

Buy books use AI score = 10 only. The sell book uses AI score = 1 only. That is two ranking calls per date. Lists filtered with a minimum (AI >= 9) or a second low score (AI = 2) are likely to come back at the 100-name cap and would be an incomplete universe. If the discovery calls for the latest session return exactly 100 names on either side, the history pull stays stopped.

## What the ranking endpoint does

- One ranking route. At least `ticker` or `date` (`YYYY-MM-DD`) is required.
- Date only: the top 100 tickers that day. No offset, no next page, no ascending sort.
- Ticker only: the last 100 market days for that ticker, not the full history. Those rows are ordered by date, not by score.
- Ticker and date: that name on that day.
- Fields: `aiscore`, `fundamental`, `technical`, `sentiment`, `low_risk`, plus buy and sell track-record flags. Scores are 1–10.
- `aiscore` filters to one exact score, 1 through 10. The docs describe this as the tickers with that score on that day, and the example is `aiscore=10`. `aiscore_min` is a floor. There is no `aiscore_max` and no parameter that sorts the ranking from lowest score to highest.
- Markets: US by default. Europe with `market=europe`, history from 2022-01-03. This study is US only.
- Docs do not say whether a past date is the score as published that day or a later recompute. The study records that as unknown until Danelfin says otherwise. From the day this system stores a response, that file is our as-published copy and is never refetched.

## Call plan (not started)

Research share is 340 calls this month. Live keeps 60. Reserve 100 stays untouched.

A date with no score filter returns at most 100 names, the top of the ranking. There is no ascending sort. Each date in the pull is two calls: exact AI score 10, and exact AI score 1.

The research share is 340 calls per month. Live keeps 60. Reserve 100 stays untouched. The three discovery calls count against October's research share. Nothing below is started.

If `2018-01-02` comes back with a score, month-end dates run from January 2018 through September 2024 (81 dates, the last month before the two-year weekly window). That is 162 calls. The last two years are 104 week-end dates, 208 calls. 162 + 208 = 370, which does not fit in one month next to the discovery calls.

| Month | What | Calls |
| --- | --- | ---: |
| October 2026 | 3 discovery calls, then 81 month-ends × 2, then the first 87 of 104 week-ends × 2 | 339 |
| November 2026 | the remaining 17 week-ends × 2 | 34 |

If `2018-01-02` has no scores, the month-end series starts at the first date that does, October's total falls, and the leftover week-ends still finish in November. Each response is written immediately and is never fetched again.

## Universe and trade rules

Universe: our US ever-members (S&P 500 and Nasdaq-100 history) that also appear in the Danelfin response for that signal date.

Entry: next session open. Costs: `lib/research/cost-model.js` US profile. Notional: $10,000 per trade, plus executable books at k = 1, 2 and 5 with $30,000 per name. Stop is evaluated before the target. A symbol already in an open trade of the same book is not entered again.

Books:

- **S-BUY** (short horizon, long the stock): AI = 10 and Williams %R(10) < -95 and close > MA200 and the vol-skip-top-30 regime. Exits are the US_SHORT_MR rules (ATR target and stop, time stop).
- **M-BUY** (medium): AI = 10 and close > MA200 and MA200 rising over 21 sessions and 12-1 > 0 and the engine medium score >= 62 from the same signal function the backtest uses. If that score cannot be reproduced on history, the arm uses 6-month relative strength in the top 30% instead, and the readout says so. Stop 2.5 ATR, engine targets, maximum 63 sessions.
- **L-BUY** (long): AI = 10 and point-in-time Piotroski >= 6 and 12-1 > 0. Monthly. Take the top k by AI score, then by 12-1. Hold 6 months.
- **SELL** (medium): AI = 1 and close < MA200 and MA200 falling and 6-month relative strength in the bottom 30%. Short the stock and buy a beta-scaled SPY hedge. Cover when close > MA50 or at 63 sessions. Borrow 1% a year, 3% if the price is under $5.

Each book has three arms: Danelfin only (same exits, no overlay), AlphaSignal only (the overlay on the full universe, no Danelfin), and both.

## Report and pass rule

Per arm: trades, win rate, profit factor, total dollar P&L, average win, average loss, max drawdown, each of the four windows, each year, excess versus SPY and versus QQQ (sells: the hedged spread), alpha t on SPY+QQQ, and the executable k = 1, 2, 5 results.

Pass: the combined arm is profitable with PF >= 1.2 in every window that has trades, monthly excess t >= 3, alpha t >= 2, and it beats both other arms on full-sample dollar P&L and on PF, and in at least 3 of the 4 windows. Otherwise apply `docs/incubation-tier.md`.

Trials counted for the deflated Sharpe: 4 books × 3 arms × the k variants (the $10k book plus k = 1, 2, 5). No arm is dropped after seeing results.

Look-ahead: signals only on dates after Danelfin was publishing. The probe's earliest date is the start. Dates before that are out.

## Live design (not built)

After a pass, or after a separate incubation approval: one ranking call per side after the US close, at a fixed time. Candidates go through our overlay on our own prices. Cards show the AI score and our reasons. Responses are stored on the data disk with the date, and that file is the as-published record from that day forward. If the live share (60) is exhausted or the breaker is open, Danelfin books pause, every other book runs, and Telegram is sent. Nothing here turns a book on.
