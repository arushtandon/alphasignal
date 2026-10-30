# Starts the paper bridge supervisor when it is not already running.
# Task Scheduler calls this every minute so a closed console does not leave
# the bridge down. run-forever.ps1 also holds Global\AlphaSignalPaperBridge,
# so a second copy exits immediately even if this check races.

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and (
    ($_.CommandLine -match 'run-forever\.ps1' -and $_.CommandLine -notmatch 'run-forever-live') -or
    ($_.Name -match '^(node|nodejs)\.exe$' -and $_.CommandLine -match 'bridge\.js' -and $_.CommandLine -notmatch 'bridge\.js.*\blive\b')
  )
}
if ($running) { exit 0 }
$mutexHeld = $false
foreach ($name in @('Global\AlphaSignalPaperBridge', 'Local\AlphaSignalPaperBridge')) {
  $probe = $null
  try {
    $probe = New-Object System.Threading.Mutex($false, $name)
    if (-not $probe.WaitOne(0)) { $mutexHeld = $true }
    else { [void]$probe.ReleaseMutex() }
  } catch {}
  finally { if ($probe) { $probe.Dispose() } }
  if ($mutexHeld) { exit 0 }
}
Start-Process powershell -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $Root 'run-forever.ps1')
) -WorkingDirectory $Root -WindowStyle Hidden
exit 0
