@echo off
:: Run this ONCE as Administrator to allow your phone to reach the dialer control page.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   This must be run as ADMINISTRATOR.
  echo   Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)
echo Adding URL reservation for port 8123 ...
netsh http add urlacl url=http://+:8123/ user=Everyone
echo.
echo Adding firewall rule for port 8123 ...
netsh advfirewall firewall add rule name="Aircall Dialer Control 8123" dir=in action=allow protocol=TCP localport=8123
echo.
echo Done. Now run start-dialer.bat normally - it will print the
echo phone URL, e.g.  http://192.168.1.50:8123/
echo Open that on your phone (same Wi-Fi).
echo.
pause
