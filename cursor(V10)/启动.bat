@echo off
chcp 65001 >nul 2>&1
title Cursor Launcher V10
color 0A

echo.
echo  ╔══════════════════════════════════════╗
echo  ║     Cursor Launcher V10  一键启动     ║
echo  ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: 检查 node_modules
if not exist "node_modules" (
    echo  [!] 未检测到依赖，正在安装...
    call npm install
    if errorlevel 1 (
        echo  [X] 依赖安装失败！请检查网络或手动运行 npm install
        pause
        exit /b 1
    )
    echo  [√] 依赖安装完成
    echo.
)

:: 检查端口 5173 是否被占用
netstat -ano | findstr ":5173 " >nul 2>&1
if not errorlevel 1 (
    echo  [!] 端口 5173 已被占用，正在释放...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 1 >nul
)

echo  [*] 启动 Vite 开发服务器 + Electron...
echo  [*] 首次启动可能需要 10-20 秒
echo.

call npm run dev

if errorlevel 1 (
    echo.
    echo  [X] 启动失败！常见原因：
    echo      1. 端口 5173 被占用
    echo      2. node_modules 损坏 - 删除后重新 npm install
    echo      3. Electron 未正确安装 - 运行 npx electron --version 检查
    echo.
    pause
)
