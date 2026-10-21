@echo off
chcp 65001 >nul
rem Windows：双击本文件启动 DeepSeek直搜，并自动打开浏览器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 没有检测到 Node.js。
  echo 请先安装 LTS 版本：https://nodejs.org/zh-cn
  start "" "https://nodejs.org/zh-cn"
  pause
  exit /b 1
)

echo 正在启动 DeepSeek直搜... ^(关闭此窗口即停止服务^)
node server.mjs --open
pause
