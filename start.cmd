@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js 20 or newer.& pause & exit /b 1)
where npm >nul 2>nul || (echo npm is required to install Playwright.& pause & exit /b 1)
where python >nul 2>nul || (echo Install Python 3 and add it to PATH.& pause & exit /b 1)
for /f %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set AGM_NODE_MAJOR=%%v
if %AGM_NODE_MAJOR% LSS 20 (echo Node.js 20 or newer is required.& pause & exit /b 1)
if not exist "node_modules\playwright\package.json" (
  echo Installing app dependencies for the first run...
  call npm ci --no-fund --no-audit || (pause & exit /b 1)
)
node -e "import('playwright').then(({chromium})=>{const fs=require('fs');if(!fs.existsSync(chromium.executablePath()))process.exitCode=2})"
if errorlevel 1 call npx playwright install chromium
node server.mjs
pause
