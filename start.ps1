
# RoftX — Local Dev Startup Script
# Run with: powershell -File start.ps1

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   RoftX  — Starting Local Dev Stack" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Start backend (port 3000)
Write-Host "► Starting backend on http://localhost:3000 ..." -ForegroundColor Green
$backend = Start-Process powershell -ArgumentList "-NoExit -Command `"Set-Location '$rootDir'; node roftx_backend/server.js`"" -PassThru

Start-Sleep -Seconds 2

# Start frontend static server (port 5500)
Write-Host "► Starting frontend on http://localhost:5500 ..." -ForegroundColor Green
$frontend = Start-Process powershell -ArgumentList "-NoExit -Command `"Set-Location '$rootDir'; npx http-server . -p 5500 -c-1 --cors`"" -PassThru

Start-Sleep -Seconds 2

# Open browser
Write-Host "► Opening browser..." -ForegroundColor Green
Start-Process "http://localhost:5500/index.html"

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Backend  → http://localhost:3000"       -ForegroundColor White
Write-Host "  Frontend → http://localhost:5500"       -ForegroundColor White
Write-Host "  App      → http://localhost:5500/index.html" -ForegroundColor White
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Close the backend/frontend terminal windows to stop." -ForegroundColor Yellow
