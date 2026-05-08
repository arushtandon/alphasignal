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

```powershell
cd bloomberg-bridge
.\.venv\Scripts\activate
set BRIDGE_BIND=0.0.0.0
set BRIDGE_PORT=5055
set BLOOMBERG_BRIDGE_SECRET=choose-a-long-random-string
python bridge.py
```

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

---

## Fields (editable in `bridge.py`)

`BEST_PE_NTM`, `PE_RATIO`, `BEST_PEG_RATIO`, `BEST_TARGET_MEDIAN`, `SALES_YOY_GR`, `BEST_EPS_GROWTH`.
