@echo off
setlocal
rem v3.3 compatibility launcher.
rem DO NOT start daily Microsoft Edge with remote debugging.
rem This command now starts the project-managed isolated Chrome/Chrome-for-Testing profile.

echo [v3.3] Starting dedicated Nexus automation browser...
node "%~dp0browser-manager.js" start
if errorlevel 1 (
    echo.
    echo Failed to start the managed automation browser.
    echo If BROWSER_PROFILE_MISMATCH is shown, close the browser currently using CDP port 9222.
    echo Then open your daily Edge normally ^(without remote debugging^) and retry.
    exit /b 1
)

echo.
echo Dedicated automation browser is ready. Keep it open in the background.
echo Your normal Microsoft Edge is not controlled by this project.
exit /b 0
