# AlphaSignal → IBKR paper bridge

AlphaSignal stays the **signal engine** (Render is fine).
IBKR's TWS API needs a running **Trader Workstation** or **IB Gateway** on a machine you control — that process **cannot** run on Render.

```
AlphaSignal  ──JSONL events──►  ibkr-bridge (this folder)  ──socket──►  IB Gateway / TWS paper
   /api/ibkr/events                   @stoqey/ib                    port 4002 / 7497
```

## 1. Enable the event feed on AlphaSignal

On Render (or local `.env`):

| Variable | Meaning |
|----------|---------|
| `IBKR_EVENTS_TOKEN` | Shared secret (recommended). Bridge sends it as Bearer / `?token=` |
| `IBKR_EVENTS_ENABLED` | Default on; set `0` to silence the feed |

Endpoints:

- `GET /api/ibkr/status`
- `GET /api/ibkr/events?since=0&limit=200`

Event types: `entry`, `entry_finalized`, `tp1_partial`, `tsl_update`, `exit`.

## 2. Run IB Gateway / TWS (paper)

1. Install [IB Gateway](https://www.interactivebrokers.com/en/trading/ibgateway-stable.php) or TWS.
2. Log into the **paper** account.
3. Enable API: **Configure → Settings → API → Settings**
   - Enable ActiveX and Socket Clients
   - Socket port **4002** (Gateway paper) or **7497** (TWS paper)
   - Trusted IPs: `127.0.0.1`
   - Untick "Read-Only API"
4. Optional headless: Docker image `ghcr.io/gnzsnz/ib-gateway` (IBC).

## 3. Run the bridge (next to Gateway)

```powershell
cd ibkr-bridge
npm install

# Always start in dry-run (no orders)
$env:ALPHASIGNAL_URL = "https://alphasignal-dvg5.onrender.com"
$env:IBKR_EVENTS_TOKEN = "same-as-render"   # only if set on Render
$env:IBKR_PORT = "7497"   # or 4002 for Gateway
$env:IBKR_DRY_RUN = "1"
npm start
```

When dry-run logs look right:

```powershell
$env:IBKR_DRY_RUN = "0"
$env:IBKR_ACCOUNT = "DUxxxxxx"   # optional paper account id
npm start
```

State / cursor: `bridge-state.json` (gitignored locally — do not commit secrets).

## 4. What gets placed on `entry`

Position size = `IBKR_NOTIONAL` (default $10k) **converted to the local currency**
(¥ / HK$ / € / £ / ₹) so every market gets a genuine ~$10k position, rounded to
exchange lots (100 for SEHK/TSEJ).

**Futures (`GC=F`, `HG=F`, `CL=F`, …)** and **crypto (`BTC-USD`, `ETH-USD`)** are
executable. Front-month futures are resolved via IB `reqContractDetails`. When
$10k is below one contract’s notional value (e.g. copper HG), the bridge still
places **1 contract** so the signal is not skipped. Crypto uses fractional qty
on PAXOS.

| Leg | IB order | Size | Notes |
|-----|----------|------|-------|
| Parent | LMT @ recommended entry, `DAY` | full | `outsideRth` for US so the entry works pre-market / regular / post-market. Unfilled at session end → IB cancels parent **and** children (no orphans) |
| Stop | STP @ SL, `GTC` | **full** | Pre-TP1 an SL hit exits the whole position — identical to the simulator |
| TP1 | LMT @ TP1, `GTC` | half | Banks the partial |

## 5. Lifecycle after entry (mirror of the simulator)

- **TP1 fills** → the stop is resized to the runner half and raised to
  breakeven (never lower).
- **`tsl_update`** → the stop price is ratcheted in place. It is never loosened.
- **Stop fills** → any still-open TP1 limit is cancelled.
- **`exit` (signal / time-limit exit)** → all child orders are cancelled and any
  remaining shares are flattened at market. An exited trade always ends with
  zero open orders and zero position.
- **Orphan sweep** every 5 minutes: any open IB order belonging to a closed
  trade key is cancelled (belt and braces).

Skipped instruments (logged, never half-placed): NSE/BSE stocks unless
`IBKR_ALLOW_NSE=1` (IB restricts Indian exchanges for most non-India accounts).
Futures (`=F`) and crypto (`-USD`) **are supported** (front-month / PAXOS).

Entry events older than `IBKR_MAX_EVENT_AGE_H` (default 24h) are skipped so a
fresh cursor never replays weeks of history as live orders.

## 6. Reconciliation + Telegram risk alerts

Every **15 minutes** (`IBKR_RECON_MS`, default `900000`) the bridge runs a full reconcile:

- IB ↔ AlphaSignal ledger sync (matched / adjusted / untracked)
- Re-arm unfilled model entries still live on the board
- Flatten IB-only orphans / error tickers
- Risk digest → **Telegram** when something needs attention

| Alert | When |
|-------|------|
| Untracked IB | Position at IB with no model book row |
| Unfilled RTH | Model entry still open in regular hours and not filled (≥10 min, `IBKR_UNFILLED_ALERT_MIN_MS`) |
| Missing stop | Filled lot with no stop order id |
| Recon errors / pending | Server reported ledger issues |
| All-clear | Sent once when a prior alert state returns to fully matched |

### Setup Telegram

1. In Telegram, talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **bot token**.
2. Open a chat with your bot (or add it to a group) and send any message.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy your **chat id** (`message.chat.id`).
4. In `run-forever.ps1` (or your shell env):

```powershell
$env:TELEGRAM_BOT_TOKEN = "123456:ABC..."
$env:TELEGRAM_CHAT_ID   = "123456789"
$env:TELEGRAM_ALERTS    = "1"          # set 0 to mute
$env:IBKR_RECON_MS      = "900000"     # 15 minutes
```

5. Restart the bridge supervisor (`restart-bridge.ps1`). On the next reconcile with issues you get a Telegram message; when everything matches again you get a single ✅ all-clear.

Ledger posts still run about every **60s** for qty/avg/PnL; the heavier flatten/re-arm/alert sweep is the 15‑minute cadence.

## 7. Keeping it running 24/7 (Windows)

**Bridge** — `run-forever.ps1` restarts it on any crash and logs to `logs\`.
Register it to start at logon (run once in an elevated PowerShell):

```powershell
schtasks /Create /TN "AlphaSignal IBKR Bridge" /SC ONLOGON /RL HIGHEST `
  /TR "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \"$PWD\run-forever.ps1\""
```

**IB Gateway** — in Configure → Settings → **Lock and Exit**:
- choose **Auto restart** (not auto-logoff) and set a restart time,
- IBKR still forces one full re-login per week (usually Sunday) — check it Monday mornings.

**PC** — stop it sleeping: `powercfg /change standby-timeout-ac 0`
and enable automatic Windows login if you want it to survive reboots unattended.

## 8. Sequencing recommendation

1. Run bracket acceptance (`npm run acceptance` in repo root) — gate failing sides/horizons.
2. Wire paper in **dry-run** and confirm event flow.
3. Only then set `IBKR_DRY_RUN=0`.

Connecting a negative-expectancy book to even a paper account just automates the drawdown.
