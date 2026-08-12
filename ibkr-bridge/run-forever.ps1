# Keeps the AlphaSignal -> IBKR bridge running: restarts it automatically if it
# crashes or the PC reboots (when registered as a scheduled task - see README).
#
#   powershell -ExecutionPolicy Bypass -File run-forever.ps1
#
# Logs: ibkr-bridge\logs\bridge-YYYY-MM-DD.log (written by bridge.js itself)

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$env:ALPHASIGNAL_URL = "https://alphasignal-dvg5.onrender.com"
$env:IBKR_PORT       = "4002"        # 4002 = IB Gateway paper, 7497 = TWS paper
$env:IBKR_ACCOUNT    = "DU1764495"
$env:IBKR_DRY_RUN    = "0"
# Avoid clientId 17 — a stuck elevated node often holds it (Access Denied to kill).
# flatten-all.js uses 18; keep bridge on 27.
$env:IBKR_CLIENT_ID  = "27"
# Portfolio marks (updatePortfolio) are the primary MTM source. Tick MD type
# is secondary — 3=delayed is fine when TWS already holds the live MD slot.
$env:IBKR_MARKET_DATA_TYPE = "3"
# Full IB↔AS reconcile + Telegram risk digest (default 15 minutes).
$env:IBKR_RECON_MS = "900000"
# Telegram risk alerts (untracked IB, unfilled RTH orders, recon errors).
# Create a bot via @BotFather, DM it once, then get chat id from getUpdates.
# Uncomment and fill:
# $env:TELEGRAM_BOT_TOKEN = "123456:ABC..."
# $env:TELEGRAM_CHAT_ID   = "123456789"
# $env:TELEGRAM_ALERTS    = "1"

New-Item -ItemType Directory -Force -Path "$PSScriptRoot\logs" | Out-Null

# Resolve real node.exe (avoid shim that Start-Process mishandles)
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { $node = "node" }

Write-Host "AlphaSignal IBKR bridge supervisor"
Write-Host "node: $node"
Write-Host "Logs go to: $PSScriptRoot\logs\bridge-YYYY-MM-DD.log"
Write-Host "Live tail in another window:"
Write-Host "  cd $PSScriptRoot"
Write-Host "  Get-Content .\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log -Tail 50 -Wait"
Write-Host ""

while ($true) {
  $log = "$PSScriptRoot\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log"
  $stamp = Get-Date -Format o
  try { Add-Content -Path $log -Value "$stamp [run-forever] starting bridge" -ErrorAction SilentlyContinue } catch {}
  Write-Host "$stamp starting bridge -> $log"
  # Run in THIS process (not Start-Process). Start-Process was reporting exit
  # code 0 within ~1s while marks still came from a leftover node, or killing
  # the supervisor loop while a zombie held clientId 17.
  & $node "$PSScriptRoot\bridge.js"
  $code = $LASTEXITCODE
  try { Add-Content -Path $log -Value "$(Get-Date -Format o) [run-forever] bridge exited (code $code) - restarting in 30s" -ErrorAction SilentlyContinue } catch {}
  Write-Host "$(Get-Date -Format o) bridge exited (code $code) - restarting in 30s"
  Start-Sleep -Seconds 30
}
