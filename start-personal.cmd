@echo off
cd /d "%~dp0"
node scripts\launch-personal.ts
if errorlevel 1 pause
