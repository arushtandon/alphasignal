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
$env:IBKR_BRIDGE_ROLE = "paper"
$env:SETUP_BOOK_ENABLED = "1"
$env:SETUP_BOOK_PAPER_EXECUTION = "1"
$env:CAPITAL_POOL_ENABLED = "1"
# Avoid clientId 17 — a stuck elevated node often holds it (Access Denied to kill).
# flatten-all.js uses 18; keep bridge manager on 27. Execution workers 30-49
# (20 sockets including 27). One-shots 19/25-26/28-29 stay reserved.
$env:IBKR_CLIENT_ID  = "27"
$env:IBKR_EXEC_POOL_SIZE = "20"
$env:IBKR_EXEC_POOL_START = "30"
# Portfolio marks (updatePortfolio) are the primary MTM source. Tick MD type
# is secondary — 3=delayed is fine when TWS already holds the live MD slot.
$env:IBKR_MARKET_DATA_TYPE = "3"
# Full IB↔AS reconcile + Telegram risk digest (default 15 minutes).
$env:IBKR_RECON_MS = "900000"
# Telegram risk alerts (untracked IB, unfilled RTH orders, recon errors,
# Gateway down >5 min).
# Prefer local-secrets.ps1 (gitignored) so the bot token is never committed.
# Or uncomment placeholders below for a one-off local run:
# $env:TELEGRAM_BOT_TOKEN = "123456:ABC..."
# $env:TELEGRAM_CHAT_ID   = "123456789"
# $env:TELEGRAM_ALERTS    = "1"
$secrets = Join-Path $PSScriptRoot "local-secrets.ps1"
if (Test-Path $secrets) {
  . $secrets
  Write-Host "Loaded local-secrets.ps1 (Telegram=$(if ($env:TELEGRAM_BOT_TOKEN -and $env:TELEGRAM_CHAT_ID) { 'configured' } else { 'incomplete' }))"
}

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

# Disk-integrity check at every start: record the git commit the bridge runs
# from, and alert when ibkr-bridge/ on disk differs from HEAD (an editor or
# sync tool writing back a stale copy would otherwise run unnoticed).
$repoRoot = Split-Path $PSScriptRoot -Parent
function Get-BridgeTreeState {
  $state = @{ commit = "unknown"; dirty = ""; error = $null }
  try {
    $state.commit = (& git -C $repoRoot rev-parse --short HEAD 2>$null | Select-Object -First 1)
    if (-not $state.commit) { $state.commit = "unknown" }
    $diff = & git -C $repoRoot diff HEAD --stat -- ibkr-bridge/ 2>$null
    $state.dirty = (($diff | Where-Object { $_ -and $_.Trim() }) -join "; ")
  } catch { $state.error = $_.Exception.Message }
  return $state
}
function Send-BridgeAlert([string]$text) {
  if (-not ($env:TELEGRAM_BOT_TOKEN -and $env:TELEGRAM_CHAT_ID)) { return }
  try {
    & $node -e "require(process.argv[1]).sendTelegramAlert(process.argv[2]).catch(e => { console.error(e.message); process.exit(1); })" -- "$PSScriptRoot\telegram.js" $text 2>&1 | Out-Null
  } catch {}
}
function Test-ClientIdConflict([int]$code, [string]$logPath) {
  if ($code -eq 75) { return $true }
  if (-not (Test-Path $logPath)) { return $false }
  $tail = Get-Content $logPath -Tail 40 -ErrorAction SilentlyContinue
  return [bool]($tail | Where-Object { $_ -match 'already in use|nextValidId timeout|clientId .* in use' })
}
function Stop-StaleBridgeNodes {
  $killed = @()
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $cmd = [string]$p.CommandLine
    if ($cmd -notmatch 'bridge\.js') { continue }
    if ($p.ProcessId -eq $PID) { continue }
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      $killed += $p.ProcessId
    } catch {}
  }
  return $killed
}

$clientIdFails = 0
$gatewayDownSince = $null
$gatewayAlertedAt = $null
function Test-GatewayListening {
  $port = 0
  [void][int]::TryParse($env:IBKR_PORT, [ref]$port)
  if ($port -le 0) { $port = 4002 }
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $wait = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $wait.AsyncWaitHandle.WaitOne(1500, $false) -and $client.Connected
    return $ok
  } catch { return $false }
  finally { if ($client) { $client.Close() } }
}
function Update-GatewayDownAlert {
  if (Test-GatewayListening) {
    if ($script:gatewayAlertedAt) {
      Send-BridgeAlert "GATEWAY BACK: 127.0.0.1:$($env:IBKR_PORT) is accepting again."
    }
    $script:gatewayDownSince = $null
    $script:gatewayAlertedAt = $null
    return
  }
  if (-not $script:gatewayDownSince) { $script:gatewayDownSince = Get-Date }
  $downMin = [int]((Get-Date) - $script:gatewayDownSince).TotalMinutes
  if ($downMin -lt 10) { return }
  $sinceAlert = if ($script:gatewayAlertedAt) { ((Get-Date) - $script:gatewayAlertedAt).TotalMinutes } else { 999 }
  if ($sinceAlert -lt 30) { return }
  $script:gatewayAlertedAt = Get-Date
  Send-BridgeAlert "GATEWAY DOWN: bridge supervisor is up but nothing is accepting on 127.0.0.1:$($env:IBKR_PORT) for $downMin min. IB Gateway paper is not logged in."
}
while ($true) {
  $log = "$PSScriptRoot\logs\bridge-$(Get-Date -Format 'yyyy-MM-dd').log"
  $stamp = Get-Date -Format o
  $tree = Get-BridgeTreeState
  $dirtyFlag = if ($tree.dirty) { "DIRTY" } else { "clean" }
  try { Add-Content -Path $log -Value "$stamp [run-forever] starting bridge commit=$($tree.commit) ibkr-bridge/=$dirtyFlag $($tree.dirty)" -ErrorAction SilentlyContinue } catch {}
  Write-Host "$stamp starting bridge -> $log (commit $($tree.commit), ibkr-bridge/ $dirtyFlag)"
  if ($tree.dirty) {
    Send-BridgeAlert "BRIDGE TREE DIRTY at start (commit $($tree.commit)): ibkr-bridge/ differs from HEAD - $($tree.dirty)"
  }
  # Run in THIS process (not Start-Process). Start-Process was reporting exit
  # code 0 within ~1s while marks still came from a leftover node, or killing
  # the supervisor loop while a zombie held clientId 17.
  & $node "$PSScriptRoot\bridge.js"
  $code = $LASTEXITCODE
  $clientIdConflict = Test-ClientIdConflict $code $log
  if ($clientIdConflict) {
    $clientIdFails += 1
    $killed = Stop-StaleBridgeNodes
    $steps = @(30, 60, 120, 300)
    $wait = $steps[[Math]::Min($clientIdFails - 1, $steps.Length - 1)]
    $note = "clientId in use (fail $clientIdFails) killed=$($killed -join ',') restarting in ${wait}s"
    try { Add-Content -Path $log -Value "$(Get-Date -Format o) [run-forever] bridge exited (code $code) - $note" -ErrorAction SilentlyContinue } catch {}
    Write-Host "$(Get-Date -Format o) $note"
    if ($clientIdFails -ge 5 -and ($clientIdFails % 5) -eq 0) {
      Send-BridgeAlert "BRIDGE CRASH LOOP: clientId in use, $clientIdFails failed starts. Stale node kill attempted ($($killed -join ',')). Backing off ${wait}s."
    }
  } else {
    $clientIdFails = 0
    $wait = 30
    try { Add-Content -Path $log -Value "$(Get-Date -Format o) [run-forever] bridge exited (code $code) - restarting in ${wait}s" -ErrorAction SilentlyContinue } catch {}
    Write-Host "$(Get-Date -Format o) bridge exited (code $code) - restarting in ${wait}s"
  }
  Update-GatewayDownAlert
  Start-Sleep -Seconds $wait
}
