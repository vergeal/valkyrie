@echo off
rem 打 Windows 安装包（exe / NSIS），产物在 electron\release
cd /d "%~dp0"
node package.cjs --target win %*
