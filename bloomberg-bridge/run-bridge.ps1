# Run Bloomberg HTTP bridge from THIS folder (fixes "path not found" if cwd was wrong).
# Python: tries "py -3" first (Windows launcher), then "python", then "python3".
#
# Usage — open PowerShell in the folder that contains this file, then:
#   powershell -ExecutionPolicy Bypass -File .\run-bridge.ps1
#
# Optional (same window, before running):
#   $env:BRIDGE_BIND = "0.0.0.0"
#   $env:BRIDGE_PORT = "5055"
#   $env:BLOOMBERG_BRIDGE_SECRET = "S@FRON1490"

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

function Test-Py3 {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 -c "import sys; assert sys.version_info >= (3, 9); print(sys.executable)"
        if ($LASTEXITCODE -eq 0) { return "py" }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        & python -c "import sys; assert sys.version_info >= (3, 9); print(sys.executable)"
        if ($LASTEXITCODE -eq 0) { return "python" }
    }
    if (Get-Command python3 -ErrorAction SilentlyContinue) {
        & python3 -c "import sys; assert sys.version_info >= (3, 9); print(sys.executable)"
        if ($LASTEXITCODE -eq 0) { return "python3" }
    }
    return $null
}

function Invoke-Py3 {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    switch ($script:PyKind) {
        "py" { & py -3 @Args; break }
        "python" { & python @Args; break }
        "python3" { & python3 @Args; break }
        default { throw "Python launcher not set" }
    }
}

$script:PyKind = Test-Py3
if ($null -eq $script:PyKind) {
    Write-Host ""
    Write-Host "No usable Python 3.9+ found." -ForegroundColor Red
    Write-Host "Install Python, check 'Add to PATH', then open a NEW PowerShell window:" -ForegroundColor Yellow
    Write-Host "  https://www.python.org/downloads/"
    Write-Host "Or Microsoft Store: Python 3.12"
    Write-Host ""
    exit 1
}

Write-Host "Using launcher: $script:PyKind" -ForegroundColor Green
Invoke-Py3 -c "import sys; print(sys.executable); print(sys.version)"

$venvPy = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPy)) {
    Write-Host "Creating .venv ..." -ForegroundColor Cyan
    Invoke-Py3 -m venv ".venv"
    if (-not (Test-Path -LiteralPath $venvPy)) {
        Write-Host "Failed to create .venv" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Installing Bloomberg blpapi (required for pdblp) ..." -ForegroundColor Cyan
& $venvPy -m pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi
if ($LASTEXITCODE -ne 0) {
    Write-Host "blpapi install failed — see README (network/VPN/Python version)." -ForegroundColor Red
    exit 1
}

Write-Host "pip install -r requirements.txt ..." -ForegroundColor Cyan
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r (Join-Path $Root "requirements.txt")

Write-Host "Starting bridge (Ctrl+C to stop) ..." -ForegroundColor Green
& $venvPy (Join-Path $Root "bridge.py")
