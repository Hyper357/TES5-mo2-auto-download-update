@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0send-nxm-to-mo2.ps1" %*
if errorlevel 1 pause
endlocal
