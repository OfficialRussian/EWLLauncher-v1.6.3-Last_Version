@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist assets\icon.png call node tools\make-icon.js
call npm run dev
