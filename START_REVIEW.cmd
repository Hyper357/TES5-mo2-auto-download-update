@echo off
setlocal EnableExtensions EnableDelayedExpansion
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
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found.
  echo.
  pause
  exit /b 1
)

echo [1/3] Updating repository...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Git update failed. No local files were overwritten.
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
    echo.
    pause
    exit /b 1
  )
) else (
  echo Dependencies already installed.
)

echo.
echo [3/3] Locating and opening Review Center...
set "RUN_DIR="

rem First prefer a run in this repository.
if exist ".runtime\runs" (
  for /f "delims=" %%R in ('dir /b /ad /o-n ".runtime\runs" 2^>nul') do (
    if not defined RUN_DIR if exist ".runtime\runs\%%R\review-center.json" set "RUN_DIR=%CD%\.runtime\runs\%%R"
  )
)

rem Fresh/push clones do not contain .runtime. Search the Skyrim workspace two levels up.
if not defined RUN_DIR (
  for %%W in ("%~dp0..\..") do set "SEARCH_ROOT=%%~fW"
  echo No local run found. Searching !SEARCH_ROOT! for an existing project runtime...

  for /d %%A in ("!SEARCH_ROOT!\*") do (
    if exist "%%~fA\.runtime\runs" (
      for /f "delims=" %%R in ('dir /b /ad /o-n "%%~fA\.runtime\runs" 2^>nul') do (
        if not defined RUN_DIR if exist "%%~fA\.runtime\runs\%%R\review-center.json" set "RUN_DIR=%%~fA\.runtime\runs\%%R"
      )
    )
    for /d %%B in ("%%~fA\*") do (
      if exist "%%~fB\.runtime\runs" (
        for /f "delims=" %%R in ('dir /b /ad /o-n "%%~fB\.runtime\runs" 2^>nul') do (
          if not defined RUN_DIR if exist "%%~fB\.runtime\runs\%%R\review-center.json" set "RUN_DIR=%%~fB\.runtime\runs\%%R"
        )
      )
    )
  )
)

if not defined RUN_DIR (
  echo.
  echo [ERROR] No existing Review Center run was found under the Skyrim workspace.
  echo The old runtime may have been deleted or stored outside this workspace.
  echo Send this window to ChatGPT; do not run a full rescan yet.
  echo.
  pause
  exit /b 1
)

echo Found Review Center run:
echo !RUN_DIR!
echo.
echo Opening current Review Center UI. Keep this window open.
node scripts\review-server.js --run "!RUN_DIR!"

echo.
echo Review Center stopped.
pause
