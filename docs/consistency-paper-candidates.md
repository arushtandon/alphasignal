# Consistency study — paper candidate design

Design only. Nothing is enabled. `SETUP_BOOK_ENABLED` and IBKR routing are unchanged.

## Japan medium — A__Japan__medium__williams_r10_lt_minus_95__vol_skip_top30__sl2.5__t21__full

- Tag: `CONSISTENCY_JAPAN_MEDIUM`
- Mode: paper-only
- Rules: frozen exactly to the setup ID above; separate realised/unrealised PnL view.
- Forward pass: ≥30 closed trades; profitable overall; WR ≥ breakeven +5pp; no two-month loss worse than one average month gain.
- Promotion: requires a future dated approval; never automatic.

## Germany short — A__Germany__short__williams_r10_lt_minus_95__vol_skip_top30_and_ma50_flat_or_up__sl2__t5__full

- Tag: `CONSISTENCY_GERMANY_SHORT`
- Mode: paper-only
- Rules: frozen exactly to the setup ID above; separate realised/unrealised PnL view.
- Forward pass: ≥30 closed trades; profitable overall; WR ≥ breakeven +5pp; no two-month loss worse than one average month gain.
- Promotion: requires a future dated approval; never automatic.

## Germany medium — A__Germany__medium__close_below_lower_bb20_2__none__sl1.5__t21__full

- Tag: `CONSISTENCY_GERMANY_MEDIUM`
- Mode: paper-only
- Rules: frozen exactly to the setup ID above; separate realised/unrealised PnL view.
- Forward pass: ≥30 closed trades; profitable overall; WR ≥ breakeven +5pp; no two-month loss worse than one average month gain.
- Promotion: requires a future dated approval; never automatic.

## Commodities medium — A__Commodities__medium__close_below_lower_bb20_2__none__sl2.5__t21__partial

- Tag: `CONSISTENCY_COMMODITIES_MEDIUM`
- Mode: paper-only
- Rules: frozen exactly to the setup ID above; separate realised/unrealised PnL view.
- Forward pass: ≥30 closed trades; profitable overall; WR ≥ breakeven +5pp; no two-month loss worse than one average month gain.
- Promotion: requires a future dated approval; never automatic.

