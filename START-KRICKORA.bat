@echo off
title Krickora Local Dev
cd /d "%~dp0"

echo.
echo  Starting Krickora local dev server...
echo  Connects to live Convex backend automatically.
echo  Press Ctrl+C in this window to stop the server.
echo.

:: Open browser after a 3-second delay (gives Vite time to start)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"

:: Start Vite dev server (keeps this window open)
npm run dev

pause
