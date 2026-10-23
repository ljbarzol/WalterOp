@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install
)
echo Iniciando el laboratorio Walter...
start "Servidor Walter" cmd /k node server.js
timeout /t 2 >nul
start "" http://localhost:3000/
