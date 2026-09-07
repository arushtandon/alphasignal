# Paper + live IBKR (two Gateways, two bridges)

Paper stays on **DU1764495** / Gateway **4002**. Live is a second stack. Do not point the current paper process at a live account — `bridge-state.json` still holds 9988 / SGRO / PLTR paper lots.

## IB Gateway (live account)

1. Install a **second** IB Gateway (or use TWS live). Paper Gateway stays logged in on 4002.
2. Log into the **live** account (`U…`, not `DU1764495`).
3. **Configure → Settings → API → Settings**
   - Enable ActiveX and Socket Clients
   - Socket port **4001** (Gateway live). TWS live is **7496**.
   - Trusted IPs: `127.0.0.1`
   - Untick Read-Only API
4. Trading permissions on **this** live account (Account Management): US, HK, JP, LSE, EU, futures, **PAXOS crypto**. Paper ETH 201 does not carry over. After IB marks crypto live, fully log out of the live Gateway and log back in.
5. Market data: live often needs paid US/HK subscriptions. The bridge can still use delayed ticks (`IBKR_MARKET_DATA_TYPE=3`).

One login cannot serve both paper and live. Two Gateways on one PC are fine if the ports differ.

## Live supervisor (this PC)

```powershell
# 1) Set the live account in gitignored secrets (never commit U… ids)
#    ibkr-bridge\local-secrets.ps1
#    $env:IBKR_LIVE_ACCOUNT = "Uxxxxxxxx"

# 2) Weekend / first start — DRY RUN (no live orders)
powershell -ExecutionPolicy Bypass -File ibkr-bridge\run-forever-live.ps1

# 3) Admin restart of the LIVE supervisor only (does not kill paper)
#    Right-click ibkr-bridge\restart-live-account.ps1 → Run as administrator
```

Live env (set by `run-forever-live.ps1`):

| Variable | Value |
|----------|--------|
| `IBKR_PORT` | `4001` |
| `IBKR_ACCOUNT` | `IBKR_LIVE_ACCOUNT` (`U…`) |
| `IBKR_DRY_RUN` | `1` until armed |
| `STATE_FILE` | `bridge-state-live.json` |
| `STATE_DB_FILE` | `bridge-state-live.sqlite` |
| `IBKR_SINCE_SEQ` | Render `latestSeq` at first empty start |

Empty live state + `since=0` would replay Friday’s still-open board (ETH / SGRO / 7733) as live orders. The supervisor pins `since` to the current feed seq on first boot.

## Live stays blank until go-ahead

Do **not** start the live supervisor and do **not** set `IBKR_LIVE_GOAHEAD` until you explicitly say so. `IBKR_LIVE_ARM` alone cannot place live orders. The Live trades tab stays empty.

When you give a go-ahead, add both to `local-secrets.ps1` then Admin-run `restart-live-account.ps1`:

```powershell
$env:IBKR_LIVE_GOAHEAD = "1"
$env:IBKR_LIVE_ARM = "1"
```

Live isolation (bridge refuses to start or place if any of these fail):

- Port is not paper `4002` / `7497`
- Account is not a `DU`/`DF` paper id
- State file is `bridge-state-live.json`, never paper `bridge-state.json`

## What stays on paper

- `run-forever.ps1` / `restart-live.ps1` / client 27 on port **4002**
- Existing paper lots (not copied to live)
- One-shots (`buy-eth-once.js`, …) still default to `4002` + `DU1764495`

## IBKR tab vs Live trades tab

- **IBKR** = paper `DU1764495` only
- **Live trades** = live account only (blank until go-ahead)

Render must be deployed with the account-scoped ledger before any live go-ahead.
