@echo off
chcp 65001 >nul
title Funbox 監控(關閉此視窗即停止)
cd /d "%~dp0"
if not exist poller\local.env (
  echo 找不到 poller\local.env,請先複製 poller\local.env.example 並填好設定。
  pause
  exit /b 1
)
if not exist poller\node_modules\playwright-core (
  echo 第一次執行,安裝必要元件...
  pushd poller
  call npm install --no-audit --no-fund
  popd
)
:loop
node poller\run.mjs
echo.
echo 程式結束,10 秒後自動重新啟動(要停止請直接關閉視窗)...
timeout /t 10 /nobreak >nul
goto loop
