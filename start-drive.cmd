@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul || (
  echo 请先安装 Node.js 22.11 或更高的 LTS 版本。
  pause
  exit /b 1
)
if not exist "node_modules\express\package.json" (
  call npm.cmd ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm.cmd start
if errorlevel 1 pause
