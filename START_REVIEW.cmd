@echo off
setlocal
title TES5 MO2 Review Center
cd /d "%~dp0"

echo.
echo ===============================================
echo   TES5 MO2 - One Click Review Center
echo ===============================================
echo.

if not exist package.json (
  echo [ERROR] package.json not found.
  echo Put this file in the repository root, next to package.json.
  echo.
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git not found.
  echo Install Git for Windows first.
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install Node.js first.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found.
  echo Install Node.js/npm first.
  echo.
  pause
  exit /b 1
)

echo [1/3] Updating repository...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Git update failed.
  echo No local files were overwritten.
  echo Send a screenshot of this window to ChatGPT.
  echo.
  pause
  exit /b 1
)

echo.
echo [2/3] Checking dependencies...
if not exist node_modules\puppeteer-core\package.json (
  call npm ci
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo Send a screenshot of this window to ChatGPT.
    echo.
    pause
    exit /b 1
  )
) else (
  echo Dependencies already installed.
)

echo.
echo [3/3] Opening Review Center...
echo Keep this window open while using the browser.
echo.
call npm run review

echo.
echo Review Center stopped.
pause
