# Danelfin + AlphaSignal — pre-registration

Written 2026-10-27. Not run. Do not start the history pull or the study until this file is approved.

The API findings below are from Danelfin's public ranking docs. The three confirmation calls (earliest US date, AAPL history shape, one date with AI >= 9) are made by `POST /api/danelfin/discover` and stored on the data disk. This file is updated with those counts after that single run. No further calls are part of this registration.

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

A date with no score filter returns at most 100 names, the top of the ranking. The sell book stays, because the docs do allow an exact score filter. There is still no ascending sort.

- Buy side, one call per date: `aiscore_min=9`. If the saved response has 100 tickers, treat it as truncated and say so. Do not invent a second page.
- Sell side, two calls per date: `aiscore=1` and `aiscore=2`. That is the documented way to ask for the lowest scores. If a saved response is empty or capped at 100, record that and stop the sell book before spending the rest of the calls.

Schedule, inside the 340:

| Phase | Dates | Calls per date | Calls |
| --- | --- | ---: | ---: |
| 1 | Month-ends from the first date the probe shows is live, through 24 months ago | 3 | about 3 × months. At a 2019 start that is ~80 months × 3 = 240 |
| 2 | Week-ends for the last 24 months, only with what is left under 340 | 3 | at most 100 (about 33 weeks, not all 104) |

Spread phase 1 across the rest of this month and next if 240 does not fit beside other research use. The pull is checkpointed per date and side, writes each response immediately, and resumes without a repeat call.

## Universe and trade rules

Universe: our US ever-members (S&P 500 and Nasdaq-100 history) that also appear in the Danelfin response for that signal date.

Entry: next session open. Costs: `lib/research/cost-model.js` US profile. Notional: $10,000 per trade, plus executable books at k = 1, 2 and 5 with $30,000 per name. Stop is evaluated before the target. A symbol already in an open trade of the same book is not entered again.

Books:

- **S-BUY** (short horizon, long the stock): AI >= 9 and Williams %R(10) < -95 and close > MA200 and the vol-skip-top-30 regime. Exits are the US_SHORT_MR rules (ATR target and stop, time stop).
- **M-BUY** (medium): AI >= 9 and close > MA200 and MA200 rising over 21 sessions and 12-1 > 0 and the engine medium score >= 62 from the same signal function the backtest uses. If that score cannot be reproduced on history, the arm uses 6-month relative strength in the top 30% instead, and the readout says so. Stop 2.5 ATR, engine targets, maximum 63 sessions.
- **L-BUY** (long): AI = 10 and point-in-time Piotroski >= 6 and 12-1 > 0. Monthly. Take the top k by AI score, then by 12-1. Hold 6 months.
- **SELL** (medium): AI <= 2 and close < MA200 and MA200 falling and 6-month relative strength in the bottom 30%. Short the stock and buy a beta-scaled SPY hedge. Cover when close > MA50 or at 63 sessions. Borrow 1% a year, 3% if the price is under $5.

Each book has three arms: Danelfin only (same exits, no overlay), AlphaSignal only (the overlay on the full universe, no Danelfin), and both.

## Report and pass rule

Per arm: trades, win rate, profit factor, total dollar P&L, average win, average loss, max drawdown, each of the four windows, each year, excess versus SPY and versus QQQ (sells: the hedged spread), alpha t on SPY+QQQ, and the executable k = 1, 2, 5 results.

Pass: the combined arm is profitable with PF >= 1.2 in every window that has trades, monthly excess t >= 3, alpha t >= 2, and it beats both other arms on full-sample dollar P&L and on PF, and in at least 3 of the 4 windows. Otherwise apply `docs/incubation-tier.md`.

Trials counted for the deflated Sharpe: 4 books × 3 arms × the k variants (the $10k book plus k = 1, 2, 5). No arm is dropped after seeing results.

Look-ahead: signals only on dates after Danelfin was publishing. The probe's earliest date is the start. Dates before that are out.

## Live design (not built)

After a pass, or after a separate incubation approval: one ranking call per side after the US close, at a fixed time. Candidates go through our overlay on our own prices. Cards show the AI score and our reasons. Responses are stored on the data disk with the date, and that file is the as-published record from that day forward. If the live share (60) is exhausted or the breaker is open, Danelfin books pause, every other book runs, and Telegram is sent. Nothing here turns a book on.
