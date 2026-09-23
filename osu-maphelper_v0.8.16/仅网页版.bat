@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title osu! MapHelper Web Mode
echo Starting local server (web mode)...
echo.
echo   Open this in your browser:  http://127.0.0.1:24100
echo.
echo   Keep this window open. Press Ctrl+C to stop.
echo.
node "%~dp0src\server.mjs"
pause
