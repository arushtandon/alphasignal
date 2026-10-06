# New strategy types

Pre-registration: docs/new-strategy-types-preregistration.md. Family size 46. No live change.

Non-US stock lists are SURVIVORSHIP_BIAS. Crypto coins with at least three years of cached history are named in the JSON. Part A has no point-in-time EPS estimate file, so those four variants are INSUFFICIENT rather than a scored fail.

| Market | Horizon | Strategy | W1 ret vs bench | W2 | W3 | W4 | PF | Win % | Max DD | Membership | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| US | medium | Post-earnings drift, EPS beat ≥ 5%, hold 40 | — | — | — | — | — | — | — | POINT_IN_TIME | INSUFFICIENT |
| US | medium | Post-earnings drift, EPS beat ≥ 5%, hold 60 | — | — | — | — | — | — | — | POINT_IN_TIME | INSUFFICIENT |
| US | medium | Post-earnings drift, EPS beat ≥ 10%, hold 40 | — | — | — | — | — | — | — | POINT_IN_TIME | INSUFFICIENT |
| US | medium | Post-earnings drift, EPS beat ≥ 10%, hold 60 | — | — | — | — | — | — | — | POINT_IN_TIME | INSUFFICIENT |
| US | long | 12-1 momentum | 6.5% / -2.91% | 10.64% / 18.64% | 0.22% / -2.38% | 22.23% / 16.39% | 2.134 | 57.2 | 21.27 | POINT_IN_TIME | PASS |
| US | long | 12-1 momentum, cash below 200-day MA | 6.5% / -2.91% | -1.24% / 18.64% | 0.04% / -2.38% | 4.75% / 16.39% | 2.606 | 60.4 | 20.75 | POINT_IN_TIME | FAIL |
| US | long | 12-1 momentum among Piotroski ≥ 6 | 7.52% / -2.91% | 13.78% / 18.64% | 3.22% / -2.38% | 20.8% / 16.39% | 2.502 | 59.9 | 22.46 | POINT_IN_TIME | PASS |
| US | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | 7.52% / -2.91% | -1.11% / 18.64% | 3.28% / -2.38% | 2.35% / 16.39% | 3.184 | 63.4 | 16.04 | POINT_IN_TIME | FAIL |
| UK | medium | 12-1 momentum | 4.26% / -0.19% | 15.04% / 11.1% | 15.53% / 8.55% | 1.77% / 0.39% | 1.105 | 51.2 | 32.65 | SURVIVORSHIP_BIAS | CANDIDATE |
| UK | medium | 12-1 momentum, cash below 200-day MA | -8% / -0.19% | 15.04% / 11.1% | 15.53% / 8.55% | 1.77% / 0.39% | 1.143 | 51.3 | 28.29 | SURVIVORSHIP_BIAS | CANDIDATE |
| UK | medium | 12-1 momentum among Piotroski ≥ 6 | 1.48% / -0.19% | 3.62% / 11.1% | 8.64% / 8.55% | 2.58% / 0.39% | 0.853 | 46 | 53.68 | SURVIVORSHIP_BIAS | CANDIDATE |
| UK | medium | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | -5.29% / -0.19% | 3.62% / 11.1% | 8.64% / 8.55% | 2.58% / 0.39% | 0.867 | 45.5 | 39.32 | SURVIVORSHIP_BIAS | FAIL |
| UK | long | 12-1 momentum | 6.89% / -0.19% | 15.63% / 11.1% | 13.18% / 8.55% | 15.11% / 0.39% | 2.013 | 57.8 | 24.74 | SURVIVORSHIP_BIAS | CANDIDATE |
| UK | long | 12-1 momentum, cash below 200-day MA | -5.36% / -0.19% | 13.5% / 11.1% | 13.18% / 8.55% | 15.11% / 0.39% | 2.04 | 59.6 | 22.56 | SURVIVORSHIP_BIAS | CANDIDATE |
| UK | long | 12-1 momentum among Piotroski ≥ 6 | 10.15% / -0.19% | 5.93% / 11.1% | 14.44% / 8.55% | 2.09% / 0.39% | 1.478 | 52.4 | 32.44 | SURVIVORSHIP_BIAS | PASS |
| UK | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | -0.63% / -0.19% | 4.2% / 11.1% | 14.44% / 8.55% | 2.09% / 0.39% | 2.18 | 57.8 | 23.15 | SURVIVORSHIP_BIAS | FAIL |
| France | medium | 12-1 momentum | 5.99% / -1.82% | -4.91% / 10% | 1.46% / -1.25% | 0.62% / -2.85% | 1.032 | 49.5 | 34.19 | SURVIVORSHIP_BIAS | CANDIDATE |
| France | medium | 12-1 momentum, cash below 200-day MA | -2.64% / -1.82% | -4.91% / 10% | 1.46% / -1.25% | -4.99% / -2.85% | 0.948 | 48.4 | 28.64 | SURVIVORSHIP_BIAS | FAIL |
| France | medium | 12-1 momentum among Piotroski ≥ 6 | 1.52% / -1.82% | -9.04% / 10% | -8.52% / -1.25% | -0.53% / -2.85% | 1.004 | 50.7 | 26.38 | SURVIVORSHIP_BIAS | FAIL |
| France | medium | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | -8.91% / -1.82% | -9.04% / 10% | -8.52% / -1.25% | 0.41% / -2.85% | 0.91 | 49.6 | 31.21 | SURVIVORSHIP_BIAS | FAIL |
| France | long | 12-1 momentum | 3.56% / -1.82% | -6.67% / 10% | 7.11% / -1.25% | -0.55% / -2.85% | 1.799 | 59.8 | 24.64 | SURVIVORSHIP_BIAS | CANDIDATE |
| France | long | 12-1 momentum, cash below 200-day MA | -1.7% / -1.82% | -3.37% / 10% | 7.11% / -1.25% | -2.08% / -2.85% | 2.746 | 66.6 | 13.66 | SURVIVORSHIP_BIAS | CANDIDATE |
| France | long | 12-1 momentum among Piotroski ≥ 6 | 5.47% / -1.82% | -8.91% / 10% | -1.2% / -1.25% | 1.74% / -2.85% | 1.226 | 53.7 | 25.61 | SURVIVORSHIP_BIAS | CANDIDATE |
| France | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | -3.83% / -1.82% | -5.01% / 10% | -1.2% / -1.25% | 3.41% / -2.85% | 1.416 | 59.2 | 16.02 | SURVIVORSHIP_BIAS | FAIL |
| Hong Kong | short | Weekly reversal, worst 5 | -23.57% / -3.78% | 23.62% / 22.79% | -29.15% / 7.15% | -1.17% / -4.9% | 0.88 | 45.3 | 90.75 | SURVIVORSHIP_BIAS | FAIL |
| Hong Kong | short | Weekly reversal, worst 5, only above 200-day MA | -19.7% / -3.78% | 9.63% / 22.79% | -29.15% / 7.15% | -7.27% / -4.9% | 0.84 | 44.9 | 67.2 | SURVIVORSHIP_BIAS | FAIL |
| Hong Kong | short | Weekly reversal, worst 10 | -9.99% / -3.78% | 4.55% / 22.79% | -28.36% / 7.15% | -9.96% / -4.9% | 0.853 | 44.8 | 90.5 | SURVIVORSHIP_BIAS | FAIL |
| Hong Kong | short | Weekly reversal, worst 10, only above 200-day MA | -9.13% / -3.78% | -6.89% / 22.79% | -28.36% / 7.15% | -13.71% / -4.9% | 0.814 | 43.6 | 68.54 | SURVIVORSHIP_BIAS | FAIL |
| Commodities | medium | 12-month trend and 200-day MA | 5.92% / 1.08% | -2.92% / -0.71% | 37.42% / 31.29% | 4.59% / 10.38% | 1.603 | 20.5 | 49.32 | NOT_APPLICABLE | FAIL |
| Commodities | long | 12-month trend and 200-day MA | 5.92% / 1.08% | -2.92% / -0.71% | 37.42% / 31.29% | 4.59% / 10.38% | 1.603 | 20.5 | 49.32 | NOT_APPLICABLE | FAIL |
| Commodities | medium | 3-month trend and 200-day MA | 4.54% / 1.08% | -12.87% / -0.71% | 28.92% / 31.29% | -4.22% / 10.38% | 1.073 | 22.3 | 54.95 | NOT_APPLICABLE | FAIL |
| Commodities | long | 3-month trend and 200-day MA | 4.54% / 1.08% | -12.87% / -0.71% | 28.92% / 31.29% | -4.22% / 10.38% | 1.073 | 22.3 | 54.95 | NOT_APPLICABLE | FAIL |
| Commodities | short | 20-day breakout, exit on a 10-day low | 28.85% / 1.08% | 0.83% / -0.71% | 46.05% / 31.29% | 3.74% / 10.38% | 1.129 | 35.9 | 17.61 | NOT_APPLICABLE | CANDIDATE |
| Crypto | medium | 12-month trend and 200-day MA | 38.51% / 5.58% | 6.13% / -21.2% | 39.24% / -19.96% | 95.77% / 28.33% | 5.478 | 20.8 | 52.98 | NOT_APPLICABLE | CANDIDATE |
| Crypto | long | 12-month trend and 200-day MA | 38.51% / 5.58% | 6.13% / -21.2% | 39.24% / -19.96% | 95.77% / 28.33% | 5.478 | 20.8 | 52.98 | NOT_APPLICABLE | CANDIDATE |
| Crypto | medium | 3-month trend and 200-day MA | 29.35% / 5.58% | -10.95% / -21.2% | 90.73% / -19.96% | 33.03% / 28.33% | 3.08 | 25.3 | 51.83 | NOT_APPLICABLE | CANDIDATE |
| Crypto | long | 3-month trend and 200-day MA | 29.35% / 5.58% | -10.95% / -21.2% | 90.73% / -19.96% | 33.03% / 28.33% | 3.08 | 25.3 | 51.83 | NOT_APPLICABLE | CANDIDATE |
| Crypto | short | 20-day breakout, exit on a 10-day low | 27.12% / 5.58% | 65.62% / -21.2% | 44.73% / -19.96% | 55.93% / 28.33% | 2.246 | 38.6 | 23.93 | NOT_APPLICABLE | CANDIDATE |
| UK | short | Weekly reversal, worst 5 | -24.14% / -0.19% | -0.04% / 11.1% | -20.07% / 8.55% | 11.39% / 0.39% | 0.775 | 44.2 | 93.69 | SURVIVORSHIP_BIAS | FAIL |
| UK | short | Weekly reversal, worst 5, only above 200-day MA | -19.16% / -0.19% | -5.95% / 11.1% | -20.07% / 8.55% | 11.39% / 0.39% | 0.636 | 43.2 | 92.89 | SURVIVORSHIP_BIAS | FAIL |
| UK | short | Weekly reversal, worst 10 | -23.64% / -0.19% | -2.55% / 11.1% | -25.33% / 8.55% | 3.36% / 0.39% | 0.734 | 43.7 | 94.73 | SURVIVORSHIP_BIAS | FAIL |
| UK | short | Weekly reversal, worst 10, only above 200-day MA | -21.52% / -0.19% | -7.63% / 11.1% | -25.33% / 8.55% | 3.36% / 0.39% | 0.588 | 41.8 | 94.02 | SURVIVORSHIP_BIAS | FAIL |
| France | short | Weekly reversal, worst 5 | -13.28% / -1.82% | -24.03% / 10% | -22.12% / -1.25% | 9.25% / -2.85% | 0.839 | 48 | 84.93 | SURVIVORSHIP_BIAS | FAIL |
| France | short | Weekly reversal, worst 5, only above 200-day MA | -8.21% / -1.82% | -27.18% / 10% | -16.83% / -1.25% | -0.24% / -2.85% | 0.764 | 46.5 | 78.48 | SURVIVORSHIP_BIAS | FAIL |
| France | short | Weekly reversal, worst 10 | -10% / -1.82% | -12.17% / 10% | -22.47% / -1.25% | 6.7% / -2.85% | 0.857 | 47 | 78.3 | SURVIVORSHIP_BIAS | FAIL |
| France | short | Weekly reversal, worst 10, only above 200-day MA | -3.95% / -1.82% | -16.09% / 10% | -18.25% / -1.25% | -0.68% / -2.85% | 0.769 | 45.5 | 73.84 | SURVIVORSHIP_BIAS | FAIL |

## Amendment 2026-10-06

Pre-registration: docs/new-strategy-types-amendment-2026-10-06.md. No live change.
US membership is point-in-time from 2014-01-23, and US signals start on that date. UK and France are SURVIVORSHIP_BIAS. Price start: US 2010-01-04; UK 2010-01-04; France 2010-01-04.
Yahoo chart events=earnings returned no report dates on 2026-10-06. Report dates are Financial Modeling Prep announcement dates that already have a reported EPS, joined to the cached Yahoo prices. A date that is not a session uses the next session, and only when that session is within five calendar days.
A flat window with no positions does not count as beating the benchmark.
Earnings portfolio returns are the equal-weight average of open positions' daily returns, and a day with no open position earns 0. The prior curve kept only names that were open for a whole month, which dropped stop-outs. The benchmark day is the signal session. FMP has no before-open or after-close flag, so the signal session is the first session on or after the announcement date and entry is one or two sessions after that.

| Market | Horizon | Strategy | Verdict | Full-sample return | Max DD | Worst month | Beat windows |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| US | long | 12-1 momentum | FAIL | 318.99% | 21.27% | 2020-03-31 -14.89% | 2/4 |
| US | long | 12-1 momentum, cash below 200-day MA | FAIL | 101.71% | 20.75% | 2018-10-31 -12.32% | 0/4 |
| US | long | 12-1 momentum among Piotroski ≥ 6 | CANDIDATE | 358.74% | 22.46% | 2020-03-31 -16.06% | 3/4 |
| US | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | 108.3% | 16.04% | 2018-10-31 -10.54% | 1/4 |
| UK | medium | 12-1 momentum | CANDIDATE | 177.93% | 32.65% | 2020-03-31 -24.97% | 3/4 |
| UK | medium | 12-1 momentum, cash below 200-day MA | FAIL | 86.47% | 28.29% | 2026-03-31 -12.09% | 2/4 |
| UK | medium | 12-1 momentum among Piotroski ≥ 6 | FAIL | -28.92% | 53.75% | 2020-03-31 -12.9% | 1/4 |
| UK | medium | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | -24.17% | 40.9% | 2020-02-28 -10.79% | 1/4 |
| UK | long | 12-1 momentum | FAIL | 800.63% | 24.74% | 2020-03-31 -18.37% | 2/4 |
| UK | long | 12-1 momentum, cash below 200-day MA | FAIL | 175.62% | 22.56% | 2026-03-31 -12.96% | 2/4 |
| UK | long | 12-1 momentum among Piotroski ≥ 6 | PASS | 172.83% | 32.44% | 2020-03-31 -13.54% | 4/4 |
| UK | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | 53.43% | 23.15% | 2022-06-30 -8.51% | 2/4 |
| France | medium | 12-1 momentum | FAIL | 69.98% | 34.19% | 2020-03-31 -14.45% | 2/4 |
| France | medium | 12-1 momentum, cash below 200-day MA | FAIL | 7.12% | 30.76% | 2026-03-31 -11.35% | 0/4 |
| France | medium | 12-1 momentum among Piotroski ≥ 6 | FAIL | 34.03% | 29.54% | 2020-03-31 -19.36% | 0/4 |
| France | medium | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | -27.63% | 35.07% | 2024-10-31 -7.99% | 0/4 |
| France | long | 12-1 momentum | CANDIDATE | 371.25% | 24.64% | 2020-03-31 -16.33% | 3/4 |
| France | long | 12-1 momentum, cash below 200-day MA | FAIL | 107.97% | 14.99% | 2026-03-31 -9.71% | 2/4 |
| France | long | 12-1 momentum among Piotroski ≥ 6 | FAIL | 94.78% | 26.24% | 2020-03-31 -19.28% | 1/4 |
| France | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | 8.45% | 18.37% | 2026-03-31 -8.14% | 1/4 |
| US | medium | Earnings reaction, excess ≥ 3%, enter +1 session, hold 40 or 2.5 ATR | FAIL | 193.63% | 26.28% | 2018-12-31 -11.37% | 1/4 |
| US | medium | Earnings reaction, excess ≥ 3%, enter +1 session, hold 60 or 2.5 ATR | FAIL | 257.15% | 24.72% | 2018-12-31 -11.12% | 1/4 |
| US | medium | Earnings reaction, excess ≥ 3%, enter +2 session, hold 40 or 2.5 ATR | FAIL | 136.16% | 26.66% | 2018-12-31 -10.94% | 1/4 |
| US | medium | Earnings reaction, excess ≥ 3%, enter +2 session, hold 60 or 2.5 ATR | FAIL | 241.13% | 24.95% | 2018-12-31 -10.97% | 1/4 |
| US | medium | Earnings reaction, excess ≥ 5%, enter +1 session, hold 40 or 2.5 ATR | FAIL | 142.7% | 41.26% | 2021-01-29 -12.27% | 0/4 |
| US | medium | Earnings reaction, excess ≥ 5%, enter +1 session, hold 60 or 2.5 ATR | FAIL | 286.62% | 30% | 2018-12-31 -10.41% | 1/4 |
| US | medium | Earnings reaction, excess ≥ 5%, enter +2 session, hold 40 or 2.5 ATR | FAIL | 128.9% | 33.25% | 2018-12-31 -10.48% | 0/4 |
| US | medium | Earnings reaction, excess ≥ 5%, enter +2 session, hold 60 or 2.5 ATR | FAIL | 247.82% | 28.61% | 2018-12-31 -10.38% | 0/4 |

### Per year vs benchmark

#### US long — 12-1 momentum among Piotroski ≥ 6

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 10.96% |
| 2011 | 0% | -1.22% |
| 2012 | 0% | 11.69% |
| 2013 | 0% | 26.45% |
| 2014 | -0.34% | 12.37% |
| 2015 | 3.53% | -0.76% |
| 2016 | 5.47% | 11.2% |
| 2017 | 19.77% | 18.48% |
| 2018 | -12.5% | -7.01% |
| 2019 | 19.22% | 28.65% |
| 2020 | 34.55% | 15.09% |
| 2021 | 22.19% | 28.79% |
| 2022 | -1.3% | -19.95% |
| 2023 | 11.21% | 24.81% |
| 2024 | 26.64% | 24% |
| 2025 | 19.6% | 16.64% |
| 2026 | 23.43% | 13.42% |

Median cohort is 21 names. Target $30,000 each, capped at 23 names so the book stays inside the $700,000 paper pool. Long holds six overlapping sleeves. Once a month, replace the oldest sleeve and leave the other five in place. If several of these cells are on together, they share that same gross cap.

#### UK medium — 12-1 momentum

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 5.21% |
| 2011 | -13.59% | -6.7% |
| 2012 | 23.82% | 7.81% |
| 2013 | 46.87% | 14.66% |
| 2014 | 1.7% | -12.56% |
| 2015 | 4.17% | -9.63% |
| 2016 | 23.41% | -3.37% |
| 2017 | 16.68% | 16.26% |
| 2018 | -15.19% | -18.81% |
| 2019 | 23.85% | 16.26% |
| 2020 | -11.49% | -14.23% |
| 2021 | -4.49% | 11.66% |
| 2022 | -12.02% | -8.56% |
| 2023 | 5.8% | 7.41% |
| 2024 | -5.05% | 3.54% |
| 2025 | 55.65% | 30.04% |
| 2026 | -5.08% | 3.89% |

Median cohort is 10 names. Target $30,000 each, capped at 23 names so the book stays inside the $700,000 paper pool. Rebalance once a month: sell names that leave the cohort and buy the new ones. If several of these cells are on together, they share that same gross cap.

#### UK long — 12-1 momentum among Piotroski ≥ 6

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 5.21% |
| 2011 | -6.92% | -6.7% |
| 2012 | 13.8% | 7.81% |
| 2013 | 28.6% | 14.66% |
| 2014 | -2.09% | -12.56% |
| 2015 | 4.52% | -9.63% |
| 2016 | 9% | -3.37% |
| 2017 | 18.24% | 16.26% |
| 2018 | -13.4% | -18.81% |
| 2019 | 11.64% | 16.26% |
| 2020 | -8.83% | -14.23% |
| 2021 | 16.55% | 11.66% |
| 2022 | -6.04% | -8.56% |
| 2023 | 2.98% | 7.41% |
| 2024 | 13.28% | 3.54% |
| 2025 | 26.02% | 30.04% |
| 2026 | 7.03% | 3.89% |

Median cohort is 10 names. Target $30,000 each, capped at 23 names so the book stays inside the $700,000 paper pool. Long holds six overlapping sleeves. Once a month, replace the oldest sleeve and leave the other five in place. If several of these cells are on together, they share that same gross cap.

#### France long — 12-1 momentum

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | -8.67% |
| 2011 | -11.53% | -20.79% |
| 2012 | 29.64% | 17.01% |
| 2013 | 39.95% | 19.94% |
| 2014 | 2.71% | -11.24% |
| 2015 | 22.33% | -1.26% |
| 2016 | 3.95% | 3.57% |
| 2017 | 27.16% | 26.6% |
| 2018 | -4.45% | -15.24% |
| 2019 | 34.12% | 24.42% |
| 2020 | 6.41% | 0.97% |
| 2021 | 31.23% | 15.61% |
| 2022 | -17.05% | -15.55% |
| 2023 | 16.45% | 17.17% |
| 2024 | -1.98% | -7.07% |
| 2025 | 8.89% | 26.59% |
| 2026 | -4.18% | -7.77% |

Median cohort is 10 names. Target $30,000 each, capped at 23 names so the book stays inside the $700,000 paper pool. Long holds six overlapping sleeves. Once a month, replace the oldest sleeve and leave the other five in place. If several of these cells are on together, they share that same gross cap.

### Earnings trade list by exit year

3% excess, enter the next session, hold 40 or a 2.5 ATR stop. Returns are net of the cost model.

| Year | Trades | Avg trade | PF |
| --- | ---: | ---: | ---: |
| 2014 | 152 | 1.66% | 1.81 |
| 2015 | 203 | -1.15% | 0.634 |
| 2016 | 239 | 3.29% | 2.133 |
| 2017 | 203 | 0.59% | 1.248 |
| 2018 | 306 | -1.1% | 0.717 |
| 2019 | 293 | 1.53% | 1.611 |
| 2020 | 298 | 3.2% | 1.817 |
| 2021 | 227 | 1.99% | 1.676 |
| 2022 | 298 | -2.21% | 0.582 |
| 2023 | 316 | -0.4% | 0.903 |
| 2024 | 381 | 1.58% | 1.576 |
| 2025 | 327 | 0.11% | 1.03 |
| 2026 | 348 | -0.11% | 0.975 |

### Portfolio execution for the original PASS and CANDIDATE rows

Paper pool $700,000, ticket $30,000, 23 name slots. Not implemented. Cells that share the pool also share that gross cap.

US long 12-1 momentum passed the original windows and failed the 2010 sample. Its ranked book is the top 10 percent, which is larger than 23 names, so an executable book keeps the strongest 23 at $30,000 and drops the rest. Six overlapping sleeves, replace the oldest sleeve once a month.

UK and France momentum rows that were PASS or CANDIDATE on the original windows and failed this longer sample stay at 10 names, $30,000 each ($300,000). Medium rebalances the whole cohort monthly. Long keeps six sleeves and replaces one sleeve a month. UK and France lists are SURVIVORSHIP_BIAS.

Commodities 20-day breakout is a CANDIDATE on 12 ETFs (GLD, SLV, USO, UNG, DBC, PDBC, GSG, DBA, WEAT, CPER, BNO, COPX). One $30,000 ticket per name that breaks out, so the book is at most $360,000. Orders are the breakout entry and the 10-day-low exit.

Crypto trend and 20-day breakout are CANDIDATE on the 18 coins that had at least three years of prices. One $30,000 ticket per name in trend or in a breakout is at most $540,000, inside the paper pool. Trend is checked once a month against the 200-day average. Breakout orders are the entry and the 10-day-low exit. The medium and long trend rows are the same book scored twice, so only one of them would be run.

## Point-in-time membership 2026-10-06

UK uses the FTSE Russell additions and deletions file through 22 June 2026, with the Wikipedia constituent list after 1 October 2026 as the end set. Replayed membership is 100 names at the end and 104 on 4 January 2010. The four-name gap is unmatched ticker changes, mostly renames and reviews after that file. France uses the public CAC 40 admission and removal archive. Replayed membership is 40 names at both ends. Former members are included when Yahoo has a price history. Piotroski still requires a point-in-time score file, and former members usually do not have one. Revised rule: a pass or a candidate also needs a positive full-sample return above its benchmark. UK medium momentum is negative. France medium momentum is positive and below EWQ. Both are FAIL.

| Market | Horizon | Strategy | PIT verdict | PIT return | PIT max DD | PIT worst month | PIT beat | Prior verdict | Prior return |
| --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | ---: |
| UK | medium | 12-1 momentum | FAIL | -22.59% | 63.67% | 2020-03-31 -21.64% | 3/4  | CANDIDATE | 177.93% |
| UK | medium | 12-1 momentum, cash below 200-day MA | FAIL | -11.03% | 48.01% | 2026-03-31 -12.14% | 2/4  | FAIL | 86.47% |
| UK | medium | 12-1 momentum among Piotroski ≥ 6 | FAIL | -49.04% | 62.77% | 2020-03-31 -12.79% | 2/4  | FAIL | -28.92% |
| UK | medium | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | -37.63% | 49.24% | 2020-02-28 -10.65% | 2/4  | FAIL | -24.17% |
| UK | long | 12-1 momentum | PASS | 230.4% | 22.84% | 2020-03-31 -16.6% | 4/4  | FAIL | 800.63% |
| UK | long | 12-1 momentum, cash below 200-day MA | CANDIDATE | 101.54% | 21.87% | 2026-03-31 -11.69% | 3/4  | FAIL | 175.62% |
| UK | long | 12-1 momentum among Piotroski ≥ 6 | CANDIDATE | 102.29% | 30.49% | 2020-03-31 -13.47% | 4/4  | PASS | 172.83% |
| UK | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | 35.61% | 19.43% | 2022-06-30 -7.64% | 2/4  | FAIL | 53.43% |
| France | medium | 12-1 momentum | FAIL | 54.94% | 31.78% | 2020-03-31 -16.74% | 3/4  | FAIL | 69.98% |
| France | medium | 12-1 momentum, cash below 200-day MA | FAIL | 3.95% | 24.95% | 2026-03-31 -12.04% | 1/4  | FAIL | 7.12% |
| France | medium | 12-1 momentum among Piotroski ≥ 6 | FAIL | 2.29% | 32.77% | 2020-03-31 -18.92% | 0/4  | FAIL | 34.03% |
| France | medium | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | -41.84% | 46.12% | 2015-08-31 -10.61% | 0/4  | FAIL | -27.63% |
| France | long | 12-1 momentum | CANDIDATE | 212.96% | 28.04% | 2020-03-31 -17.49% | 3/4  | CANDIDATE | 371.25% |
| France | long | 12-1 momentum, cash below 200-day MA | FAIL | 61% | 17.57% | 2026-03-31 -10.73% | 2/4  | FAIL | 107.97% |
| France | long | 12-1 momentum among Piotroski ≥ 6 | FAIL | 53.54% | 29.93% | 2020-03-31 -19.35% | 2/4  | FAIL | 94.78% |
| France | long | 12-1 momentum among Piotroski ≥ 6, cash below 200-day MA | FAIL | -3.98% | 17.89% | 2020-02-28 -7.56% | 2/4  | FAIL | 8.45% |

UK prices 131 of 197. France prices 52 of 62.

## Executable momentum 2026-10-06

Point-in-time membership. Each month buy the top k names by 12-1 momentum that are not already held, hold six months, no stops. Empty slots earn 0, so the book return is the sum of open-name returns divided by 6×k. A pass or candidate also needs a positive full-sample return above the benchmark. Not implemented from this run unless a k=1 row passes.

| Market | k | Slots | Verdict | Full sample | Benchmark | Max DD | Worst month | Beat windows |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: |
| UK | 1 | 6 | CANDIDATE | 596.76% | 40.91% | 23.97% | 2011-09-30 -14.84% | 3/4 |
| UK | 2 | 12 | CANDIDATE | 277.05% | 40.91% | 25.13% | 2020-03-31 -15.2% | 3/4 |
| France | 1 | 6 | CANDIDATE | 261.12% | 59.13% | 32.51% | 2020-03-31 -20.41% | 3/4 |
| France | 2 | 12 | FAIL | 156.01% | 59.13% | 32.32% | 2020-03-31 -17.96% | 2/4 |

### Per year vs benchmark

#### UK k=1

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 5.21% |
| 2011 | -2.79% | -6.7% |
| 2012 | 25.74% | 7.81% |
| 2013 | 53.71% | 14.66% |
| 2014 | 4.68% | -12.56% |
| 2015 | 11.27% | -9.63% |
| 2016 | 12.69% | -3.37% |
| 2017 | 22.46% | 16.26% |
| 2018 | -15.56% | -18.81% |
| 2019 | 26.4% | 16.26% |
| 2020 | -1.26% | -14.23% |
| 2021 | -9.03% | 11.66% |
| 2022 | -1.89% | -8.56% |
| 2023 | 14.39% | 7.41% |
| 2024 | 1.69% | 3.54% |
| 2025 | 89.1% | 30.04% |
| 2026 | 11.51% | 3.89% |

#### UK k=2

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | 5.21% |
| 2011 | -7.31% | -6.7% |
| 2012 | 18.39% | 7.81% |
| 2013 | 38.73% | 14.66% |
| 2014 | 5.78% | -12.56% |
| 2015 | 11.06% | -9.63% |
| 2016 | 1.63% | -3.37% |
| 2017 | 16.65% | 16.26% |
| 2018 | -16.71% | -18.81% |
| 2019 | 19.18% | 16.26% |
| 2020 | 2.28% | -14.23% |
| 2021 | -3.82% | 11.66% |
| 2022 | -12.64% | -8.56% |
| 2023 | 9.62% | 7.41% |
| 2024 | 4.75% | 3.54% |
| 2025 | 63.38% | 30.04% |
| 2026 | 11.11% | 3.89% |

#### France k=1

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | -8.67% |
| 2011 | -26.35% | -20.79% |
| 2012 | 35.38% | 17.01% |
| 2013 | 27.19% | 19.94% |
| 2014 | 5.02% | -11.24% |
| 2015 | 27.47% | -1.26% |
| 2016 | -8.71% | 3.57% |
| 2017 | 19.74% | 26.6% |
| 2018 | -2.59% | -15.24% |
| 2019 | 36.7% | 24.42% |
| 2020 | -2.06% | 0.97% |
| 2021 | 28.47% | 15.61% |
| 2022 | -21.82% | -15.55% |
| 2023 | 5.58% | 17.17% |
| 2024 | 3.21% | -7.07% |
| 2025 | 18.19% | 26.59% |
| 2026 | 15.34% | -7.77% |

#### France k=2

| Year | Strategy | Benchmark |
| --- | ---: | ---: |
| 2010 | 0% | -8.67% |
| 2011 | -27.53% | -20.79% |
| 2012 | 23.51% | 17.01% |
| 2013 | 30.6% | 19.94% |
| 2014 | -1.36% | -11.24% |
| 2015 | 15.3% | -1.26% |
| 2016 | -3.32% | 3.57% |
| 2017 | 17.96% | 26.6% |
| 2018 | -8.51% | -15.24% |
| 2019 | 24.12% | 24.42% |
| 2020 | 2.79% | 0.97% |
| 2021 | 28.01% | 15.61% |
| 2022 | -17.14% | -15.55% |
| 2023 | 14.72% | 17.17% |
| 2024 | -5.82% | -7.07% |
| 2025 | 13.87% | 26.59% |
| 2026 | 10.83% | -7.77% |

