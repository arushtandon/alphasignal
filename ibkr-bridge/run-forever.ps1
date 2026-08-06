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
# Portfolio marks (updatePortfolio) are the primary MTM source. Tick MD type
# is secondary — 3=delayed is fine when TWS already holds the live MD slot.
$env:IBKR_MARKET_DATA_TYPE = "3"

New-Item -ItemType Directory -Force -Path "$PSScriptRoot\logs" | Out-Null

Write-Host "AlphaSignal IBKR bridge supervisor"
Write-Host "Logs go to: $PSScriptRoot\logs\bridge-YYYY-MM-DD.log"
Write-Host "Live tail in another window:"
Write-Host "  Get-Content .\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log -Tail 50 -Wait"
Write-Host ""

while ($true) {
  $log = "$PSScriptRoot\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log"
  $stamp = Get-Date -Format o
  # Don't hold an exclusive lock on the log (cmd >> was blocking restarts).
  try { Add-Content -Path $log -Value "$stamp [run-forever] starting bridge" -ErrorAction SilentlyContinue } catch {}
  Write-Host "$stamp starting bridge -> $log  (this window stays quiet; watch the log file)"
  # bridge.js appendFileSyncs its own log; keep console quiet
  $p = Start-Process -FilePath "node" -ArgumentList "bridge.js" -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden
  Wait-Process -Id $p.Id
  $code = $p.ExitCode
  try { Add-Content -Path $log -Value "$(Get-Date -Format o) [run-forever] bridge exited (code $code) - restarting in 30s" -ErrorAction SilentlyContinue } catch {}
  Write-Host "$(Get-Date -Format o) bridge exited (code $code) - restarting in 30s"
  Start-Sleep -Seconds 30
}
