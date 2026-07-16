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
5. Click Deploy

## Bracket acceptance

Criteria: **WR ≥55% OR avg ≥+0.30%/trade**, and **PF ≥1.5**.

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
