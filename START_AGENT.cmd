@echo off
setlocal EnableExtensions
title TES5 MO2 Agent Bootstrap
cd /d "%~dp0"

echo.
echo ===============================================
echo   TES5 MO2 - Agent Bootstrap
echo ===============================================
echo.

if not exist package.json (
  echo [ERROR] package.json not found.
  echo Put this file in the repository root.
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

node scripts\agent-bootstrap.js
if errorlevel 1 (
  echo.
  echo [ERROR] Agent bootstrap stopped safely.
  echo Read the error above or send this window to your AI agent.
  echo No hard reset was performed.
  echo.
  pause
  exit /b 1
)

echo.
echo Agent bootstrap ready.
echo Keep this window if you want to copy the compact status to an AI agent.
echo.
pause
