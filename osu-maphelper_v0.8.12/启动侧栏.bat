@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title osu! MapHelper Side Panel
echo Starting osu! MapHelper side panel...
echo.
node "%~dp0scripts\launch.mjs"
if errorlevel 1 (
  echo.
  echo Launch failed. See the message above.
  pause
)
