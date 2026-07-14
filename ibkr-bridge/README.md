# AlphaSignal → IBKR paper bridge

AlphaSignal stays the **signal engine** (Render is fine).  
IBKR’s TWS API needs a running **Trader Workstation** or **IB Gateway** on a machine you control — that process **cannot** run on Render.

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

Event types: `entry`, `tp1_partial`, `tsl_update`, `exit` (also `entry_finalized` later).

## 2. Run IB Gateway / TWS (paper)

1. Install [IB Gateway](https://www.interactivebrokers.com/en/trading/ibgateway-stable.php) or TWS.
2. Log into the **paper** account.
3. Enable API: **Configure → Settings → API → Settings**
   - Enable ActiveX and Socket Clients
   - Socket port **4002** (Gateway paper) or **7497** (TWS paper)
   - Trusted IPs: `127.0.0.1`
4. Optional headless: Docker image `ghcr.io/gnzsnz/ib-gateway` (IBC).

## 3. Run the bridge (next to Gateway)

```powershell
cd ibkr-bridge
npm install

# Always start in dry-run (no orders)
$env:ALPHASIGNAL_URL = "https://YOUR-APP.onrender.com"
$env:IBKR_EVENTS_TOKEN = "same-as-render"
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

For each new AlphaSignal signal:

| Leg | IB order | Size |
|-----|----------|------|
| Parent | MKT | full `$10k` share count |
| Child 1 | LMT at TP1 | floor(total/2) — banks the partial |
| Child 2 | TRAIL | remainder — server-side trailing stop |

This mirrors AlphaSignal’s whole-share TP1 split + ratchet runner.

## 5. Sequencing recommendation

1. Run bracket acceptance (`npm run acceptance` in repo root) — gate failing sides/horizons.
2. Wire paper in **dry-run** and confirm event flow.
3. Only then set `IBKR_DRY_RUN=0`.

Connecting a negative-expectancy book to even a paper account just automates the drawdown.
