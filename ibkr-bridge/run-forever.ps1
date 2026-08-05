# Keeps the AlphaSignal → IBKR bridge running: restarts it automatically if it
# crashes or the PC reboots (when registered as a scheduled task — see README).
#
#   powershell -ExecutionPolicy Bypass -File run-forever.ps1
#
# Logs: ibkr-bridge\logs\bridge-YYYY-MM-DD.log

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$env:ALPHASIGNAL_URL = "https://alphasignal-dvg5.onrender.com"
$env:IBKR_PORT       = "4002"        # 4002 = IB Gateway paper, 7497 = TWS paper
$env:IBKR_ACCOUNT    = "DU1764495"
$env:IBKR_DRY_RUN    = "0"

New-Item -ItemType Directory -Force -Path "$PSScriptRoot\logs" | Out-Null

while ($true) {
  $log = "$PSScriptRoot\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log"
  "$(Get-Date -Format o) [run-forever] starting bridge" | Add-Content $log
  # Run attached; when the process dies for any reason, wait and restart.
  & node bridge.js 2>&1 | Add-Content $log
  "$(Get-Date -Format o) [run-forever] bridge exited (code $LASTEXITCODE) - restarting in 30s" | Add-Content $log
  Start-Sleep -Seconds 30
}
