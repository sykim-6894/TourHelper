@echo off
rem Refresh event data and append the output to logs\fetch.log (run daily by Task Scheduler).
cd /d "%~dp0.."
if not exist logs mkdir logs
echo ==== %date% %time% ==== >> logs\fetch.log
node scripts\fetch-events.mjs >> logs\fetch.log 2>&1
exit /b %errorlevel%
