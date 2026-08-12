# Restart AlphaSignal IBKR bridge (kills old node bridge, starts run-forever).
# Run in PowerShell from anywhere:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\tando\Downloads\alphasignal-repo\ibkr-bridge\restart-bridge.ps1"

$ErrorActionPreference = "Continue"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host ""
Write-Host "=== AlphaSignal IBKR bridge restart ===" -ForegroundColor Cyan
Write-Host "Folder: $Root"
Write-Host ""

# 1) Stop ALL bridge supervisors + node workers for this folder.
#    Duplicate run-forever.ps1 windows fight over clientId → disconnect loop.
Write-Host "Stopping old bridge / run-forever processes..."
function Stop-BridgeProcs {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and (
        ($_.Name -match '^(node|nodejs)\.exe$' -and $_.CommandLine -match 'bridge\.js') -or
        ($_.CommandLine -match 'run-forever\.ps1')
      )
    } |
    ForEach-Object {
      Write-Host ("  kill PID {0}: {1}" -f $_.ProcessId, $_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length)))
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Stop-BridgeProcs
Start-Sleep -Seconds 4
# Second pass — leftover supervisors sometimes respawn a node during the sleep.
Write-Host "Second pass for leftovers..."
Stop-BridgeProcs
Start-Sleep -Seconds 2

# 2) Pull latest bridge.js from git (optional — ignore failures)
if (Test-Path (Join-Path $Root "..\.git")) {
  Write-Host "Pulling latest main (bridge code)..."
  Push-Location (Join-Path $Root "..")
  git pull origin main 2>&1 | Out-Host
  Pop-Location
}

# 3) Ensure Gateway/TWS is up (port from run-forever: 4002)
$port = 4002
$tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue
if (-not $tcp.TcpTestSucceeded) {
  Write-Host ""
  Write-Host "WARNING: nothing listening on 127.0.0.1:$port (IB Gateway paper)." -ForegroundColor Yellow
  Write-Host "Start IB Gateway (paper) with API enabled, then re-run this script." -ForegroundColor Yellow
  Write-Host ""
}

# 4) Start supervisor in a new window
$runner = Join-Path $Root "run-forever.ps1"
Write-Host "Starting run-forever.ps1 in a new window..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", $runner
) -WorkingDirectory $Root

Write-Host ""
Write-Host "Bridge restart launched." -ForegroundColor Green
Write-Host "Tail logs with:"
Write-Host ("  Get-Content `"$Root\logs\bridge-{0}.log`" -Tail 50 -Wait" -f (Get-Date -Format 'yyyy-MM-dd'))
Write-Host ""
Write-Host "Non-model (IB-only) positions:"
Write-Host "  • If market is OPEN  → flattened with MKT"
Write-Host "  • If market is CLOSED → OPG queued for next open (HK/JP/EU/US)"
Write-Host "Model lots (9988, DHL, etc.) are NOT flattened."
Write-Host ""
