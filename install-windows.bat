@echo off
:: DOINg.AI Factory - Windows install (run once; double-click or `install-windows.bat`).
:: Offline / corporate networks: pip and npm use the mirrors declared in pip.ini / .npmrc.
setlocal EnableExtensions
cd /d "%~dp0"
echo [Factory] Installing for Windows...

:: --- Python 3.12+: the py launcher first, then python on PATH ---
set "PY="
for %%C in ("py -3" "python" "python3") do (
    if not defined PY (
        %%~C -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>&1 && set "PY=%%~C"
    )
)
if not defined PY (
    echo [ERROR] Python 3.12 or newer was not found. Install it with the "py" launcher.
    exit /b 1
)
echo [OK] Python: %PY%

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js 20 or newer was not found ^(npm is not on PATH^).
    exit /b 1
)

:: --- Long paths: node_modules and site-packages quickly exceed 260 characters ---
reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled 2>nul | find "0x1" >nul
if errorlevel 1 (
    echo [Factory] Enabling Windows long paths...
    reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f >nul 2>&1
    if errorlevel 1 (
        echo [WARNING] Administrator rights are needed to enable long paths.
        echo           Run this script as Administrator if installs fail on long paths.
    ) else (
        echo [OK] Long paths enabled.
    )
) else (
    echo [OK] Long paths already enabled.
)

:: --- Backend: virtual environment and dependencies (tzdata included: Windows has no IANA zones) ---
if not exist "backend\.venv\Scripts\python.exe" (
    echo [Factory] Creating backend\.venv...
    %PY% -m venv backend\.venv
    if errorlevel 1 (
        echo [ERROR] Could not create the virtual environment.
        exit /b 1
    )
)
set "VPY=%~dp0backend\.venv\Scripts\python.exe"
"%VPY%" -m pip install -q --upgrade pip
"%VPY%" -m pip install -q -r backend\requirements.txt
if errorlevel 1 (
    echo [ERROR] pip install failed. Offline: check the internal PyPI mirror in pip.ini.
    exit /b 1
)
echo [OK] Python dependencies installed.

:: --- Frontend: short npm cache path to stay clear of the 260-character limit ---
set "NPM_CACHE=%SystemDrive%\npm-cache"
pushd frontend
call npm install --cache "%NPM_CACHE%" --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo [Factory] npm install failed. Retrying after verifying the cache...
    call npm cache verify --cache "%NPM_CACHE%" >nul 2>&1
    call npm install --cache "%NPM_CACHE%" --no-audit --no-fund
    if errorlevel 1 (
        popd
        echo [ERROR] npm install failed. Offline: check the internal npm mirror in .npmrc.
        exit /b 1
    )
)
popd
echo [OK] UI dependencies installed.

if not exist "backend\.env" (
    copy /y "backend\.env.example" "backend\.env" >nul
    echo [OK] backend\.env created from backend\.env.example.
)

echo.
echo [OK] Install complete.
echo      Development: start-windows.bat   ^(API :3071, UI :3070^)
echo      Production : serve-windows.bat   ^(one process on :3071^)
endlocal
