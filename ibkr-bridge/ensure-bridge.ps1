# Starts the paper bridge supervisor when it is not already running.
# Task Scheduler calls this every minute so a closed console does not leave
# the bridge down. It does not start a second copy.

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and (
    ($_.CommandLine -match 'run-forever\.ps1' -and $_.CommandLine -notmatch 'run-forever-live') -or
    ($_.Name -match '^(node|nodejs)\.exe$' -and $_.CommandLine -match 'bridge\.js' -and $_.CommandLine -notmatch 'bridge\.js.*\blive\b')
  )
}
if ($running) { exit 0 }
Start-Process powershell -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $Root 'run-forever.ps1')
) -WorkingDirectory $Root -WindowStyle Hidden
exit 0
