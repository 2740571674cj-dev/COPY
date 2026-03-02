# tests/run-tests.ps1
# 统一测试运行器 — 自动设置 UTF-8 编码，解决中文乱码

# 设置 PowerShell 输出编码为 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$testDir = $PSScriptRoot
$testFiles = @(
    "read-coverage-index.test.js",
    "read-file.test.js",
    "edit-file.test.js",
    "agent-loop-controller.test.js",
    "agent-e2e-alignment.test.js",
    "todo-manager.test.js",
    "tool-path-security.test.js",
    "llm-gateway.test.js",
    "checkpoint-store.test.js"
)

$allPassed = $true

foreach ($file in $testFiles) {
    $path = Join-Path $testDir $file
    if (Test-Path $path) {
        Write-Host "`n========== $file ==========" -ForegroundColor Cyan
        node $path
        if ($LASTEXITCODE -ne 0) {
            $allPassed = $false
        }
    }
    else {
        Write-Host "SKIP: $file not found" -ForegroundColor Yellow
    }
}

Write-Host ""
if ($allPassed) {
    Write-Host "All test suites passed!" -ForegroundColor Green
}
else {
    Write-Host "Some test suites FAILED!" -ForegroundColor Red
    exit 1
}
