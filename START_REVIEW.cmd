@echo off
setlocal
chcp 65001 >nul
title TES5 MO2 - One Click Review Center
cd /d "%~dp0"

echo.
echo ===============================================
echo   TES5 MO2 - One Click Review Center
echo ===============================================
echo.

if not exist package.json (
  echo [ERROR] 没找到 package.json。
  echo 请把这个文件放在 TES5-mo2-auto-download-update 项目根目录。
  echo.
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 没找到 Git。请确认 Git for Windows 已安装。
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 没找到 Node.js。请确认 Node.js 已安装。
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 没找到 npm。请确认 Node.js/npm 已安装。
  echo.
  pause
  exit /b 1
)

echo [1/3] 更新项目代码...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Git 更新失败。没有自动覆盖本地修改。
  echo 请把这个窗口截图发给 ChatGPT。
  echo.
  pause
  exit /b 1
)

echo.
echo [2/3] 检查依赖...
if not exist node_modules\puppeteer-core\package.json (
  call npm ci
  if errorlevel 1 (
    echo.
    echo [ERROR] npm 依赖安装失败。
    echo 请把这个窗口截图发给 ChatGPT。
    echo.
    pause
    exit /b 1
  )
) else (
  echo 依赖已存在，跳过 npm ci。
)

echo.
echo [3/3] 打开最新版 Review Center...
echo 浏览器会自动打开。这个窗口保持开启即可。
echo.
call npm run review

echo.
echo Review Center 已停止。
pause
