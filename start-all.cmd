@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bots.ps1" -OpenPages
if errorlevel 1 (
  pause
  exit /b 1
)
call "%~dp0start.cmd"
