# Setup-book paper go-live

Enabled: 2026-10-05 for recommendations + paper execution. Real-money stays disarmed.

## STEP 0

### 0a — long-horizon entry-window amendment

Frozen 2026-10-05 15:34 SGT: attribute each long trend trade to the window it
enters; allow the exit after the window; keep the 180-session embargo.

Pooled Japan + Hong Kong + Germany + France + Commodities + India, sector OFF:

| Window | Trades | PnL | PF |
| ---: | ---: | ---: | ---: |
| 1 | 24 | −$3,239 | 0.816 |
| 2 | 35 | +$33,137 | 4.587 |
| 3 | 34 | +$13,522 | 1.808 |
| 4 | 13 | −$4,755 | 0.604 |

`LONG_TREND_SECTOR_OFF` was **not** enabled. Full table:
`docs/long-trend-entry-window-readout.md`.

### 0b — US Wave 3 contradiction

The corrected pooled run is PF 1.20 / +$190k, but its windows are approximately
−$272k / +$264k / +$198k / −$79k. Because windows 1 and 4 lose money,
`US_LONG_WAVE3` is **disabled** despite positive pooled PnL. Details:
`docs/us-wave3-long-reconciliation.md`.

## Exit amendment — 2026-10-05

No time exit, plus the one-lot breakeven ratchet, was replayed on the same
entries. A cell keeps the new exits only when the four-window result stays
positive and no window that was flat or profitable turns into a loss.

Approved: Japan medium, Japan short, Japan long, Hong Kong long, Germany
medium, Germany long, France long, Commodities long. Kept on tested exits:
Commodities medium (window 2 flipped to −$108), US short (combined result
turned negative), Hong Kong medium (window 4 flipped to −$2,831), India long
(combined result turned negative). Full window table:
`docs/exit-amendment-readout.md`.

## Enabled setups

Mean reversion is added to the current engine. The current engine stays on
only in the all-window-positive sector-on cells below, labelled
"Current engine — Experimental". India long is signals-only.

| Setup | Tier | Why | Conf | n | PF |
| --- | --- | --- | ---: | ---: | ---: |
| JAPAN_MEDIUM_MR | Tier 1 | Amended exits approved | 80.8% | 490 | 1.753 |
| JAPAN_SHORT_MR | Tier 2 | Amended exits approved | 65.4% | 523 | 1.351 |
| COMMODITIES_MEDIUM_MR | Tier 2 | Tested exits kept | 76.3% | 38 | 2.303 |
| US_SHORT_MR | Experimental | Tested exits kept | 59.5% | 1881 | 1.01 |
| JAPAN_LONG_ENGINE | Current engine — Experimental | All-window positive | 39.5% | 43 | 1.29 |
| HK_MEDIUM_ENGINE | Current engine — Experimental | All-window positive | 52.4% | 21 | 1.85 |
| HK_LONG_ENGINE | Current engine — Experimental | All-window positive | 46.2% | 13 | 1.41 |
| GERMANY_MEDIUM_ENGINE | Current engine — Experimental | All-window positive | 75% | 4 | 6.31 |
| GERMANY_LONG_ENGINE | Current engine — Experimental | All-window positive | 50% | 10 | 1.53 |
| FRANCE_LONG_ENGINE | Current engine — Experimental | All-window positive | 45.4% | 11 | 1.52 |
| INDIA_LONG_ENGINE | Current engine — Experimental | Signals only | 47.6% | 21 | 1.27 |
| COMMODITIES_LONG_ENGINE | Current engine — Experimental | All-window positive | 42.9% | 7 | 1.51 |

Not enabled: LONG_TREND_SECTOR_OFF, US_LONG_WAVE3, every sell, UK, US medium,
Commodities short.

Empty cells show **No validated setup**. India remains signals-only (no India setup is live).

## Execution

- `SETUP_BOOK_ENABLED=1` and `SETUP_BOOK_PAPER_EXECUTION=1` are set in
  `ibkr-bridge/run-forever.ps1` for the Windows paper bridge.
- `run-forever-live.ps1` explicitly forces both setup-book flags to `0`.
- Bridge refuses setup-book orders when role is live, account is not `DU*`, or live orders are armed.
- Each setup has tag `SETUP_BOOK:<id>`, ledger namespace `SETUP_BOOK:<id>`, and its own PnL view at `/api/setup-book/status`.
- Auto-pause after ≥15 closed trades (≥10 Experimental) if PF < 1.0 or win rate < backtest breakeven. Resume only by operator (`POST /api/setup-book/resume` or `SETUP_BOOK_RESUME_IDS`).

## Shared path

`setupSignalAt` / `setupExitDecision` / `simulateSetupTrade` in
`lib/strategy/evidence-setup-book.js` are used by both backtest and live.
Golden tests cover Japan medium MR, Commodities MR, and US Wave 3.
