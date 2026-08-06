# Keeps the AlphaSignal -> IBKR bridge running: restarts it automatically if it
# crashes or the PC reboots (when registered as a scheduled task - see README).
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

Write-Host "AlphaSignal IBKR bridge supervisor"
Write-Host "Logs go to: $PSScriptRoot\logs\bridge-YYYY-MM-DD.log"
Write-Host "Live tail in another window:"
Write-Host "  Get-Content .\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log -Tail 50 -Wait"
Write-Host ""

while ($true) {
  $log = "$PSScriptRoot\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log"
  $stamp = Get-Date -Format o
  Add-Content $log "$stamp [run-forever] starting bridge"
  Write-Host "$stamp starting bridge -> $log  (this window stays quiet; watch the log file)"
  # cmd-style redirection keeps the log readable (shared-read) while running,
  # so Get-Content -Tail -Wait works from another window.
  cmd /c "node bridge.js >> `"$log`" 2>&1"
  Add-Content $log "$(Get-Date -Format o) [run-forever] bridge exited (code $LASTEXITCODE) - restarting in 30s"
  Write-Host "$(Get-Date -Format o) bridge exited - restarting in 30s"
  Start-Sleep -Seconds 30
}
