@echo off
setlocal EnableExtensions

REM Run from Command Prompt OR double-click. Always uses THIS folder (%~dp0).
REM Edit BLOOMBERG_BRIDGE_SECRET below to match your AlphaSignal server.

cd /d "%~dp0"

if not exist "bridge.py" (
  echo ERROR: bridge.py not found in:
  cd
  pause
  exit /b 1
)

set BRIDGE_BIND=0.0.0.0
set BRIDGE_PORT=5055
set BLOOMBERG_BRIDGE_SECRET=REPLACE-WITH-YOUR-LONG-RANDOM-SECRET

echo.
echo Working folder:
cd
echo.

where py>nul 2>nul
if %errorlevel% equ 0 goto HAVE_PY

where python>nul 2>nul
if %errorlevel% equ 0 goto HAVE_PYTHON

echo ERROR: Neither "py" nor "python" found. Install Python from python.org ^(tick "Add to PATH"^).
pause
exit /b 1

:HAVE_PY
set VENVCMD=py -3 -m venv .venv
goto MKVENV

:HAVE_PYTHON
set VENVCMD=python -m venv .venv

:MKVENV
if exist ".venv\Scripts\python.exe" goto SKIPVENV

echo Creating virtual environment (.venv^)...
%VENVCMD%
if errorlevel 1 (
  echo venv creation failed.
  pause
  exit /b 1
)

:SKIPVENV

".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 pause & exit /b 1

echo Installing Bloomberg Python API ^(blpapi^) from Bloomberg pip — required even if Terminal is open...
".venv\Scripts\python.exe" -m pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi
if errorlevel 1 (
  echo blpapi install failed — check network / VPN; see bloomberg-bridge\README.md
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 pause & exit /b 1

echo.
echo Bloomberg bridge starting — BRIDGE_BIND=%BRIDGE_BIND% PORT=%BRIDGE_PORT%
echo Test: http://127.0.0.1:%BRIDGE_PORT%/health
echo Press Ctrl+C to stop.
echo.

".venv\Scripts\python.exe" "%~dp0bridge.py"
pause
