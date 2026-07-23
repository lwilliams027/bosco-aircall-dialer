@echo off
setlocal
set PORT=9222
set EXE=C:\Users\LandonWiliams\AppData\Local\AircallWorkspace\AircallWorkspace.exe

echo ================================================================
echo  Aircall auto-fill
echo  This connects Aircall to the Bosco dialer queue.
echo ================================================================
echo.

rem --- already running with the debug port open? then just connect ---
powershell -NoProfile -Command "try{Invoke-RestMethod http://127.0.0.1:%PORT%/json -TimeoutSec 2 | Out-Null; exit 0}catch{exit 1}"
if %errorlevel%==0 goto inject

echo Aircall needs to be RESTARTED once so it can be automated.
echo    - Finish/hang up any active call first.
echo    - Then press any key to restart Aircall, or close this window to cancel.
pause >nul

taskkill /IM AircallWorkspace.exe /F >nul 2>&1
timeout /t 2 >nul
start "" "%EXE%" --remote-debugging-port=%PORT%
echo Starting Aircall... (log back in if it asks)
timeout /t 7 >nul

:inject
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0aircall-inject.ps1" -Port %PORT%
echo.
echo Watcher stopped. You can close this window.
pause >nul
