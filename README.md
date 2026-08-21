# AlphaSignal — Global Markets AI Analyst

AI-powered stock analysis across S&P 500, NASDAQ, FTSE, HSI, Nikkei, DAX, CAC, EuroStoxx, Gold, Oil & Bitcoin.

## Deploy on Render

1. Push this repo to GitHub
2. Go to render.com → New → **Web Service** (NOT Static Site)
3. Connect your GitHub repo
4. Settings:
 - **Build Command:** `npm install`
 - **Start Command:** `npm start`
 - **Environment:** Node
5. Deploy the Blueprint in `render.yaml`. It provisions PostgreSQL plus a
   persistent `/var/data` disk. Set `AUTH_MACHINE_TOKEN_HASH` to the SHA-256
   hash of the raw token used by the local bridge.

## Capital-readiness controls

- One versioned decision policy is shared by live recommendations and research.
- Backtests report returns after modeled commissions, spread, slippage, taxes,
  FX and short borrow.
- Live quantity is based on IBKR net liquidation value and entry-to-stop risk,
  with notional, lot, ADV, spread and futures-contract limits.
- Portfolio admission enforces gross/net, name, sector, country, currency,
  correlation-cluster, open-stop-risk and daily-new-risk limits.
- New entries scale down at 5% and 7.5% broker drawdown and pause at 10%.
- Server state is mirrored transactionally to PostgreSQL; the bridge uses
  SQLite WAL and keeps atomic JSON backups.

Run deterministic checks:

```bash
npm run test:capital
npm run lifecycle
node ibkr-bridge/contract-resolution.test.js
```

Run the canonical, cost-adjusted walk-forward report:

```bash
npm run validate:capital
```

Results land in `scripts/capital-readiness-report.json`. A failed report blocks
capital promotion; it is not an instruction to loosen thresholds.

## Bracket acceptance

Capital promotion requires a sufficient sample, positive net expectancy,
**PF ≥1.5**, **Sharpe ≥1.2**, **max drawdown ≤10%**, and the horizon-specific
win-rate guardrail.

```bash
npm run acceptance
# or
node scripts/run-bracket-acceptance.js --window=252 --sides=sell,buy
```

Results land in `scripts/bracket-acceptance-results.json`.
Failed brackets can be gated opt-in via `DISABLED_BRACKETS=sell:medium,sell:long,buy:short` (default: all brackets shown so the dashboard never goes blank).

API: `GET /api/backtest/acceptance` and `GET /api/backtest/medium-sell?hz=short&side=sell&window=252`

## IBKR paper bridge

AlphaSignal emits trade lifecycle events at `GET /api/ibkr/events`.
A small process next to **IB Gateway / TWS** places bracket orders — see [`ibkr-bridge/README.md`](ibkr-bridge/README.md).

## Usage

Enter your Anthropic API key in the green bar at the top of the app.
Get a key at https://console.anthropic.com
