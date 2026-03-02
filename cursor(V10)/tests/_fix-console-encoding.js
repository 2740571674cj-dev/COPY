/**
 * tests/_fix-console-encoding.js
 * Windows UTF-8 终端编码修复
 *
 * 由于 PowerShell 的 [Console]::OutputEncoding 无法从 Node 子进程中修改，
 * 此模块无法自动修复终端乱码。
 *
 * 正确的运行方式：
 *   在 PowerShell 中先执行：
 *     [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
 *   然后再运行测试：
 *     node tests/xxx.test.js
 *
 *   或使用项目提供的 npm 脚本（已内置编码设置）：
 *     npm test
 */
// 此文件仅作为文档占位符和 require 入口
// 实际编码修复通过 npm scripts 或 run-tests.ps1 实现
