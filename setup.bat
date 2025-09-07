@echo off
setlocal
set "BASE=%~dp0"
where pwsh >nul 2>&1 && (set "PS=pwsh") || (set "PS=powershell")

"%PS%" -NoLogo -NoProfile -Command ^
  "Set-ExecutionPolicy RemoteSigned -Scope Process -Force; ^
   Set-Location -LiteralPath '%BASE%'; ^
   Unblock-File -LiteralPath '.\setup.ps1' -ErrorAction SilentlyContinue; ^
   & '.\setup.ps1'; exit $LASTEXITCODE"

exit /b %ERRORLEVEL%
s