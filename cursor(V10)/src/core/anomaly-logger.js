/**
 * AnomalyLogger - Agent 执行异常行为的集中式日志记录器
 *
 * 功能：将 Agent 执行过程中的各种异常行为记录到 JSON 日志文件中。
 * 记录但不自动修复，供后续分析和自我迭代系统使用。
 *
 * 异常类型包括：
 * - TOOL_LOOP：工具调用循环（重复调用同一工具）
 * - STALL：输出停滞（连续输出相似内容无进展）
 * - LLM_ERROR：LLM 调用失败（超时/网络/速率限制）
 * - EDIT_FAIL：edit_file 失败（匹配未找到/多处匹配）
 * - CMD_FAIL：run_terminal_cmd 失败
 * - NO_TOOL：连续多轮无工具调用
 * - TRUNCATION：输出被截断
 * - GATE_FAIL：完成门检查失败
 * - CONTEXT_COMPRESS：上下文被压缩（token 过多）
 * - EXCESSIVE_READ：文件被过度重复读取
 * - QUALITY_ISSUE：输出质量问题（懒惰短语等）
 */

const fs = require('fs');
const path = require('path');

class AnomalyLogger {
    constructor(logDir) {
        this._logDir = logDir || null;
        this._logFile = null;
        this._sessionId = null;
        this._entries = [];
        this._startTime = Date.now();
        this._maxEntriesInMemory = 200;
    }

    /**
     * 初始化日志器，绑定到一个会话
     */
    init(sessionId, projectPath) {
        this._sessionId = sessionId || `session_${Date.now()}`;
        this._startTime = Date.now();
        this._entries = [];

        // 日志目录：项目目录下 .agent-logs/ 或 userData/agent-anomaly-logs/
        if (projectPath) {
            this._logDir = path.join(projectPath, '.agent-logs');
        }
        if (!this._logDir) {
            try {
                const { app } = require('electron');
                this._logDir = path.join(app.getPath('userData'), 'agent-anomaly-logs');
            } catch (_) {
                this._logDir = path.join(require('os').tmpdir(), 'agent-anomaly-logs');
            }
        }

        try {
            fs.mkdirSync(this._logDir, { recursive: true });
        } catch (_) { }

        // 日志文件名：按日期 + sessionId 前 8 位
        const dateStr = new Date().toISOString().slice(0, 10);
        const shortId = this._sessionId.substring(0, 8);
        this._logFile = path.join(this._logDir, `anomaly_${dateStr}_${shortId}.jsonl`);
    }

    /**
     * 记录一条异常
     * @param {string} type - 异常类型（TOOL_LOOP, STALL, LLM_ERROR 等）
     * @param {string} severity - 严重级别：info, warn, error, critical
     * @param {string} summary - 一句话描述
     * @param {object} details - 详细信息
     */
    log(type, severity, summary, details = {}) {
        const entry = {
            ts: new Date().toISOString(),
            elapsed: Math.round((Date.now() - this._startTime) / 1000),
            sessionId: this._sessionId,
            type,
            severity,
            summary,
            details,
        };

        this._entries.push(entry);

        // 内存限制
        if (this._entries.length > this._maxEntriesInMemory) {
            this._entries = this._entries.slice(-this._maxEntriesInMemory);
        }

        // 追加写入文件
        this._appendToFile(entry);

        return entry;
    }

    // === 便捷方法：各异常类型 ===

    toolLoop(pattern, toolName, count, context = {}) {
        return this.log('TOOL_LOOP', count >= 3 ? 'error' : 'warn', `工具循环检测: ${pattern} (第${count}次)`, {
            pattern,
            toolName,
            loopCount: count,
            action: count >= 3 ? 'force_stop' : count >= 2 ? 'block_tool' : 'inject_warning',
            ...context,
        });
    }

    stall(stallCount, lastContent, context = {}) {
        return this.log('STALL', stallCount >= 3 ? 'error' : 'warn', `输出停滞 (${stallCount}/3)`, {
            stallCount,
            contentPreview: (lastContent || '').substring(0, 200),
            action: stallCount >= 3 ? 'hard_break' : 'force_tool',
            ...context,
        });
    }

    llmError(message, attempt, maxRetries, hadPartialContent = false, context = {}) {
        return this.log('LLM_ERROR', attempt >= maxRetries ? 'error' : 'warn',
            `LLM 错误 (${attempt}/${maxRetries}): ${message.substring(0, 150)}`, {
            errorMessage: message.substring(0, 500),
            attempt,
            maxRetries,
            hadPartialContent,
            action: attempt >= maxRetries ? (hadPartialContent ? 'degrade' : 'terminate') : 'retry',
            ...context,
        });
    }

    editFail(filePath, failCount, errorCode, context = {}) {
        return this.log('EDIT_FAIL', failCount >= 3 ? 'error' : 'warn',
            `edit_file 失败 (${failCount}次): ${filePath}`, {
            filePath,
            failCount,
            errorCode,
            action: failCount >= 3 ? 'force_write_file' : failCount >= 2 ? 'suggest_write_file' : 'retry_with_snippet',
            ...context,
        });
    }

    cmdFail(command, errorCode, stderr, context = {}) {
        return this.log('CMD_FAIL', 'warn', `命令失败: ${command.substring(0, 80)}`, {
            command: command.substring(0, 200),
            errorCode,
            stderrPreview: (stderr || '').substring(0, 300),
            ...context,
        });
    }

    noToolRetry(retryCount, remaining, context = {}) {
        return this.log('NO_TOOL', retryCount >= 6 ? 'error' : 'warn',
            `连续无工具调用 (${retryCount}次), 剩余${remaining}项`, {
            retryCount,
            remainingTodos: remaining,
            action: retryCount >= 6 ? 'exhausted' : retryCount >= 4 ? 'gate_check' : 'force_required',
            ...context,
        });
    }

    truncation(attempt, context = {}) {
        return this.log('TRUNCATION', attempt >= 3 ? 'error' : 'warn',
            `输出截断 (${attempt}/3)`, {
            attempt,
            ...context,
        });
    }

    gateFail(attempt, maxAttempts, reason, context = {}) {
        return this.log('GATE_FAIL', attempt >= maxAttempts ? 'error' : 'warn',
            `完成门检查失败 (${attempt}/${maxAttempts}): ${reason}`, {
            attempt,
            maxAttempts,
            reason,
            ...context,
        });
    }

    contextCompress(beforeTokens, afterTokens, context = {}) {
        return this.log('CONTEXT_COMPRESS', 'info',
            `上下文压缩: ${beforeTokens} → ${afterTokens} tokens`, {
            beforeTokens,
            afterTokens,
            compressionRatio: afterTokens > 0 ? (beforeTokens / afterTokens).toFixed(2) : 'N/A',
            ...context,
        });
    }

    excessiveRead(filePath, readCount, context = {}) {
        return this.log('EXCESSIVE_READ', 'warn',
            `文件过度读取: ${filePath} (${readCount}次)`, {
            filePath,
            readCount,
            ...context,
        });
    }

    qualityIssue(issue, content, context = {}) {
        return this.log('QUALITY_ISSUE', 'warn', `质量问题: ${issue}`, {
            issue,
            contentPreview: (content || '').substring(0, 200),
            ...context,
        });
    }

    /**
     * 获取本次会话的所有异常摘要
     */
    getSummary() {
        const typeCounts = {};
        const severityCounts = { info: 0, warn: 0, error: 0, critical: 0 };
        for (const e of this._entries) {
            typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
            severityCounts[e.severity] = (severityCounts[e.severity] || 0) + 1;
        }
        return {
            sessionId: this._sessionId,
            totalAnomalies: this._entries.length,
            byType: typeCounts,
            bySeverity: severityCounts,
            durationSeconds: Math.round((Date.now() - this._startTime) / 1000),
            logFile: this._logFile,
        };
    }

    /**
     * 追加写入 JSONL 文件
     */
    _appendToFile(entry) {
        if (!this._logFile) return;
        try {
            fs.appendFileSync(this._logFile, JSON.stringify(entry) + '\n', 'utf-8');
        } catch (_) { }
    }

    /**
     * 会话结束时写入摘要
     */
    finalize(finalState) {
        const summary = this.getSummary();
        summary.finalState = finalState || 'unknown';
        this.log('SESSION_END', 'info', `会话结束: ${summary.totalAnomalies} 个异常`, summary);
        return summary;
    }
}

// 单例
let _instance = null;
function getAnomalyLogger() {
    if (!_instance) _instance = new AnomalyLogger();
    return _instance;
}

module.exports = { AnomalyLogger, getAnomalyLogger };
