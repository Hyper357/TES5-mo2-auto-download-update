@echo off
setlocal
node "%~dp0browser-manager.js" start
exit /b %ERRORLEVEL%
