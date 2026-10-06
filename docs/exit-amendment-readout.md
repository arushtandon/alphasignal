# Exit amendment replay

Pre-registration: docs/exit-amendment-preregistration.md

Baseline is the tested exit. Amended removes time and signal exits and applies the one-lot ratchet only to single-lot positions.

## JAPAN_MEDIUM_MR — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 58 | 79.3 | 1.47 | 3589.46 | 58 | 81 | 1.502 | 3817.02 | 2.429 / -6.906 | 0 | 2/14/34 | 10/5 |
| 2 | 196 | 74.5 | 1.188 | 4503.6 | 196 | 74 | 1.156 | 3932.79 | 2.005 / -4.929 | 0 | 4/13/35 | 42/5 |
| 3 | 237 | 85.2 | 2.346 | 30230.62 | 237 | 84 | 2.403 | 33728.42 | 2.903 / -6.327 | 0 | 3/12/37 | 56/5 |
| 4 | 200 | 75.5 | 1.851 | 23969.64 | 170 | 82.9 | 2.238 | 29022.91 | 3.721 / -8.085 | 30 | 3/13/65 | 38/5 |

## JAPAN_SHORT_MR — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 59 | 66.1 | 1.222 | 1651.92 | 59 | 81.4 | 1.501 | 3808.44 | 2.376 / -6.906 | 0 | 3/15/35 | 12/3 |
| 2 | 222 | 57.2 | 1 | -2.68 | 222 | 74.3 | 1.171 | 4879.84 | 2.029 / -5.018 | 0 | 5/17/36 | 56/3 |
| 3 | 245 | 71.4 | 1.665 | 18369.65 | 245 | 84.5 | 2.829 | 44070.02 | 3.293 / -6.34 | 0 | 5/17/37 | 62/3 |
| 4 | 211 | 62.1 | 1.464 | 14097.75 | 171 | 81.3 | 2.357 | 34611.54 | 4.325 / -7.972 | 40 | 5/14/65 | 45/3 |

## COMMODITIES_MEDIUM_MR — KEEP TESTED EXITS

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 10 | 70 | 1.954 | 915.12 | 10 | 70 | 2.14 | 1094.41 | 2.934 / -3.199 | 0 | 4/8/8 | 4/3 |
| 2 | 9 | 77.8 | 1.08 | 99.65 | 9 | 66.7 | 0.914 | -107.8 | 1.92 / -4.198 | 0 | 6/20/20 | 3/3 |
| 3 | 19 | 78.9 | 3.764 | 3510.27 | 19 | 73.7 | 3.961 | 3944.18 | 3.769 / -2.664 | 0 | 4/17/19 | 7/3 |
| 4 | 26 | 84.6 | 2.048 | 2588.94 | 24 | 83.3 | 2.512 | 3715.33 | 3.086 / -6.144 | 2 | 6/22/28 | 8/3 |

## US_SHORT_MR — KEEP TESTED EXITS

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 795 | 52.5 | 0.661 | -36262.55 | 795 | 55 | 0.481 | -86189.38 | 1.828 / -4.639 | 0 | 5/13/47 | 203/2 |
| 2 | 342 | 64.9 | 1.298 | 9065.34 | 342 | 75.1 | 1.417 | 16981.99 | 2.247 / -4.796 | 0 | 6/15/51 | 46/2 |
| 3 | 743 | 64.7 | 1.337 | 29712.48 | 741 | 74.6 | 1.4 | 42493.39 | 2.688 / -5.646 | 2 | 4/12/43 | 122/2 |
| 4 | 675 | 58.8 | 1.246 | 21105.57 | 610 | 67 | 1.027 | 3030.83 | 2.87 / -5.69 | 65 | 5/13/32 | 105/2 |

## Japan|long — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 13 | 23.1 | 0.556 | -5119.35 | 13 | 53.8 | 1.64 | 6454.79 | 23.638 / -16.82 | 0 | 72/246/283 | 11/3 |
| 2 | 9 | 66.7 | 5.133 | 9649.29 | 9 | 77.8 | 8.577 | 15195.27 | 24.572 / -10.027 | 0 | 113/190/190 | 8/3 |
| 3 | 14 | 50 | 1.797 | 5795.22 | 12 | 66.7 | 2.516 | 8305.64 | 17.231 / -13.697 | 2 | 39/73/193 | 9/3 |
| 4 | 6 | 16.7 | 0.786 | -944.59 | 2 | 50 | 1.752 | 1486.44 | 34.628 / -19.764 | 4 | 53/57/57 | 2/3 |

## Hong Kong|medium — KEEP TESTED EXITS

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 12 | 33.3 | 0.508 | -1018.65 | 12 | 50 | 1.355 | 2850.29 | 18.147 / -13.397 | 0 | 41/179/214 | 10/3 |
| 2 | 8 | 50 | 2.506 | 2107.87 | 8 | 50 | 2.129 | 5216.51 | 24.593 / -11.552 | 0 | 33/248/248 | 5/3 |
| 3 | 2 | 50 | 0.46 | -156.3 | 2 | 50 | 1.013 | 11.49 | 8.644 / -8.529 | 0 | 12/30/30 | 1/3 |
| 4 | 4 | 75 | 8.482 | 827.27 | 3 | 0 | 0 | -2830.55 | null / -9.435 | 1 | 30/31/31 | 2/3 |

## Hong Kong|long — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 1 | 0 | 0 | -851.62 | 1 | 0 | 0 | -1254.98 | null / -12.55 | 0 | 34/34/34 | 1/3 |
| 2 | 5 | 80 | 14.015 | 7910.42 | 5 | 100 | 99 | 10204.32 | 20.409 / null | 0 | 150/175/175 | 5/3 |
| 3 | 5 | 20 | 0.583 | -1114.87 | 2 | 50 | 1.107 | 151.04 | 15.567 / -14.057 | 3 | 47/124/124 | 2/3 |
| 4 | 2 | 0 | 0 | -4504.93 | 2 | 0 | 0 | -4504.93 | null / -22.525 | 0 | 36/47/47 | 2/3 |

## Germany|medium — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 0 | null | null | 0 | 0 | null | null | 0 | null / null | 0 | null/null/null | 0/3 |
| 2 | 2 | 50 | 0.865 | -28.37 | 2 | 50 | 1.153 | 108.8 | 8.178 / -7.09 | 0 | 53/120/120 | 2/3 |
| 3 | 1 | 100 | 99 | 176.75 | 1 | 100 | 99 | 1201.09 | 12.011 / null | 0 | 31/31/31 | 1/3 |
| 4 | 0 | null | null | 0 | 0 | null | null | 0 | null / null | 0 | null/null/null | 0/3 |

## Germany|long — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 4 | 75 | 3.271 | 3289.27 | 4 | 75 | 4.43 | 4968.14 | 21.388 / -14.484 | 0 | 99/276/276 | 4/3 |
| 2 | 2 | 0 | 0 | -1825.85 | 2 | 50 | 2.344 | 1475.84 | 25.739 / -10.981 | 0 | 12/196/196 | 2/3 |
| 3 | 2 | 50 | 0.842 | -200.97 | 2 | 50 | 0.842 | -200.97 | 10.711 / -12.721 | 0 | 1/48/48 | 2/3 |
| 4 | 1 | 0 | 0 | -414.62 | 0 | null | null | 0 | null / null | 1 | null/null/null | 0/3 |

## France|long — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 2 | 0 | 0 | -1954.83 | 2 | 0 | 0 | -1954.83 | null / -9.774 | 0 | 9/13/13 | 1/3 |
| 2 | 2 | 50 | 0.945 | -61.91 | 2 | 100 | 99 | 2518.96 | 12.595 / null | 0 | 115/249/249 | 2/3 |
| 3 | 4 | 75 | 36.773 | 5288.79 | 4 | 75 | 4.426 | 4208.2 | 18.122 / -12.284 | 0 | 59/167/167 | 4/3 |
| 4 | 3 | 33.3 | 0.723 | -551.68 | 3 | 33.3 | 0.48 | -1564.59 | 14.42 / -15.033 | 0 | 22/85/85 | 3/3 |

## India|long — KEEP TESTED EXITS

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 0 | null | null | 0 | 0 | null | null | 0 | null / null | 0 | null/null/null | 0/3 |
| 2 | 13 | 69.2 | 3.754 | 8064.15 | 12 | 58.3 | 1.481 | 3683.51 | 16.2 / -15.312 | 1 | 116/234/237 | 12/3 |
| 3 | 8 | 12.5 | 0.247 | -5320.66 | 8 | 25 | 0.374 | -5202.85 | 15.51 / -13.842 | 0 | 78/213/213 | 8/3 |
| 4 | 0 | null | null | 0 | 0 | null | null | 0 | null / null | 0 | null/null/null | 0/3 |

## Commodities|long — APPLY

| Window | Base n | Base win | Base PF | Base PnL | New n | New win | New PF | New PnL | Avg win/loss | Unresolved | Hold med/p90/max | Concurrent/cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| 1 | 0 | null | null | 0 | 0 | null | null | 0 | null / null | 0 | null/null/null | 0/3 |
| 2 | 1 | 0 | 0 | -1834.64 | 1 | 0 | 0 | -1834.64 | null / -18.346 | 0 | 8/8/8 | 1/3 |
| 3 | 3 | 66.7 | 6.37 | 6186.82 | 3 | 66.7 | 2.922 | 3949.09 | 30.02 / -20.548 | 0 | 18/62/62 | 1/3 |
| 4 | 0 | null | null | 0 | 0 | null | null | 0 | null / null | 0 | null/null/null | 0/3 |
