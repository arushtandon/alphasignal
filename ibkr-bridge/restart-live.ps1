$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

# This script must run elevated because the existing bridge was launched as
# Administrator. Stop every supervisor first so two bridges cannot trade.
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and (
    ($_.Name -match '^(node|nodejs)\.exe$' -and $_.CommandLine -match '[\\/]ibkr-bridge[\\/]bridge\.js') -or
    ($_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -match '[\\/]ibkr-bridge[\\/]run-forever\.ps1')
  )
}

$targets | Sort-Object { if ($_.Name -match 'node') { 0 } else { 1 } } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

$runner = Join-Path $Root "run-forever.ps1"
Start-Process powershell.exe -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$runner`""
) -WorkingDirectory $Root

Write-Host "AlphaSignal bridge restarted from $runner" -ForegroundColor Green
