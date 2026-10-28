# Danelfin + AlphaSignal — pre-registration

Written 2026-10-27. Amended 2026-10-28 after the discovery calls. The backtest has not been run. Do not start it until the candidate table below is approved.

The sell book is dropped. On 2026-10-27, `aiscore=1` returned exactly 100 names, so the list is capped, and only 1 of those 100 is in our ever-member universe (STI, not a current member). There is no way to know which other AI = 1 names were cut off. No AI = 1 history is pulled.

## What the ranking endpoint does

- One ranking route. At least `ticker` or `date` (`YYYY-MM-DD`) is required.
- Date only: the top 100 tickers that day. No offset, no next page, no ascending sort.
- Ticker only: the last 100 market days for that ticker, not the full history. Those rows are ordered by date, not by score.
- Ticker and date: that name on that day.
- Fields: `aiscore`, `fundamental`, `technical`, `sentiment`, `low_risk`, plus buy and sell track-record flags. Scores are 1–10.
- `aiscore` filters to one exact score, 1 through 10. The docs describe this as the tickers with that score on that day, and the example is `aiscore=10`. `aiscore_min` is a floor. There is no `aiscore_max` and no parameter that sorts the ranking from lowest score to highest.
- Markets: US by default. Europe with `market=europe`, history from 2022-01-03. This study is US only.
- Docs do not say whether a past date is the score as published that day or a later recompute. The study records that as unknown until Danelfin says otherwise. From the day this system stores a response, that file is our as-published copy and is never refetched.

## Call plan (buy side only)

Research share is 170 calls this month. The live sweep keeps 130. View lookups keep 60. Reserve is 140. The same pace, breaker and monthly cap still apply. October's history pull was counted under the previous 340 research share; the calls already stored stay counted, and the approved completion of that pull may draw the reserve because 170 no longer covers them.

| Stage | Dates | Calls |
| --- | --- | ---: |
| Month-ends | Last weekday of each month, January 2018 through September 2024 | 81 |
| Week-ends | 104 Fridays ending 2026-10-23 | 104 |
| October total with discovery | | 188 |
| Capped week-ends, by sector | 7 Fridays × 11 sectors | 77 |
| October total with the sector split | | 265 |

265 is inside the 340 research share. Each response is written before the next call. A date already stored is not fetched again. Nothing is requested after 31 Oct 2026 24:00 UTC.

Seven week-end files came back with exactly 100 names. The ranking route accepts a `sector` slug. The 11 slugs on the sectors list are communication-services, consumer-discretionary, consumer-staples, energy, financials, health-care, industrials, information-technology, materials, real-estate, and utilities. No call is spent to list them again. Each of those seven dates is requested once per sector, `aiscore=10`, same fields, checkpointed the same way. A sector already stored is not fetched again.

A date is treated as uncapped only when every sector response has fewer than 100 names and every name in the original 100 is in the union. A sector that returns 100 stays flagged, and that week is not replaced by a partial union. The candidate table then reports that week both as the stored 100 and as excluded.

## Universe and trade rules

Two universes, counted as separate arms. A Danelfin ticker is matched to our symbol on the signal date. A ticker that was removed and later added again in the membership file (STI is the discovered example) is flagged as reused and is not treated as the same company across that gap.

- **U1.** Our S&P 500 and Nasdaq-100 ever-members whose membership includes the signal date, and who appear in the AI = 10 list that day.
- **U2.** Liquid US names in the AI = 10 list: price at least $5, market cap at least $2 billion, and 20-day average dollar volume at least $20 million, all on the signal date. Prices must include delisted names from FMP. A name with no price history is listed in the readout and is not dropped quietly.

The candidate table (count and sector mix per month, U1 and U2) is filled from the stored AI = 10 responses before any backtest. That table is what gets approved.

Entry: next session open. Costs: `lib/research/cost-model.js` US profile. Notional: $10,000 per trade, plus executable books at k = 1, 2 and 5 with $30,000 per name. Stop is evaluated before the target. A symbol already in an open trade of the same book is not entered again.

Books:

- **S-BUY** (short horizon, long the stock): AI = 10 and Williams %R(10) < -95 and close > MA200 and the vol-skip-top-30 regime. Exits are the US_SHORT_MR rules (ATR target and stop, time stop).
- **M-BUY** (medium): AI = 10 and close > MA200 and MA200 rising over 21 sessions and 12-1 > 0 and the engine medium score >= 62 from the same signal function the backtest uses. If that score cannot be reproduced on history, the arm uses 6-month relative strength in the top 30% instead, and the readout says so. Stop 2.5 ATR, engine targets, maximum 63 sessions.
- **L-BUY** (long): AI = 10 and point-in-time Piotroski >= 6 and 12-1 > 0. Monthly. Take the top k by AI score, then by 12-1. Hold 6 months. The readout counts how many AI = 10 names have no point-in-time Piotroski (banks often will not). If that share is more than one third, one extra counted variant replaces Piotroski with Danelfin's fundamental sub-score >= 7.

There is no sell book.

Each buy book is run on U1 and on U2. Within a universe the arms are Danelfin only, AlphaSignal only, and both.

## Report and pass rule

Per arm: trades, win rate, profit factor, total dollar P&L, average win, average loss, max drawdown, each of the four windows, each year, excess versus SPY and versus QQQ (sells: the hedged spread), alpha t on SPY+QQQ, and the executable k = 1, 2, 5 results.

Pass: the combined arm is profitable with PF >= 1.2 in every window that has trades, monthly excess t >= 3, alpha t >= 2, and it beats both other arms on full-sample dollar P&L and on PF, and in at least 3 of the 4 windows. Otherwise apply `docs/incubation-tier.md`.

Trials counted for the deflated Sharpe: 3 buy books × 2 universes × 3 arms × the k variants (the $10k book plus k = 1, 2, 5), plus the L-BUY fundamental-score variant if the missing-Piotroski share is above one third. No arm is dropped after seeing results.

Look-ahead: signals only on dates after Danelfin was publishing. The probe's earliest date is the start. Dates before that are out.

## Live watch cards

From the next US close, one `aiscore=10` call per session, on the live share (60 per month). The stored list is overlaid with the buy rules on U1 and U2. Cards are watch-only: no entry events and no orders. A separate model book marks $10,000 notional from the recorded entry. If the call returns 100 names, the card section shows a cap warning.
