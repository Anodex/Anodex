@echo off
REM ============================================================
REM  Anodex - launch the app in development mode (hot reload)
REM  Double-click this file, or run `dev.cmd` from a terminal.
REM
REM  `npm run dev` runs scripts/dev-preflight.mjs first (as its
REM  `predev` step), which stages the runtimes a packaged build
REM  gets and closes any instance that would block this one.
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
call npm run dev

REM Always pause. Electron exits 0 when it hands over to another instance, so
REM an error branch alone would close this window on exactly the run you need
REM to read.
echo.
echo   Anodex has exited.
echo.
pause
