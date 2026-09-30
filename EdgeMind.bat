@echo off
rem One-click launcher: starts the Qdrant Server and both devices, then opens them in the browser.
rem Double-click this file, or run it from a terminal. Close with scripts\stop.ps1.
title EdgeMind
cd /d "%~dp0"

rem Ollama runs the on-device models; start it if it isn't already running.
tasklist /fi "imagename eq ollama.exe" | find /i "ollama.exe" >nul || (
  where ollama >nul 2>&1 && start "" /min ollama serve
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 (
  echo.
  echo EdgeMind failed to start. See data\device_a.err.log and data\device_b.err.log
  pause
  exit /b 1
)

start "" http://localhost:8101
start "" http://localhost:8102
echo.
echo EdgeMind is running:  Laptop http://localhost:8101   Mobile http://localhost:8102
timeout /t 5 >nul
