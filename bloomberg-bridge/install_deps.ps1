#Requires -Version 5.1
# Install Bloomberg bridge deps without building NumPy from source (no MSVC required).
# Run from bloomberg-bridge:  powershell -ExecutionPolicy Bypass -File .\install_deps.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Upgrading pip…"
python -m pip install --upgrade pip setuptools wheel

Write-Host "Installing NumPy + Pandas from wheels only (no compilers)…"
python -m pip install numpy "pandas>=2.0,<3" "--only-binary=:all:"

Write-Host "Installing Flask + pdblp…"
python -m pip install "flask>=3.0" "pdblp>=0.1.3"

Write-Host ""
Write-Host "Install Bloomberg blpapi if you have not already:"
Write-Host '  pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi'
Write-Host ""
Write-Host "Smoke test (NumPy + pandas from wheels):"
python -c "import numpy, pandas as pd; print('numpy', numpy.__version__, '| pandas', pd.__version__)"
Write-Host "If `from pdblp import BCon` fails, install Bloomberg blpapi first (see requirements.txt header)."
Write-Host "Done."
