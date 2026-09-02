@echo off
setlocal
rem Start the isolated browser session required by nexus-autodl.js.
rem A normal Edge window is not a substitute for CDP on port 9222.

set "EDGE=%MO2_EDGE%"
if not defined EDGE set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
    echo Edge executable not found: %EDGE%
    echo Set MO2_EDGE to the full path of msedge.exe and retry.
    exit /b 1
)

set "USER_DATA=%MO2_EDGE_USERDATA%"
if not defined USER_DATA set "USER_DATA=%USERPROFILE%\.claude\nexus-autodl-edge"

rem Check the actual CDP endpoint instead of tasklist, because regular Edge
rem may already be running without the remote debugging port.
powershell.exe -NoProfile -NonInteractive -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >NUL 2>&1
if "%ERRORLEVEL%"=="0" (
    echo Nexus CDP session is already running on 127.0.0.1:9222.
    exit /b 0
)

echo Starting isolated Edge with CDP 9222...
start "" "%EDGE%" --user-data-dir="%USER_DATA%" --remote-debugging-port=9222 --disable-extensions --no-first-run --no-default-browser-check --new-window "https://www.nexusmods.com/users/sign-in"
echo Log in to Nexus in the new window, then keep it open while using nexus-autodl.js.
exit /b 0
