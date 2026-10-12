@echo off
:: DOINg.AI Factory - production on Windows: builds the UI, then serves the API and the UI from a
:: single process (FACTORY_HOST / FACTORY_PORT in backend\.env, 127.0.0.1:3071 by default).
:: No --reload, for the reason given in start-windows.bat. `serve-windows.bat --no-build` skips the build.
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "backend\.venv\Scripts\python.exe" (
    echo [ERROR] Run install-windows.bat first.
    exit /b 1
)
if "%~1"=="--no-build" goto run
pushd frontend
call npm run build
if errorlevel 1 (
    popd
    echo [ERROR] The UI build failed.
    exit /b 1
)
popd
:run
set PYTHONUTF8=1
cd /d "%~dp0backend"
echo [Factory] http://127.0.0.1:3071  -  Ctrl+C to stop.
".venv\Scripts\python.exe" -m app
endlocal
