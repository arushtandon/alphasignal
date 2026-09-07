# Live-account supervisor. Does NOT replace paper run-forever.ps1.
# Weekend default is DRY RUN. Arm Monday before 06:00 SGT with IBKR_LIVE_ARM=1
# in local-secrets.ps1, then Admin-run restart-live-account.ps1.
#
#   powershell -ExecutionPolicy Bypass -File run-forever-live.ps1
#
# Logs: ibkr-bridge\logs\bridge-live-YYYY-MM-DD.log

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$env:ALPHASIGNAL_URL = "https://alphasignal-dvg5.onrender.com"
$env:IBKR_PORT       = "4001"        # 4001 = IB Gateway live (paper stays 4002)
$env:IBKR_BRIDGE_ROLE = "live"
$env:STATE_FILE      = Join-Path $PSScriptRoot "bridge-state-live.json"
$env:STATE_DB_FILE   = Join-Path $PSScriptRoot "bridge-state-live.sqlite"
$env:IBKR_CLIENT_ID  = "27"
$env:IBKR_EXEC_POOL_SIZE = "20"
$env:IBKR_EXEC_POOL_START = "30"
$env:IBKR_MARKET_DATA_TYPE = "3"
$env:IBKR_RECON_MS = "900000"

$secrets = Join-Path $PSScriptRoot "local-secrets.ps1"
if (Test-Path $secrets) {
  . $secrets
  Write-Host "Loaded local-secrets.ps1 (Telegram=$(if ($env:TELEGRAM_BOT_TOKEN -and $env:TELEGRAM_CHAT_ID) { 'configured' } else { 'incomplete' }))"
}

if (-not $env:IBKR_LIVE_ACCOUNT -or $env:IBKR_LIVE_ACCOUNT -match '^DU') {
  Write-Host "IBKR_LIVE_ACCOUNT must be the live U… id in local-secrets.ps1. Refusing to start." -ForegroundColor Red
  exit 2
}
$env:IBKR_ACCOUNT = $env:IBKR_LIVE_ACCOUNT.Trim().ToUpper()

# Live stays blank until an explicit go-ahead. ARM alone cannot place orders.
$env:IBKR_DRY_RUN = "1"
if ($env:IBKR_LIVE_GOAHEAD -eq "1" -and $env:IBKR_LIVE_ARM -eq "1") {
  $env:IBKR_DRY_RUN = "0"
  Write-Host "LIVE GO-AHEAD + ARM — this process will place REAL orders on $($env:IBKR_ACCOUNT)" -ForegroundColor Yellow
} else {
  if ($env:IBKR_LIVE_ARM -eq "1") {
    Write-Host "IBKR_LIVE_ARM ignored — live stays blank until go-ahead (IBKR_LIVE_GOAHEAD=1)." -ForegroundColor Yellow
  }
  $env:IBKR_LIVE_ARM = "0"
  Write-Host "Live bridge is BLANK / DRY RUN. No live orders until you give a go-ahead." -ForegroundColor Cyan
}

function Get-IbkrLatestSeq {
  try {
    $uri = "$($env:ALPHASIGNAL_URL.TrimEnd('/'))/api/ibkr/status"
    $headers = @{}
    if ($env:IBKR_EVENTS_TOKEN) { $headers.Authorization = "Bearer $($env:IBKR_EVENTS_TOKEN)" }
    $st = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 15
    return [int]$st.latestSeq
  } catch {
    Write-Host "WARN: could not read latestSeq ($($_.Exception.Message))" -ForegroundColor Yellow
    return 0
  }
}

$stateFile = $env:STATE_FILE
if (-not (Test-Path $stateFile)) {
  $seq = Get-IbkrLatestSeq
  if ($seq -lt 1) { $seq = 1 }
  $env:IBKR_SINCE_SEQ = [string]$seq
  $seed = @{ since = $seq; byKey = @{}; pendingReports = @(); orderClients = @{}; liveAccount = $env:IBKR_ACCOUNT; seededAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json -Depth 4
  Set-Content -Path $stateFile -Value $seed -Encoding utf8
  Write-Host "Seeded empty live state since=$seq account=$($env:IBKR_ACCOUNT)"
} elseif (-not $env:IBKR_SINCE_SEQ) {
  try {
    $existing = Get-Content $stateFile -Raw | ConvertFrom-Json
    if (-not $existing.since -or [int]$existing.since -le 0) {
      $seq = Get-IbkrLatestSeq
      if ($seq -gt 0) { $env:IBKR_SINCE_SEQ = [string]$seq }
    }
  } catch {}
}

New-Item -ItemType Directory -Force -Path "$PSScriptRoot\logs" | Out-Null

$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { $node = "node" }

Write-Host "AlphaSignal IBKR LIVE bridge supervisor"
Write-Host "account=$($env:IBKR_ACCOUNT) port=$($env:IBKR_PORT) dry=$($env:IBKR_DRY_RUN)"
Write-Host "state=$stateFile"
Write-Host "Logs: $PSScriptRoot\logs\bridge-live-YYYY-MM-DD.log"
Write-Host ""

while ($true) {
  $log = "$PSScriptRoot\logs\bridge-live-$(Get-Date -Format 'yyyy-MM-dd').log"
  $stamp = Get-Date -Format o
  try { Add-Content -Path $log -Value "$stamp [run-forever-live] starting bridge" -ErrorAction SilentlyContinue } catch {}
  Write-Host "$stamp starting LIVE bridge -> $log"
  & $node "$PSScriptRoot\bridge.js" live
  $code = $LASTEXITCODE
  try { Add-Content -Path $log -Value "$(Get-Date -Format o) [run-forever-live] bridge exited (code $code) - restarting in 30s" -ErrorAction SilentlyContinue } catch {}
  Write-Host "$(Get-Date -Format o) live bridge exited (code $code) - restarting in 30s"
  Start-Sleep -Seconds 30
}
