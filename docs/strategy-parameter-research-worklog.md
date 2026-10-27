# Strategy parameter research worklog

Date: 25 September 2026

This document records the recommendation rules that are live today, the extra parameters tested by geography and time horizon, the measured win rate and net PnL, and why none of those tests was promoted into the live book.

Live recommendation and execution rules were not changed by these studies. Medium-sell and long-sell recommendations remain paused.

PnL in every table is net of costs at a fixed $10,000 notional per trade. It is a research sum, not a shared-capital portfolio result. Win rate is the percentage of those trades with a positive net return.

## 1. What is live today

The same technical scoring engine runs in every geography. Geography changes the quality overlay, the minimum reward-to-risk, and a few entry gates. Time horizon changes Supertrend settings, score mix, and take-profit / stop-loss distance.

### 1.1 Shared decision gates

| Gate | Live value |
| --- | --- |
| Minimum buy or sell score | 62 |
| Strong Buy score | 78 |
| Strong Sell score | 74 |
| Minimum confidence (`winRateHint`) | 62% |
| Minimum reward / risk | 1.1 |
| Plain Sell | Off. Only Strong Sell is eligible unless sells are explicitly enabled |
| Medium sell and long sell | Paused. `sell:medium` and `sell:long` are disabled |
| Entry | Next open after the signal bar |
| Exit | Current hybrid exit. Stops are checked before targets on the same bar |
| Overlap | A symbol cannot open a new trade in the same setup until the prior trade has exited |

### 1.2 Supertrend by horizon

These are the daily Supertrend settings inside the live scorer:

| Horizon | Period | Multiplier |
| --- | --- | --- |
| Short | 7 | 2 |
| Medium | 10 | 3 |
| Long | 14 | 4 |

US and UK short buys have one extra confirmation on top of that: Supertrend 10,3 plus momentum, daily high/low/close state, and structural support/resistance. A US/UK short buy is not published without that confirmation.

### 1.3 Score mix by horizon

Equities use this mix. Commodities do not: they are technical only, and their buy and sell scores are multiplied by 0.85.

| Horizon | Intended hold | Technical | FMP quality | Fundamentals |
| --- | --- | --- | --- | --- |
| Short | 1 day to 1 month | 75% | 15% | 10% |
| Medium | 1 to 3 months | 50% | 30% | 20% |
| Long | 4 to 12 months | 35% | 30% | 35% |

The technical score already includes moving averages (20, 50, 200), RSI and RSI2, stochastic, Bollinger position, ADX, MACD, OBV, support and resistance, the standard-deviation channel, volume, market regime, weekly trend, and the horizon Supertrend. Structural caps then block or reduce buys that are falling knives, already extended above the 200-day average, short-term buys below both the 20-day and 50-day averages, or medium buys fighting a downtrend below the 50-day average.

### 1.4 Take-profit and stop-loss by horizon

Distances are in ATR. The same distances are used for every geography.

| Horizon | Stop | First target | Second target |
| --- | --- | --- | --- |
| Short | 2 ATR | 3 ATR | 5 ATR |
| Medium | 3 ATR | 5 ATR | 8.5 ATR |
| Long | 5 ATR | 10 ATR | 17 ATR |

Sells use the same distances in the opposite direction. If ATR is unavailable, percentage fallbacks are 4% / 5.5% / 8.5% for short, 7.5% / 11.5% / 18.5% for medium, and 13.5% / 23.5% / 39.5% for long.

### 1.5 What changes by geography

| Geography | Live quality treatment | Extra entry rule |
| --- | --- | --- |
| US | Technical + FMP + fundamentals. Missing FMP forces Hold | Strong Buy or Strong Sell required, except a short buy that passes the 10,3 multi-timeframe confirmation. Minimum reward/risk is 1.4 |
| UK | Same as US | Same as US |
| Hong Kong | Technical + FMP + fundamentals | No US/UK strong-only gate. Minimum reward/risk stays 1.1 |
| Japan | Technical + FMP + fundamentals | Same as Hong Kong |
| Germany | Technical + FMP + fundamentals | Same as Hong Kong |
| France | Technical + FMP + fundamentals | Same as Hong Kong |
| Commodities | Technical only. Scores cut by 15% | No fundamental or FMP score. Minimum reward/risk stays 1.1 |

Benchmarks used when a study needed a market tide: SPY for the US, EWH for Hong Kong, EWJ for Japan, EWU for the UK, EWG for Germany, EWQ for France, and DBC for commodities.

## 2. How a test was allowed to pass

Later studies used the same promotion bar:

- Win rate and net PnL both had to beat the baseline being tested.
- Profit factor at least 1.3.
- Positive net PnL.
- At least 30 development trades and 30 untouched holdout trades.
- The result had to hold in more than one development fold.
- The final holdout could not be used to choose the model.
- A result also had to survive a multiple-testing check across all 42 cells (7 geographies × 3 horizons × buy and sell).

The 65–70% win-rate figure was a target, not a reason to relax those rules after seeing the numbers.

## 3. Research wave 1: multi-timeframe Supertrend, structure, Fibonacci, momentum

Run: 22 September 2026. Universe: 80 US and 80 UK names. This was layered on the production signal path, but with research score settings, so it is not the later exact production replay.

Frames:

- Short: 8-hour cash session and 1 day.
- Medium: 1 day and 3 day.
- Long: 3 day and 1 week.

Added parameters, all causal:

- Supertrend 10,3 on both frames.
- Support and resistance from the last 40 bars of each frame.
- Fibonacci 23.6%, 38.2%, 50%, 61.8% and 78.6%, used only as support and resistance.
- 5-bar and 20-bar momentum, acceleration, and slope.
- Daily high, low, close position, higher-high/higher-low or lower-high/lower-low, and a 5-day break.

US and UK were pooled:

| Horizon | Side | Baseline trades | Baseline win % | Baseline PnL | Overlay trades | Overlay win % | Overlay PnL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Short | Buy | 51 | 47.1 | -$4,609 | 14 | 57.1 | +$474 |
| Short | Sell | 10 | 60.0 | +$1,055 | 3 | 66.7 | +$743 |
| Medium | Buy | 96 | 57.3 | +$6,127 | 79 | 54.4 | -$713 |
| Medium | Sell | 13 | 30.8 | -$265 | 32 | 21.9 | -$6,282 |
| Long | Buy | 11 | 36.3 | +$1,992 | 19 | 26.3 | -$8,042 |
| Long | Sell | 8 | 25.0 | -$8,067 | 12 | 33.3 | -$7,677 |

Why it failed:

- Short buy improved both win rate and PnL, but 14 trades is too small to promote.
- Short sell also looked better and made money, but only 3 overlay trades.
- Medium buy, the largest and already profitable cell, got worse on both win rate and PnL.
- Medium sell and both long sides stayed well below 65% and lost money.
- No cell met the sample, profit-factor, and stability bar at the same time.

## 4. Research wave 2: Supertrend period and multiplier grid

Run: 22 September 2026. Same US and UK universes. Scope was only medium sell, long buy, and long sell. The original short-buy and medium-buy logic was left alone.

Parameters tested on both frames: 14,4; 14,3; 13,4; 13,3; 12,4; 12,3; 11,4; 11,3; 10,4. Results below pool US and UK.

| Setting | Cell | Trades | Win % | PnL |
| --- | --- | --- | --- | --- |
| Original baseline | Medium sell | 13 | 30.8 | -$265 |
| Original baseline | Long buy | 11 | 36.3 | +$1,992 |
| Original baseline | Long sell | 8 | 25.0 | -$8,067 |
| Best long buy, 13,4 or 14,4 | Long buy | 19 | 31.6 | -$5,903 |
| Best medium sell, 10,4 / 11,4 / 12,4 / 13,4 / 14,4 | Medium sell | 33 | 24.3 | -$6,059 |
| Best long sell, 11,3 / 12,3 / 13,3 / 14,3 | Long sell | 12 | 33.3 | -$7,677 |

Every other grid point was similar or worse. Win rates sat between about 20% and 33%, and every grid point lost money.

Why it failed: changing the Supertrend period and multiplier did not repair medium sells, long buys, or long sells. The original long-buy baseline was the least bad long-buy result, and even that was 36.3% with a small sample. These three cells were left paused or unchanged. Medium sell and long sell were later paused in production because both win rate and PnL were poor.

## 5. Research wave 3: relative strength, Donchian, failed retest, and long momentum

Run: 23 September 2026. Universe loaded: US 80, Hong Kong 77, Japan 80, UK 80, Germany 38, France 39, commodities 10. Ten years of daily prices. Walk-forward: 504 training bars and 126 out-of-sample bars. This study used a simplified breakout baseline, not the live scorer. Its win rates are not the live book's win rates.

Factors:

1. Relative strength versus the market and sector over 20, 60 and 120 bars.
2. Donchian breakdown or breakout plus ATR and volume expansion.
3. Failed retest of the 200-day average, rather than merely trading below it.
4. Medium sells only when the stock, sector, and index were bearish together.
5. Long buys using 6–12 month momentum, weekly trend, and 52-week-high proximity.
6. Point-in-time earnings-revision momentum. Not run: no historical analyst-estimate feed exists, and current estimates would leak the future into the past.
7. Walk-forward selection with US and non-US separation.
8. MAE/MFE measurement to test tighter stops, targets, and time exits.

Twelve models were frozen before the run: baseline, each factor alone, and the predeclared combinations of those factors.

The walk-forward selected out-of-sample results were:

| Geography | Horizon | Side | Trades | Win % | Profit factor | PnL |
| --- | --- | --- | --- | --- | --- | --- |
| US | Short | Buy | 193 | 34.7 | 1.28 | +$16,502 |
| US | Short | Sell | 367 | 25.3 | 0.48 | -$58,193 |
| US | Medium | Buy | 226 | 32.7 | 1.45 | +$36,893 |
| US | Medium | Sell | 125 | 20.8 | 0.38 | -$38,756 |
| US | Long | Buy | 264 | 43.2 | 2.55 | +$161,142 |
| US | Long | Sell | 171 | 19.9 | 0.65 | -$17,352 |
| Hong Kong | Short | Buy | 155 | 33.5 | 0.80 | -$10,173 |
| Hong Kong | Short | Sell | 374 | 35.8 | 0.79 | -$24,399 |
| Hong Kong | Medium | Buy | 177 | 35.0 | 1.00 | -$120 |
| Hong Kong | Medium | Sell | 125 | 32.0 | 0.59 | -$23,156 |
| Hong Kong | Long | Buy | 370 | 32.4 | 1.17 | +$32,695 |
| Hong Kong | Long | Sell | 132 | 15.9 | 0.48 | -$17,805 |
| Japan | Short | Buy | 269 | 32.3 | 0.99 | -$1,133 |
| Japan | Short | Sell | 398 | 25.1 | 0.35 | -$104,714 |
| Japan | Medium | Buy | 187 | 33.7 | 1.25 | +$20,211 |
| Japan | Medium | Sell | 77 | 26.0 | 0.27 | -$27,461 |
| Japan | Long | Buy | 103 | 47.6 | 3.05 | +$108,521 |
| Japan | Long | Sell | 304 | 16.8 | 0.22 | -$90,313 |
| UK | Short | Buy | 140 | 33.6 | 0.78 | -$8,116 |
| UK | Short | Sell | 261 | 28.4 | 0.40 | -$59,322 |
| UK | Medium | Buy | 152 | 27.0 | 0.44 | -$30,509 |
| UK | Medium | Sell | 55 | 27.3 | 0.47 | -$14,984 |
| UK | Long | Buy | 346 | 37.9 | 1.15 | +$19,551 |
| UK | Long | Sell | 143 | 16.1 | 0.37 | -$29,098 |
| Germany | Short | Buy | 132 | 22.7 | 0.43 | -$22,036 |
| Germany | Short | Sell | 192 | 29.7 | 0.46 | -$35,515 |
| Germany | Medium | Buy | 25 | 28.0 | 0.74 | -$1,718 |
| Germany | Medium | Sell | 68 | 25.0 | 0.30 | -$21,697 |
| Germany | Long | Buy | 22 | 27.3 | 0.88 | -$1,125 |
| Germany | Long | Sell | 138 | 15.9 | 0.33 | -$24,401 |
| France | Short | Buy | 48 | 37.5 | 0.86 | -$1,667 |
| France | Short | Sell | 183 | 30.6 | 0.63 | -$22,974 |
| France | Medium | Buy | 26 | 42.3 | 1.47 | +$3,598 |
| France | Medium | Sell | 0 | — | — | $0 |
| France | Long | Buy | 26 | 46.2 | 2.78 | +$13,840 |
| France | Long | Sell | 70 | 28.6 | 0.99 | -$160 |
| Commodities | Short | Buy | 70 | 40.0 | 1.40 | +$7,748 |
| Commodities | Short | Sell | 46 | 34.8 | 1.06 | +$905 |
| Commodities | Medium | Buy | 27 | 59.3 | 2.06 | +$8,791 |
| Commodities | Medium | Sell | 12 | 16.7 | 0.45 | -$3,606 |
| Commodities | Long | Buy | 56 | 35.7 | 2.05 | +$23,467 |
| Commodities | Long | Sell | 12 | 33.3 | 0.70 | -$1,048 |

A separate pooled model table, which is diagnostic and was not allowed to pick the live model, found a few cells where one factor beat that simplified baseline on both win rate and PnL:

- Japan medium buy: relative strength, 36.8% and +$32,861 versus 35.1% and +$29,594.
- France medium buy: relative strength plus Donchian, 42.3% and +$3,598 versus 28.2% and -$2,636.
- France long buy: same combination, 46.2% and +$13,840 versus 29.7% and +$9,911.
- Germany long buy: relative strength, 35.8% and +$23,317 versus 29.4% and +$18,358.
- Commodities medium buy: relative strength, 64.0% and +$9,062 versus 54.5% and +$8,626.
- UK medium sell and France long sell also printed a dual improvement, but on 2 and 3 trades.

Why it failed:

- Even the best buy cells stayed under the 65% target, except commodities medium buy at 64% on 25 trades.
- Sells lost money in almost every geography. Triple-bearish and failed-MA200 filters reduced losses in places but did not create a stable short book.
- Earnings revision could not be tested without historical estimates.
- MAE/MFE was measured and used to try calibrated exits. Those exits changed trade counts and win rate, but they were not stable enough to replace the live brackets.
- This baseline was a research breakout, so a good cell here would still have needed a replay on the live scorer before any rule change.

## 6. Research wave 4: ten advanced filters on the simplified baseline

Run: 24 September 2026, 05:28 UTC. Universe: US 80, Hong Kong, Japan 80, UK 80, Germany, France, commodities 10, subject to a 1,800-bar history requirement. Four folds, 504 / 126 / 126 bars, with an embargo of 20, 63, or 180 bars by horizon. Again, this was not the live scorer.

Frozen factors:

1. Trailing win-rate expectancy, using only trades already closed, shrunk with a hierarchical Bayesian prior.
2. Cross-sectional relative-strength percentile. Top or bottom 10%, 15%, and 20%.
3. Breadth: share of names above the 50-day and 200-day averages.
4. ADX and ATR-percentile regime, to separate trend from chop.
5. Breakout retest, instead of buying or selling the first breakout close.
6. Maximum distance from the 20-day and 50-day averages, to avoid late entries.
7. Gap, dollar-volume, and high-low spread proxy.
8. Separate model choice for every geography, horizon, and side.
9. Commodity proxies only: Brent versus WTI, CL versus USO, BZ versus BNO, DBC trend, volume shock, and Wednesday inventory-calendar risk. Not real inventory surprises and not a verified futures curve.
10. Bayesian shrinkage so a small sample cannot look artificially strong.

Twenty-six candidates: the baseline, ten single filters, and fifteen combinations, each with tight, balanced, or wide exits.

Result: 0 of 42 cells passed.

Most cells stayed on the plain baseline because no filter cleared validation. Where a filter won the development vote, the holdout did not support it:

| Cell | Chosen model | Baseline holdout | Challenger holdout | Why it failed |
| --- | --- | --- | --- | --- |
| US long buy | Breadth | 290 trades, 68.3%, +$63,003, PF 1.70 | 254 trades, 64.2%, +$30,641, PF 1.33 | Win rate fell below 65% and PnL was cut in half |
| Hong Kong medium sell | Retest | 68 trades, 73.5%, +$4,879, PF 1.35 | 40 trades, 65.0%, -$2,708, PF 0.77 | Holdout turned from profit to loss |
| UK long buy | Distance plus execution, as a standalone mean-reversion entry | 249 trades, 58.2%, -$15,280 | 21 trades, 66.7%, +$1,999 | Holdout sample below 30, and development was still weak |
| Germany long buy | MA distance, wide exit | 74 trades, 62.2%, +$6,077, PF 1.36 | 34 trades, 47.1%, +$2,294, PF 1.16 | Both win rate and PnL worsened |
| France short buy | Breadth, ADX, execution, tight exit | 104 trades, 54.8%, -$7,287 | 22 trades, 54.5%, -$1,064 | Still a loss, and too few holdout trades |

The repeated failure reasons were win rate below 65%, profit factor below 1.3, negative PnL, fewer than 30 holdout trades, a result that appeared in only one fold, or a win rate that did not survive the multiple-testing check. Sells were negative across the US, Hong Kong, Japan, the UK, Germany, and France.

## 7. Research wave 5: require both a higher win rate and higher PnL

Run: 24 September 2026, 07:37 UTC. Same 26 models, same exits, same folds. The new rule was that a challenger could be selected only when validation win rate and validation PnL were both strictly better than the baseline.

Result: 0 of 42 cells passed. Thirty-six cells kept the baseline because nothing beat it on both measures. Six cells selected something else and then failed the untouched holdout:

| Cell | Chosen model | What happened out of sample |
| --- | --- | --- |
| US long buy | Breadth | 68.3% and +$63,003 became 64.2% and +$30,641 |
| Hong Kong medium sell | Retest | 72.1% and +$4,738 became 60.0% and -$2,900 |
| UK medium buy | RS, ADX, MA distance, execution, tight exit | 50.0% and -$11,290 became 31.6% and -$5,560 on 19 trades |
| Germany long buy | Baseline with a wide exit | 68.2% and +$6,894 became 47.5% and +$4,014 |
| France long buy | Retest, tight exit | 53.0% and -$4,975 became 60.0% and -$1,420; still a loss |
| France long sell | RS, ADX, MA distance, execution | 54.9% and -$6,290 became 47.8% and -$7,415 |

Why it failed: filters that looked better in one validation window did not improve both objectives in the final window. Raising the win rate kept deleting profitable trades or shrinking the sample below 30. This is the study that showed a geography-specific model search, by itself, does not create a 65–70% book.

## 8. Research wave 6: the same factors on the actual production rules

Run: 24 September 2026, 11:29 UTC. This is the study that matches the live book.

It replayed `computeQuantSignal`, the live Supertrend, the live score and confidence gates, reward-to-risk, the US/UK short-buy confirmation, the live ATR brackets, the hybrid exit, next-open entry, stop-first fills, and costs. Current fundamentals were not copied backward. Historical FMP snapshots do not exist, so that live quality boost could not be reconstructed; the report states that limitation.

Universe with at least 1,500 daily bars: US 80, Hong Kong 67, Japan 80, UK 80, Germany 38, France 39, commodities 10.

Overlays tested on top of a production-eligible signal:

- Multi-timeframe Supertrend, 40-bar structure, Fibonacci support and resistance, momentum, and daily high/low/close. Horizon Supertrend matched live settings: short 7,2; medium 10,3; long 14,4.
- Relative strength at the top or bottom 10%, 15%, and 20%.
- Market and sector alignment, and breadth.
- ADX and volatility regime.
- Breakout retest and maximum MA20/MA50 extension.
- Gap, liquidity, and spread.
- Trailing shrunk expectancy.
- Commodity price, ETF, and calendar proxies on commodities only.

Twenty-four candidates, from each filter alone through compact combinations such as confirmation-core, retest-quality, expectancy-quality, and commodity-regime. Exits stayed on the live brackets so a difference could only come from the entry filter.

Result: 0 of 42 cells passed. Holdout counts are small because the live gates reject most bars. That is expected: the live book is selective, and this replay cannot invent historical FMP scores.

| Geography | Horizon | Side | Baseline holdout | Best attempted overlay | Overlay holdout | Failure |
| --- | --- | --- | --- | --- | --- | --- |
| US | Short | Buy | 0 trades | None beat validation | 0 | No eligible production trades in the holdout window |
| US | Short | Sell | 0 | None | 0 | Same |
| US | Medium | Buy | 1 trade, 100%, +$216 | ADX regime | Same 1 trade | One trade cannot prove an improvement |
| US | Medium | Sell | 0 | None | 0 | No sample |
| US | Long | Buy | 0 | None | 0 | No sample |
| US | Long | Sell | 0 | None | 0 | No sample |
| Hong Kong | Short | Buy | 1 trade, 0%, -$531 | Execution | Same trade | No improvement |
| Hong Kong | Short | Sell | 0 | None | 0 | No sample |
| Hong Kong | Medium | Buy | 4 trades, 25%, -$604 | Alignment | 3 trades, 0%, -$606 | Both worse |
| Hong Kong | Medium | Sell | 12 trades, 50%, +$1,303, PF 1.52 | Expectancy + top/bottom 20% RS | 5 trades, 80%, +$1,750, PF 4.16 | Holdout improved, but development was 6 trades, 0%, -$3,302. Too small and unstable |
| Hong Kong | Long | Buy | 3 trades, 33%, -$2,155 | Alignment | Same 3 trades | No improvement |
| Hong Kong | Long | Sell | 1 trade, 0%, -$3,809 | None | Same trade | No improvement |
| Japan | Short | Buy | 9 trades, 88.9%, +$3,889 | Alignment | 2 trades, 100%, +$636 | Win rate rose and PnL fell by about $3,250 |
| Japan | Short | Sell | 0 | None | 0 | No sample |
| Japan | Medium | Buy | 15 trades, 26.7%, -$2,756 | ADX regime | 8 trades, 25%, -$1,390 | Still a loss; win rate did not rise |
| Japan | Medium | Sell | 2 trades, 50%, -$79 | ADX regime | 1 trade, 0%, -$94 | Both worse |
| Japan | Long | Buy | 4 trades, 25%, -$1,124 | Alignment + breadth + ADX | 0 trades | Filter removed the sample |
| Japan | Long | Sell | 0 | None | 0 | No sample |
| UK | Short | Buy and sell | 0 | None | 0 | Live US/UK gates left no holdout trades |
| UK | Medium | Buy | 1 trade, 0%, -$1,059 | None | Same | No improvement |
| UK | Medium | Sell | 1 trade, 0%, -$112 | None | Same | No improvement |
| UK | Long | Buy and sell | 0 | None | 0 | No sample |
| Germany | Short | Buy | 4 trades, 50%, +$18, PF 1.02 | None | Same | Profit factor below 1.3 and no better overlay |
| Germany | Medium | Buy | 5 trades, 0%, -$1,855 | None | Same | All losses |
| Germany | Medium | Sell | 5 trades, 20%, -$1,198 | None | Same | All but one were losses |
| Germany | Long | Buy | 1 trade, 0%, -$415 | ADX regime | Same trade | No improvement |
| France | Short | Buy | 3 trades, 100%, +$1,264 | ADX regime | 2 trades, 100%, +$627 | Win rate unchanged and PnL fell |
| France | Medium | Buy | 2 trades, 50%, +$92 | Alignment | 0 trades | Filter deleted the winners |
| France | Medium | Sell | 6 trades, 33%, -$717 | Alignment | 4 trades, 25%, -$180 | Win rate fell; still a loss |
| France | Long | Sell | 1 trade, 0%, -$629 | None | Same | No improvement |
| Commodities | Medium | Buy | 1 trade, 0%, -$41 | None | Same | No improvement |
| Commodities | Medium | Sell | 4 trades, 0%, -$1,975 | None | Same | All losses |
| Commodities | Other cells | — | 0 | None | 0 | No eligible holdout trades |

Why this wave failed:

- No overlay beat the live baseline on both win rate and PnL in development and in the untouched holdout.
- The one attractive holdout, Hong Kong medium sell at 80% and +$1,750, was the opposite of its development record. That is a small-sample reversal, not a strategy.
- Japan short buy is the clean example of the trade-off: alignment made the win rate 100% and cut the profit from $3,889 to $636.
- US and UK samples collapsed because the live Strong rating, confidence, reward-to-risk, and short-buy confirmation gates are strict, and historical FMP quality could not be replayed. An empty cell cannot be called an improvement.
- Profit factor, 30-trade minimums, fold stability, and multiple-testing control rejected every remaining candidate.

## 9. Why the whole search failed

The studies did not fail because one factor was forgotten. They failed for four repeated reasons.

1. A higher win rate usually came from taking fewer trades, and those omitted trades were often the profitable ones. PnL then fell. The promotion rule required both.
2. Medium sells and long sells lost money across Supertrend settings, relative strength, triple-bearish alignment, failed 200-day retests, Donchian breakdowns, and the later regime filters. Pausing them was consistent with the evidence.
3. The earlier 65–70% figures came from simplified research entries or from very small windows. When the same factors were forced through the live score, Supertrend, confidence, reward-to-risk, and exit, the eligible sample became too small to support a new rule.
4. Two important datasets were never available: point-in-time earnings revisions and analyst estimates, and real commodity inventory or a verified futures curve. Price and calendar proxies were tested. They were not a substitute.

## 10. What remains in force

- Keep the current scoring, Supertrend, confidence, reward-to-risk, and hybrid exit.
- Keep medium-sell and long-sell recommendations paused.
- Do not add relative strength, breadth, ADX, retest, MA-distance, execution, expectancy, Fibonacci, or commodity-proxy filters to the live recommendation. None cleared the bar on the production replay.
- US and UK short buys continue to require the existing 10,3 multi-timeframe confirmation. That confirmation was already live; the broader overlay did not earn an extension to other horizons.
- A future test needs historical FMP or earnings-revision snapshots before US and UK cells can be judged on a full sample. Until that data exists, another price-only filter search will keep failing the sample test.

## 11. Source files

- Live decision gates: `lib/strategy/decision-engine.js`
- Live geography gates: `lib/strategy/market-tier.js`
- Paused brackets: `lib/strategy/bracket-policy.js`
- Horizon mix: `lib/strategy/horizon-blend.js`
- Live Supertrend and scoring: `server.js`
- Wave 1 results: `scripts/mtf-supertrend-sr-fib-comparison-results.json`
- Wave 2 results: `scripts/mtf-supertrend-parameter-grid-results.json`
- Wave 3 results: `scripts/backtest-factor-combinations-results.json`
- Wave 4 results: `scripts/backtest-advanced-factor-results.json`
- Wave 5 results: `scripts/backtest-geography-side-results.json`
- Wave 6 results: `scripts/backtest-production-factor-overlays-results.json`
- Frozen research designs: `docs/factor-walk-forward-preregistration.md` and `docs/geography-side-dual-improvement-preregistration.md`
