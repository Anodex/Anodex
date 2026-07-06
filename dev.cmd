@echo off
REM ============================================================
REM  Anodex - launch the app in development mode (hot reload)
REM  Double-click this file, or run `dev.cmd` from a terminal.
REM ============================================================

cd /d "%~dp0"

echo.
echo   Anodex - starting development build...
echo.

REM Install dependencies on first run (or if node_modules is missing).
if not exist "node_modules" (
  echo   node_modules not found - installing dependencies. This may take a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Dependency install failed. Fix the errors above and try again.
    echo.
    pause
    exit /b 1
  )
)

echo   Launching Anodex ^(close the app window to stop^)...
echo.
call npm run dev

REM Keep the window open if the app exits with an error so you can read it.
if errorlevel 1 (
  echo.
  echo   Anodex exited with an error. See the output above.
  echo.
  pause
)
