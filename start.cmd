@echo off
rem 双击即可启动客户端（等价于 node start.cjs）
cd /d "%~dp0"
node start.cjs %*
