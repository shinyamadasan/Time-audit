@echo off
:: If not running in its own window, relaunch in one
if "%LAUNCHED%"=="" (
  set LAUNCHED=1
  start "ChronaSense Deploy" cmd /k "%~f0"
  exit
)

echo =============================
echo  ChronaSense - Deploy All
echo =============================

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "SRC=%APP_DIR%\index.html"
set "WWW=%APP_DIR%\www"

echo.
echo [1/3] Copying files to www (for Android)...
if not exist "%WWW%" mkdir "%WWW%"
copy /Y "%SRC%" "%WWW%\index.html" || echo WARNING: Copy index.html to www failed
for %%f in ("%APP_DIR%\*.js") do (
  copy /Y "%%f" "%WWW%\%%~nxf" || echo WARNING: Copy %%~nxf to www failed
)
for %%f in ("%APP_DIR%\*.css") do (
  copy /Y "%%f" "%WWW%\%%~nxf" || echo WARNING: Copy %%~nxf to www failed
)
:: Sounds are served from GitHub Pages (not bundled in APK — keeps APK ~12MB)
:: Do NOT copy Sounds/ to www/

echo.
echo [2/3] Syncing to Android...
cd /d "%APP_DIR%"
call npx cap sync android
if errorlevel 1 (
  echo ERROR: cap sync failed
  echo Check capacitor.config.json and local dependencies before building the APK.
  goto :end
) else (
  echo Android sync OK
)

echo.
echo [3/3] Pushing to GitHub (web app)...
:: "www" stages the whole mirrored bundle. The literal "index.html" pathspec only ever matched
:: the root file, so www\index.html was copied in step 1 but never committed - which is why it
:: kept needing a manual "mirror to web bundle" commit afterwards.
git add index.html *.js *.css CHANGELOG.md Sounds www
git status
git commit -m "Update app"
if errorlevel 1 (
  echo Nothing new to commit - deploying existing commits.
)
:: Push unconditionally. This used to sit in the "else" of the commit above, so whenever there
:: was nothing new to stage, the script skipped the push entirely and still printed "Done!" -
:: leaving already-committed work sitting unpushed while it looked like a successful deploy.
git push origin main
if errorlevel 1 (
  echo ERROR: git push failed - check credentials or connection
) else (
  echo Pushed to GitHub!
)

echo.
echo =============================
echo  Done!
echo  - Android: Build APK in Android Studio
echo  - Web: https://shinyamadasan.github.io/Time-audit
echo =============================

:end
echo.
echo Press any key to close...
pause > nul
