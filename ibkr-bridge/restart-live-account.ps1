$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

# Admin restart for the LIVE supervisor only. Paper run-forever.ps1 is left alone.
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and (
    ($_.Name -match '^(node|nodejs)\.exe$' -and $_.CommandLine -match '[\\/]ibkr-bridge[\\/]bridge\.js["\s]+live') -or
    ($_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -match '[\\/]ibkr-bridge[\\/]run-forever-live\.ps1')
  )
}

$targets | Sort-Object { if ($_.Name -match 'node') { 0 } else { 1 } } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

$runner = Join-Path $Root "run-forever-live.ps1"
Start-Process powershell.exe -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$runner`""
) -WorkingDirectory $Root

Write-Host "AlphaSignal LIVE bridge restarted from $runner" -ForegroundColor Green
