# AlphaSignal — Global Markets Analyst

AI-powered analysis (optional) with **live quotes, charts, earnings, and history powered by Yahoo Finance**. Anthropic Claude is used only for dashboard scans and single-instrument analysis when `ANTHROPIC_API_KEY` is set on the server.

## What uses what

| Feature | Source |
|--------|--------|
| Live prices (`/api/prices`) | Yahoo Finance |
| Charts (`/api/chart`) | Yahoo Finance |
| Per-ticker earnings (`/api/earnings/:symbol`) | **Merged:** Finnhub calendar (priority) → Financial Modeling Prep (FMP) → Yahoo (`quoteSummary` / chart events for history). |
| Earnings calendar widget (`/api/earnings-calendar`) | **Merged:** Finnhub bulk calendar → FMP → Yahoo gap-fill for tracked symbols. |
| Dashboard scan / single analysis | Anthropic API (optional) |

**Google Finance:** there is no dependable public REST API for consolidated earnings calendars (scraping SERPs violates terms and breaks often). For higher-quality dates/EPS estimates, configure **Finnhub** and/or **FMP** API keys below.

Optional env on the server:

```bash
# Recommended — earnings calendars & corroborated next dates (free tiers available):
export FINNHUB_API_KEY=your_finnhub_token
export FMP_API_KEY=your_financial_modeling_prep_key
```

`/api/health` reports whether these keys are set (`earnings.finnhub_calendar`, `earnings.fmp_calendar`).

## Self-host on Vultr (Ubuntu 22.04 LTS)

1. Create a **VPS** (1 vCPU / 1 GB RAM is enough for light use). Open firewall ports **22** (SSH) and **80/443** if you use a reverse proxy.

2. SSH in and install Node 20 LTS (or current LTS):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

3. Clone/upload this app, then:

   ```bash
   cd alphasignal-app
   npm install
   ```

4. **Environment** — create `/etc/alphasignal.env` or use your shell profile:

   ```bash
   export PORT=3000
   # Optional — better earnings calendars (recommended):
   export FINNHUB_API_KEY=...
   export FMP_API_KEY=...
   # Optional — Claude AI scans/analysis:
   export ANTHROPIC_API_KEY=sk-ant-api03-...
   ```

5. Run under **systemd** (example `/etc/systemd/system/alphasignal.service`):

   ```ini
   [Unit]
   Description=AlphaSignal Express
   After=network.target

   [Service]
   Type=simple
   User=www-data
   WorkingDirectory=/opt/alphasignal-app
   EnvironmentFile=/etc/alphasignal.env
   ExecStart=/usr/bin/node server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now alphasignal
   ```

6. Put **Nginx** or Caddy in front for HTTPS (Let’s Encrypt). Proxy `location /` to `http://127.0.0.1:3000`.

7. **Persistence:** trade history is saved under `./data/history_data.json` (created automatically) when the process can write there.

## Deploy on Render (alternative)

1. Push **this repo** to GitHub and connect it in Render.
2. Create a **Web Service** (Node), **not** a static site:
   - **Build command:** `npm install`
   - **Start command:** `npm start` (runs `server.js`; `render.yaml` can mirror this)
3. In **Environment → Environment Variables**, add any of:
   | Variable | Needed for |
   |----------|------------|
   | `ANTHROPIC_API_KEY` | AI dashboard scans + single-instrument analysis |
   | `FINNHUB_API_KEY` | Better earnings calendars (recommended) |
   | `FMP_API_KEY` | Extra earnings corroboration (optional) |
4. Deploy. Open the `*.onrender.com` URL; check `/api/health`.
5. **Custom domain:** Render Dashboard → your service → **Settings → Custom Domains** → add `safronalphasignal.duckdns.org` → follow DNS instructions (below). Render provisions **HTTPS** automatically for verified domains.

## Custom domain (`safronalphasignal.duckdns.org`)

A pretty URL does **not** by itself fix “slow loading”: speed depends on geography, VPS size, and one big HTML bundle. Choosing a **region close to you** (Vultr/Render datacenter near users) matters more than the hostname.

**DuckDNS** is free Dynamic DNS — you choose a subdomain that points at your machine’s IP.

### If you host on **Vultr**

1. In DuckDNS → create token → add subdomain `safronalphasignal` → set **IPv4** to your Vultr VPS public IP.
2. Optionally install [duckdns updater](https://www.duckdns.org/install.jsp) on the VPS so the IP stays current after reboots/IP changes (static Vultr IP often doesn’t change).
3. Point **DNS** → your VPS public IP (`A` record for `safronalphasignal.duckdns.org` is maintained by DuckDNS).
4. On the VPS, install **Nginx** + **Certbot**, proxy to `127.0.0.1:3000`:
   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   sudo certbot --nginx -d safronalphasignal.duckdns.org
   ```
5. Firewall: allow **80** and **443** (and deny direct public **3000** if you want; only nginx should face the internet).

### If you stay on **Render**

1. DuckDNS subdomain must resolve with a **DNS record Render tells you** (usually a **CNAME** from `safronalphasignal.duckdns.org` toward your Render host), **or** DuckDNS may not expose full CNAME control for apex-style records — simplest path is usually a domain with a normal DNS panel. For DuckDNS-only setups, **Vultr + A record IP** + Certbot is the straightforward pattern.
2. If Render gives you a CNAME target, add that record where DuckDNS allows (check DuckDNS docs for subdomain CNAME restrictions).

## Usage

- Browse prices, charts, and history without any API key (Yahoo-only paths).
- Add `ANTHROPIC_API_KEY` on the server when you want dashboard AI scans and Claude-backed analysis.
