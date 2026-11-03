@echo off
title EWLLauncher - build
cd /d "%~dp0"

set MISSING=
for %%F in (package.json src\main\index.js src\renderer\index.html tools\make-icon.js tests\smoke.js) do (
  if not exist "%%F" (
    echo [ERROR] Missing file: %%F
    set MISSING=1
  )
)
if defined MISSING (
  echo.
  echo The project folder is incomplete. Possible reasons:
  echo  - BUILD.bat was started from inside the zip: extract the archive first ^(Extract all^).
  echo  - Some folders were not uploaded or copied: re-download the full project.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install LTS from https://nodejs.org and run BUILD.bat again.
  pause
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 goto fail

echo [2/4] Creating icon...
call node tools\make-icon.js
if errorlevel 1 goto fail

echo [3/4] Running tests...
call node tests\smoke.js
if errorlevel 1 goto fail

echo [4/4] Building EXE (first run downloads Electron, takes a few minutes)...
call npm run build
if errorlevel 1 goto fail

echo.
echo DONE. Files are in the dist folder:
dir /b dist\*.exe
echo.
echo   EWLLauncher-Portable-*.exe  - runs without installation
echo   EWLLauncher-Setup-*.exe     - installer
explorer dist
pause
exit /b 0

:fail
echo.
echo [ERROR] Build failed. See the messages above.
pause
exit /b 1
