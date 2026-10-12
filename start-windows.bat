@echo off
:: DOINg.AI Factory - development on Windows: two windows, the API on :3071 and the UI on :3070
:: (the UI proxies /api, the WebSocket and /mcp to :3071).
::
:: The API runs WITHOUT --reload: on Windows, uvicorn --reload switches asyncio to the Selector
:: loop, which cannot start subprocesses - no local (stdio) MCP server would start, including the
:: bundled DOINg.AI and Jira servers. After changing backend code, restart the API window.
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "backend\.venv\Scripts\python.exe" (
    echo [ERROR] Run install-windows.bat first.
    exit /b 1
)
if not exist "frontend\node_modules" (
    echo [ERROR] Run install-windows.bat first.
    exit /b 1
)
set PYTHONUTF8=1
start "Factory API :3071" /D "%~dp0backend" cmd /k ".venv\Scripts\python.exe -m app"
start "Factory UI :3070" /D "%~dp0frontend" cmd /k "npm run dev"
echo [Factory] API http://127.0.0.1:3071
echo [Factory] UI  http://127.0.0.1:3070
timeout /t 5 /nobreak >nul
start "" "http://127.0.0.1:3070"
endlocal
