@echo off
title Mati-Ni
cd /d "%~dp0"
start "Mati-Ni 서버" cmd /k "npm run dev"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:3000"
