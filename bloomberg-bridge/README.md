# Bloomberg bridge (Terminal PC → JSON)

**The Bloomberg Desktop API only works on the PC where Bloomberg Terminal is running.**  
You cannot point AlphaSignal at `localhost:8194` on another machine.

### Bloomberg Enterprise (HTTP / Open API)

If your firm has **enterprise** access, Bloomberg usually gives you an **HTTPS gateway** (often with **client certificates**), not Terminal on your app server. Configure the Node app with:

- `BLOOMBERG_ENTERPRISE_API_BASE` — base URL Bloomberg/your IT provides  
- `BLOOMBERG_ENTERPRISE_CERT_PATH`, `BLOOMBERG_ENTERPRISE_KEY_PATH`, `BLOOMBERG_ENTERPRISE_CA_PATH` — PEM files if using mTLS  
- Optional `BLOOMBERG_ENTERPRISE_TOKEN` — if your gateway uses Bearer tokens  

See the **Environment reference** table at the bottom of this file. Enterprise overrides Yahoo/FMP; the optional **local bridge** only fills gaps.

---

### Terminal + local Python bridge


1. Install and run **`bridge.py` only on the PC that has Terminal** (it uses `pdblp` → localhost `8194`).
2. Expose the bridge’s **HTTP port** (not Bloomberg) to your other PC or cloud host using one of the options below.

---

## A) Same office / home LAN (simplest)

**On the Terminal PC** (where Bloomberg is open):

If you see **“path not found”**, you are not inside the `bloomberg-bridge` folder (or the folder was never copied there). Unzip/copy the whole `bloomberg-bridge` directory to a simple path, e.g. `C:\alpha\bloomberg-bridge`, then run the launcher below from **that** folder.

If you see **“python not found”**, install Python and reopen PowerShell — see **Python on Windows** below.

**Easiest (recommended):** open PowerShell **in the `bloomberg-bridge` folder**, then:

```powershell
$env:BRIDGE_BIND = "0.0.0.0"
$env:BRIDGE_PORT = "5055"
$env:BLOOMBERG_BRIDGE_SECRET = "paste-a-long-random-secret-here"
powershell -ExecutionPolicy Bypass -File .\run-bridge.ps1
```

**Manual (if you already have Python on PATH):**

```powershell
cd C:\path\to\bloomberg-bridge
py -3 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
$env:BRIDGE_BIND = "0.0.0.0"
$env:BLOOMBERG_BRIDGE_SECRET = "your-secret"
.\.venv\Scripts\python bridge.py
```

### Python on Windows

1. From [python.org/downloads](https://www.python.org/downloads/) — during setup, enable **“Add python.exe to PATH”**, then **log out/in** or open a **new** PowerShell window.
2. Or install **Python 3.12+** from the **Microsoft Store**, then open a new PowerShell and run `python --version`.
3. On locked-down machines, use **`py -3`** (Python Launcher) if IT installed it: `py -3 --version`.

Test: `py -3 --version` **or** `python --version` — one of them should print a version.

### “Terminal is running” but the bridge exits (pdblp / blpapi)

The bridge needs Bloomberg’s **`blpapi`** wheel in your `.venv`; **opening Terminal does not put that inside Python for you.**

**Fix** (already automated in **`run-bridge.bat`**):

```text
pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi
pip install -r requirements.txt
```

Use **64-bit Python** if your Bloomberg install is 64-bit. If the URL is blocked, use **[API Library](https://www.bloomberg.com/professional/support/api-library/)** or IT-provided wheels.

**Windows Firewall** on the Terminal PC: allow **inbound TCP** on port `5055` (scope: your LAN or VPN only if you can).

Find the Terminal PC’s IPv4 (`ipconfig`), e.g. `192.168.1.80`.

**On your dev PC / app server** (or Render env if that server can reach that IP — usually **not** from the public internet):

```text
BLOOMBERG_BRIDGE_URL=http://192.168.1.80:5055
BLOOMBERG_BRIDGE_SECRET=choose-a-long-random-string
```

From the other PC, test: `http://192.168.1.80:5055/health`

Always use **`BLOOMBERG_BRIDGE_SECRET`** when the bridge listens on `0.0.0.0`.

---

## B) Different building — site‑to‑site VPN

Same as (A), but devices use **VPN private IPs** (e.g. `10.x.x.x`). The machine with Terminal must be reachable over the VPN; firewall rules apply on the **Terminal PC** and possibly the corporate network.

---

## C) Internet / cloud (Render) reaching a home office Terminal

Setting **`BLOOMBERG_BRIDGE_URL=http://10.0.0.x:5055`** (or `192.168.*`, etc.) **on Render will never work.** Cloud servers cannot open TCP routes into your LAN. Recent AlphaSignal **`/api/health`** includes **`bloomberg_bridge_lan_unreachable_from_cloud`** when your URL looks private.

A cloud host **cannot** open a raw connection to a random home PC. You need a **tunnel** from the **Terminal PC** outbound:

| Tool | Idea |
|------|------|
| **Cloudflare Tunnel** (`cloudflared`) | Terminal PC runs tunnel → you get `https://…` URL; AlphaSignal uses that as `BLOOMBERG_BRIDGE_URL`. |
| **ngrok** | `ngrok http 5055` on Terminal PC → use the HTTPS URL in `BLOOMBERG_BRIDGE_URL`. |

**Mandatory:** strong `BLOOMBERG_BRIDGE_SECRET` and treat the tunnel URL as a secret.

**Compliance:** Restoring Bloomberg-derived data across the internet may be restricted by your **Bloomberg agreement**. Confirm with your license / compliance team before production use.

---

## D) “Real” server-side Bloomberg (no Terminal PC in the loop)

That is **Bloomberg Enterprise** (e.g. **B-Pipe**, **Data License**, **Server API** under contract), not this bridge. Different product, different implementation.

---

## Troubleshooting

### `InvalidStateException: Session Not Started` / `/snapshot` → 503

The bridge talks to Bloomberg over **localhost port 8194**. That session exists only while **Bloomberg Terminal is open and logged in** on that PC. If Terminal sleeps, logs out, or the API connection drops, you will see **Session Not Started** in the bridge console and **`no data`** / **503** on `/snapshot` until you restart Terminal (or at least restore the session) and **restart `bridge.py`** so `pdblp` opens a fresh session. The bridge code resets its `BCon` automatically when it detects this error and retries once per request.

### Symbol mapping (AlphaSignal ↔ Bloomberg)

When you omit `bb=`, `bridge.py` maps common broker/Yahoo suffixes to Bloomberg **yellow keys**:

| Example AlphaSignal / Yahoo | Mapped Bloomberg equity (no `bb=` hint) |
|----------------------------|------------------------------------------|
| `9988.HK` | `9988 HK Equity` |
| `7203.T` | `7203 JT Equity` |
| `RELIANCE.NS` | `RELIANCE IS Equity` (**IS** = NSE in Bloomberg; not `IN`) |
| `RELIANCE.BO` | `RELIANCE IB Equity` (BSE) |

Always pass **`bb=`** with the exact string from Terminal if a name does not resolve.

---

## Environment reference

| Variable | Where | Meaning |
|----------|--------|---------|
| `BLOOMBERG_ENTERPRISE_API_BASE` | Node / Render | Bloomberg HTTP API base URL (per your contract), no trailing slash |
| `BLOOMBERG_ENTERPRISE_CA_PATH` | Node | Optional CA bundle PEM |
| `BLOOMBERG_ENTERPRISE_CERT_PATH` | Node | Client cert PEM (mTLS) |
| `BLOOMBERG_ENTERPRISE_KEY_PATH` | Node | Client key PEM |
| `BLOOMBERG_ENTERPRISE_TOKEN` | Node | Optional Bearer token |
| `BLOOMBERG_ENTERPRISE_TLS_INSECURE` | Node | `1` = skip TLS verify (**dev only**) |
| `BRIDGE_BIND` | Terminal PC | `127.0.0.1` (default) = loopback only; **`0.0.0.0`** = accept LAN/VPN |
| `BRIDGE_PORT` | Terminal PC | HTTP port (default `5055`) |
| `BLOOMBERG_BRIDGE_SECRET` | Terminal PC **and** Node app | Same value; `Authorization: Bearer …` |
| `BLOOMBERG_BRIDGE_URL` | Node (Render / dev PC) | Full base URL, e.g. `http://192.168.1.80:5055` or `https://…ngrok-free.app` |
| `BLOOMBERG_BRIDGE_EARNINGS_PRIORITY` | Node | `1` (default) = Bloomberg overrides free feeds when present; `0` = only fill empty fields |

---

## Fields (editable in `bridge.py`)

`BEST_PE_NTM`, `PE_RATIO`, `BEST_PEG_RATIO`, `BEST_TARGET_MEDIAN`, `SALES_YOY_GR`, `BEST_EPS_GROWTH`.

### `/earnings?symbol=AAPL` (and optional `&bb=AAPL US Equity`)

Returns next report date and EPS context for the AlphaSignal **earnings** card:

- **Ref data:** `EXPECTED_REPORT_DT`, `EXPECTED_REPORT_TYP`, `BEST_EPS`, `BEST_FPERIOD_END_DT`
- **History (best effort):** Quarterly BDH aligns **actual EPS** (`IS_COMP_EPS` and fallbacks), optional **consensus** (`FQ_EPS_MEAN`, `BEST_EPS`, etc.), and **% surprise** (`FQ_EPS_PERCENT_SURPRISE`). If consensus is missing but **% surprise** AND actual exist, the bridge **derives** implied consensus \(E = A / (1 + \text{pct}/100)\).
- **Asian / thin coverage:** Quarterly BDH accepts **2+** datapoints (was 4+) so short histories still return rows when Terminal has data.

The Node server merges this automatically when **`BLOOMBERG_BRIDGE_URL`** is set (same secret as `/snapshot`).

**Merge behaviour (Node env):**

- Default (`BLOOMBERG_BRIDGE_EARNINGS_PRIORITY=1` or unset): Bloomberg bridge overrides Finnhub/Yahoo/FMP when it returns dates or history rows.
- `BLOOMBERG_BRIDGE_EARNINGS_PRIORITY=0`: Bloomberg fills **only gaps** (e.g. Yahoo empty).

---
