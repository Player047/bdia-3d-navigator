@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   BDIA 数据编辑器
echo   --------------------------------------------------------
echo   正在启动本地服务... 浏览器会自动打开。
echo   关掉这个窗口 = 停止服务。
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没找到 node。
  echo.
  echo   请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node tools\editor-server.mjs
set EXITCODE=%errorlevel%

echo.
if %EXITCODE% neq 0 (
  echo   [错误] 服务异常退出，代码 %EXITCODE%。
  echo   端口被占用的话可以换一个：
  echo       node tools\editor-server.mjs --port 5174
  echo.
) else (
  echo   服务已停止。
)
pause
