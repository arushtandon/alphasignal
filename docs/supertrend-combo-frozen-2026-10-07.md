# Frozen Supertrend combinations — 2026-10-07

Replacement Stage 1 freeze. The 2026-10-07 long-only freeze is void.
These rules are not to be changed before Stage 2. Stage 2 has not been run.
Pre-registration `e552e85700d5049beb8b4299b46dee088ed7c9dc`.

Top 3 by per-trade excess t inside each horizon and side, among rows with PF at least 1.2 and the horizon minimum trades (SHORT 300, MEDIUM 150, LONG 100). LONG includes the daily (14, 4) base and the weekly (10, 3) base.

## 1. SHORT short — SHORT / short / F1+F4 / X1

- Horizon: SHORT. Base: SHORT. Side: short.
- Filters, all required: F1+F4.
- Exit: X1.
- Stage 1: 3930 trades, excess t 4.16, PF 1.20, win 48.73%, mean excess 0.32%.

## 2. SHORT short — SHORT / short / F4+F9 / X1

- Horizon: SHORT. Base: SHORT. Side: short.
- Filters, all required: F4+F9.
- Exit: X1.
- Stage 1: 3059 trades, excess t 3.69, PF 1.21, win 48.94%, mean excess 0.32%.

## 3. LONG long — WEEKLY / long / F7+F9 / X1

- Horizon: LONG. Base: WEEKLY. Side: long.
- Filters, all required: F7+F9.
- Exit: X1.
- Stage 1: 306 trades, excess t 1.66, PF 1.32, win 50.65%, mean excess 1.62%.

## 4. LONG long — WEEKLY / long / F7+F9 / X2

- Horizon: LONG. Base: WEEKLY. Side: long.
- Filters, all required: F7+F9.
- Exit: X2.
- Stage 1: 306 trades, excess t 1.23, PF 1.23, win 46.08%, mean excess 1.18%.

