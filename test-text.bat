@echo off
setlocal
echo ================================================================
echo  Aircall TEXT tester  (uses the running bridge on port 8123)
echo  Make sure aircall-autofill.bat is running first.
echo ================================================================
echo.
set /p NUM=Phone number (+1XXXXXXXXXX):
set /p MSG=Message (leave blank for default):
if "%MSG%"=="" set MSG=Test message from the dialer
echo.
echo Sending to %NUM% ...
powershell -NoProfile -Command "$b=@{number='%NUM%';message='%MSG%'} | ConvertTo-Json -Compress; try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8123/text' -Method Post -Body $b -TimeoutSec 40; Write-Host ('RESULT: ' + $r) -ForegroundColor Yellow } catch { Write-Host ('Bridge not reachable (is aircall-autofill.bat running?): ' + $_.Exception.Message) -ForegroundColor Red }"
echo.
pause
