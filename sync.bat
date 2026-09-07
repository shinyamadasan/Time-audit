@echo off
setlocal

:: ChronaSense — www/ runtime mirror (SAFE: mirror / check only)
::
:: Thin wrapper around scripts/runtime-mirror.mjs. It computes the browser-
:: runtime dependency closure rooted at index.html and mirrors exactly those
:: files into www/ (the Capacitor webDir).
::
:: This script does NOT and MUST NOT: git add / commit / push / merge, or run
:: `npx cap sync android`. Native sync + release is a separate, explicit action:
:: see scripts/deploy-release.ps1.
::
::   sync.bat            mirror root -> www/ (default)
::   sync.bat --check    verify parity only, no writes, non-zero exit on drift

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

if "%~1"=="" (
  call node "%APP_DIR%\scripts\runtime-mirror.mjs" --write
) else (
  call node "%APP_DIR%\scripts\runtime-mirror.mjs" %*
)
exit /b %ERRORLEVEL%
