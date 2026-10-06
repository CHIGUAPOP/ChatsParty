@echo off
chcp 65001 >nul
title ChatsParty Launcher
cd /d "%~dp0"

rem ---- make sure node.exe is reachable ----
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] node.exe not found. Please install Node.js 18+ from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node scripts\launch.cjs
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Exit code %EXITCODE%. Scroll up for details.
  echo.
  pause
)
exit /b %EXITCODE%
