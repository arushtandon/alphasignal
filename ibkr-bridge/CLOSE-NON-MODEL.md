# Close IB paper trades that AlphaSignal did **not** recommend

The bridge does this automatically on every reconcile sweep (~5 min):

| Position type | Action |
|---------------|--------|
| **Model open** (live AlphaSignal entry / today's board) e.g. 9988, DHL.DE | **Keep** — never auto-flattened |
| **IB-only orphan** (in IB, not on model book) e.g. 1810.HK, KHC if untracked | **Close** |
| **Error / unauthorized** (Hold→Buy, dual-list) | **Close** |

## When the market is closed

Closes are sent as **MKT + TIF OPG** (opening auction), so they sit in IB overnight and fill at the **next open** for that market:

- **HK / Japan** — next Asia morning open  
- **EU / UK** — next European open  
- **US** — next US cash open  

When the market is already in **RTH**, closes use **MKT DAY** immediately.

## What you should do tonight

1. Deploy / pull latest `main` (includes OPG orphan flatten).
2. Restart the bridge (see `restart-bridge.ps1` below).
3. Leave **IB Gateway paper** + bridge running overnight.
4. On each market’s open tomorrow, check TWS/Gateway: orphan names should be flat; model names stay.

## Manual nuclear option (closes EVERYTHING including model)

Only if you want a full wipe (not recommended for normal ops):

```powershell
cd C:\Users\tando\Downloads\alphasignal-repo\ibkr-bridge
$env:IBKR_PORT = "4002"
$env:IBKR_ACCOUNT = "DU1764495"
$env:IBKR_DRY_RUN = "0"
# Stop the bridge first, then:
node flatten-all.js
```

## Restart bridge

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\tando\Downloads\alphasignal-repo\ibkr-bridge\restart-bridge.ps1"
```
