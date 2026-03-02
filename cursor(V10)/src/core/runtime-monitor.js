/**
 * RuntimeMonitor - Agent 运行监测程序
 *
 * 完整记录 Agent 执行过程中的每一个行为，包括：
 * - 每一步的详细操作内容和耗时
 * - 工具调用的参数、结果和执行时间
 * - LLM 调用的响应时间和 token 使用
 * - 报错详情和上下文
 * - 状态变化时间线
 * - 最终分析报告
 *
 * 日志写入项目目录 .agent-monitor/ 下的 JSONL 文件
 * 分析报告生成为可浏览的 HTML 文件
 */

const fs = require('fs');
const path = require('path');
let WebSocket;
try { WebSocket = require('ws'); } catch (_) { WebSocket = null; }

class RuntimeMonitor {
    constructor() {
        this._active = false;
        this._sessionId = null;
        this._logDir = null;
        this._logFile = null;
        this._htmlFile = null;
        this._startTime = 0;
        this._timeline = [];         // 完整时间线
        this._toolStats = {};        // 工具调用统计
        this._iterationTimes = [];   // 每轮迭代耗时
        this._errors = [];           // 错误列表
        this._stateTransitions = []; // 状态切换记录
        this._currentIteration = 0;
        this._iterationStart = 0;
        this._llmCallStart = 0;
        this._llmStats = { calls: 0, totalMs: 0, errors: 0, tokens: 0 };
        this._toolCallStart = new Map();
        this._projectPath = '';
        this._modelId = '';
        this._userMessage = '';
        this._tokenStats = { totalPrompt: 0, totalCompletion: 0, total: 0, perIteration: [] };
        this._ws = null;
        this._wsPort = 19527;
    }

    /**
     * 绑定到 AgentLoopController 实例，自动监听所有事件
     */
    attach(agent) {
        if (!agent || typeof agent.on !== 'function') return;
        this._agent = agent;

        // === 会话生命周期 ===
        agent.on('started', (data) => this._onStarted(data));
        agent.on('complete', (data) => this._onComplete(data));
        agent.on('incomplete', (data) => this._onIncomplete(data));
        agent.on('error', (data) => this._onError(data));

        // === 状态变化 ===
        agent.on('state-change', (data) => this._onStateChange(data));

        // === LLM 相关 ===
        agent.on('progress-note', (data) => this._onProgressNote(data));
        agent.on('stream-content', (data) => this._onStreamContent(data));
        agent.on('stream-reasoning', (data) => this._onStreamReasoning(data));

        // === 工具执行 ===
        agent.on('tool-calls-received', (data) => this._onToolCallsReceived(data));
        agent.on('tool-executing', (data) => this._onToolExecuting(data));
        agent.on('tool-result', (data) => this._onToolResult(data));
        agent.on('tool-call-delta', (data) => this._sendWs({ type: 'TOOL_DELTA', ...this._truncateArgs(data), elapsed: this._elapsed() }));
        agent.on('tools-executed', (data) => this._onToolsExecuted(data));

        // === 交互事件 ===
        agent.on('approval-needed', (data) => this._sendWs({ type: 'APPROVAL_NEEDED', toolName: data?.toolName, elapsed: this._elapsed() }));
        agent.on('ask-question', (data) => this._sendWs({ type: 'ASK_QUESTION', question: (data?.question || '').substring(0, 500), elapsed: this._elapsed() }));
        agent.on('gate-failed', (data) => this._sendWs({ type: 'GATE_FAILED', reason: data?.reason, elapsed: this._elapsed() }));
        agent.on('max-iterations', (data) => this._sendWs({ type: 'MAX_ITERATIONS', elapsed: this._elapsed(), ...data }));

        // === 其他事件 ===
        agent.on('agent-metrics', (data) => this._onMetrics(data));
        agent.on('token-usage', (data) => this._onTokenUsage(data));
        agent.on('skill-used', (data) => { this._record('SKILL_USED', data); this._sendWs({ type: 'SKILL_USED', ...data, elapsed: this._elapsed() }); });
        agent.on('workflow-matched', (data) => { this._record('WORKFLOW', data); this._sendWs({ type: 'WORKFLOW', ...data, elapsed: this._elapsed() }); });
        agent.on('mode-switched', (data) => { this._record('MODE_SWITCH', data); this._sendWs({ type: 'MODE_SWITCH', ...data, elapsed: this._elapsed() }); });
        agent.on('skills-matched', (data) => this._sendWs({ type: 'SKILLS_MATCHED', ...data, elapsed: this._elapsed() }));
    }

    /**
     * 初始化监测会话
     */
    init(sessionId, projectPath, modelId) {
        this._active = true;
        this._sessionId = sessionId;
        this._projectPath = projectPath || '';
        this._modelId = modelId || '';
        this._startTime = Date.now();
        this._timeline = [];
        this._toolStats = {};
        this._iterationTimes = [];
        this._errors = [];
        this._stateTransitions = [];
        this._currentIteration = 0;
        this._llmStats = { calls: 0, totalMs: 0, errors: 0, tokens: 0 };
        this._toolCallStart = new Map();
        this._tokenStats = { totalPrompt: 0, totalCompletion: 0, total: 0, perIteration: [] };
        this._streamAccum = '';

        // 日志目录
        this._logDir = projectPath
            ? path.join(projectPath, '.agent-monitor')
            : path.join(require('os').tmpdir(), 'agent-monitor');

        try { fs.mkdirSync(this._logDir, { recursive: true }); } catch (_) { }

        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const shortId = (sessionId || 'unknown').substring(0, 8);
        this._logFile = path.join(this._logDir, `monitor_${ts}_${shortId}.jsonl`);
        this._htmlFile = path.join(this._logDir, `report_${ts}_${shortId}.html`);

        this._record('SESSION_START', { sessionId, projectPath, modelId });

        // 连接到外部监测服务器（如果在运行）
        this._connectWs();
    }


    /**
     * 连接到独立监测服务器的 WebSocket
     */
    _connectWs() {
        if (!WebSocket) {
            console.log('[RuntimeMonitor] ws module not available, skipping WebSocket connection');
            return;
        }
        try {
            console.log(`[RuntimeMonitor] Connecting to monitor server ws://localhost:${this._wsPort}...`);
            this._ws = new WebSocket(`ws://localhost:${this._wsPort}`);
            this._ws.on('open', () => {
                console.log('[RuntimeMonitor] Connected to monitor server');
                this._sendWs({ type: 'SESSION_INIT', sessionId: this._sessionId, projectPath: this._projectPath, modelId: this._modelId });
            });
            this._ws.on('error', (err) => {
                console.log('[RuntimeMonitor] WebSocket error:', err.message);
                this._ws = null;
            });
            this._ws.on('close', () => { this._ws = null; });
        } catch (e) {
            console.error('[RuntimeMonitor] WebSocket connect failed:', e.message);
            this._ws = null;
        }
    }

    _sendWs(data) {
        try {
            if (this._ws && this._ws.readyState === 1) {
                this._ws.send(JSON.stringify(data));
            }
        } catch (_) { }
    }

    // ==================== 事件处理器 ====================

    _onStarted(data) {
        this._userMessage = data.userMessage || '';
        this._record('AGENT_STARTED', {
            userMessagePreview: (data.userMessage || '').substring(0, 300),
        });
    }

    _onStateChange(data) {
        this._stateTransitions.push({
            ts: Date.now(),
            elapsed: this._elapsed(),
            from: data.from,
            to: data.to,
        });
        this._record('STATE_CHANGE', data);

        // 追踪迭代计时
        if (data.to === 'thinking') {
            this._currentIteration++;
            this._iterationStart = Date.now();
            this._llmCallStart = Date.now();
        }
    }

    _onProgressNote(data) {
        this._record('PROGRESS', { text: data.text });

        // 检测错误相关的进度提示
        if (/⚠️|failed|error|exhausted|timeout/i.test(data.text)) {
            this._errors.push({
                ts: Date.now(),
                elapsed: this._elapsed(),
                iteration: this._currentIteration,
                type: 'progress_warning',
                message: data.text,
            });
        }
    }

    _onStreamContent(data) {
        // 首次 stream 标记 LLM 响应时间
        if (this._llmCallStart > 0) {
            const ttfb = Date.now() - this._llmCallStart;
            this._record('LLM_FIRST_TOKEN', { ttfb, iteration: this._currentIteration });
            this._llmCallStart = 0;
        }
        // 每个 chunk 都即时转发到监测器——不丢失任何内容
        const chunk = data?.content || data?.delta || '';
        if (chunk) {
            this._sendWs({ type: 'STREAM_TEXT', iteration: this._currentIteration, text: chunk, elapsed: this._elapsed() });
        }
    }

    _onStreamReasoning(data) {
        // 模型的思考/推理内容也全部转发
        const chunk = data?.content || data?.delta || data?.reasoning || '';
        if (chunk) {
            this._sendWs({ type: 'STREAM_REASONING', iteration: this._currentIteration, text: chunk, elapsed: this._elapsed() });
        }
    }

    _onToolCallsReceived(data) {
        const llmDuration = this._llmCallStart > 0 ? Date.now() - this._llmCallStart : 0;
        this._llmStats.calls++;
        this._llmStats.totalMs += llmDuration;
        this._llmCallStart = 0;

        // 剩余未发送的 streamAccum 刷新
        if (this._streamAccum && this._streamAccum.length > 0) {
            this._sendWs({ type: 'STREAM_TEXT', iteration: this._currentIteration, text: this._streamAccum, elapsed: this._elapsed() });
            this._streamAccum = '';
        }

        const tools = (data.toolCalls || []).map(tc => tc.function?.name || 'unknown');
        const toolDetails = (data.toolCalls || []).map(tc => ({
            name: tc.function?.name || 'unknown',
            args: this._truncateArgs(tc.function?.arguments),
        }));
        this._record('LLM_RESPONSE', {
            iteration: this._currentIteration,
            durationMs: llmDuration,
            toolCount: tools.length,
            tools,
        });
        // 转发完整工具调用请求到监测器
        this._sendWs({ type: 'LLM_RESPONSE', iteration: this._currentIteration, durationMs: llmDuration, toolCount: tools.length, tools, toolDetails, elapsed: this._elapsed() });
    }

    _onToolExecuting(data) {
        this._toolCallStart.set(data.toolCallId, Date.now());
        this._record('TOOL_START', {
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            args: this._truncateArgs(data.args),
            iteration: this._currentIteration,
        });
        // 转发工具开始事件（带参数摘要）
        this._sendWs({ type: 'TOOL_START', toolName: data.toolName, args: this._truncateArgs(data.args), iteration: this._currentIteration, elapsed: this._elapsed() });
    }

    _onToolResult(data) {
        const startTime = this._toolCallStart.get(data.toolCallId) || Date.now();
        const duration = Date.now() - startTime;
        this._toolCallStart.delete(data.toolCallId);

        // 统计
        if (!this._toolStats[data.toolName]) {
            this._toolStats[data.toolName] = { count: 0, totalMs: 0, errors: 0, maxMs: 0 };
        }
        const stat = this._toolStats[data.toolName];
        stat.count++;
        stat.totalMs += duration;
        if (duration > stat.maxMs) stat.maxMs = duration;

        const success = data.output?.success !== false;
        if (!success) {
            stat.errors++;
            this._errors.push({
                ts: Date.now(),
                elapsed: this._elapsed(),
                iteration: this._currentIteration,
                type: 'tool_error',
                toolName: data.toolName,
                errorCode: data.output?.code || 'unknown',
                errorMessage: (data.output?.error || '').substring(0, 300),
                durationMs: duration,
            });
        }

        // 提取输出摘要
        const outputPreview = this._getToolOutputPreview(data.output);

        this._record('TOOL_RESULT', {
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            success,
            durationMs: duration,
            errorCode: data.output?.code,
            outputPreview: this._truncateOutput(data.output),
            iteration: this._currentIteration,
        });

        // 转发工具结果到监测器（带输出摘要）
        this._sendWs({
            type: 'TOOL_RESULT', toolName: data.toolName, success, durationMs: duration,
            outputPreview, errorCode: data.output?.code, errorMessage: !success ? (data.output?.error || '').substring(0, 200) : undefined,
            iteration: this._currentIteration, elapsed: this._elapsed(),
        });
    }

    _getToolOutputPreview(output) {
        if (!output) return '';
        try {
            const str = typeof output === 'string' ? output : JSON.stringify(output);
            return str.substring(0, 500);
        } catch (_) { return '[无法序列化]'; }
    }

    _onToolsExecuted(data) {
        const results = data.results || [];
        const iterDuration = this._iterationStart > 0 ? Date.now() - this._iterationStart : 0;
        if (this._iterationStart > 0) {
            this._iterationTimes.push({
                iteration: this._currentIteration,
                durationMs: iterDuration,
                toolCount: results.length,
            });
        }
        this._record('ITERATION_END', {
            iteration: this._currentIteration,
            toolCount: results.length,
            durationMs: iterDuration,
        });
        // 转发迭代结束到监测器
        this._sendWs({ type: 'ITERATION_END', iteration: this._currentIteration, toolCount: results.length, durationMs: iterDuration, elapsed: this._elapsed() });
    }

    _onComplete(data) {
        this._record('AGENT_COMPLETE', data);
        this._sendWs({ type: 'AGENT_COMPLETE', elapsed: this._elapsed(), ...data });
        this._generateReport('complete');
    }

    _onIncomplete(data) {
        this._record('AGENT_INCOMPLETE', data);
        this._sendWs({ type: 'AGENT_INCOMPLETE', elapsed: this._elapsed(), ...data });
        this._generateReport('incomplete');
    }

    _onError(data) {
        this._errors.push({
            ts: Date.now(),
            elapsed: this._elapsed(),
            iteration: this._currentIteration,
            type: 'agent_error',
            message: data.error,
        });
        this._record('AGENT_ERROR', data);
        this._sendWs({ type: 'AGENT_ERROR', elapsed: this._elapsed(), error: data.error });
        this._generateReport('error');
    }

    _onMetrics(data) {
        this._record('METRICS', data);
    }

    _onTokenUsage(data) {
        const prompt = data.promptTokens || 0;
        const completion = data.completionTokens || 0;
        const total = prompt + completion;
        this._tokenStats.totalPrompt += prompt;
        this._tokenStats.totalCompletion += completion;
        this._tokenStats.total += total;
        this._tokenStats.perIteration.push({
            iteration: this._currentIteration,
            prompt,
            completion,
            total,
        });
        this._record('TOKEN_USAGE', {
            iteration: this._currentIteration,
            promptTokens: prompt,
            completionTokens: completion,
            totalTokens: total,
            cumulativeTotal: this._tokenStats.total,
        });
    }

    // ==================== 工具方法 ====================

    _elapsed() {
        return Date.now() - this._startTime;
    }

    _record(type, data = {}) {
        if (!this._active) return;
        const entry = {
            ts: new Date().toISOString(),
            elapsed: this._elapsed(),
            type,
            ...data,
        };
        this._timeline.push(entry);
        // 追加写入 JSONL
        try {
            if (this._logFile) {
                fs.appendFileSync(this._logFile, JSON.stringify(entry) + '\n', 'utf-8');
            }
        } catch (_) { }
        // 转发到外部监测服务器
        this._sendWs(entry);
    }

    _truncateArgs(args) {
        if (!args) return {};
        const truncated = {};
        for (const [k, v] of Object.entries(args)) {
            if (typeof v === 'string' && v.length > 200) {
                truncated[k] = v.substring(0, 200) + '...(truncated)';
            } else {
                truncated[k] = v;
            }
        }
        return truncated;
    }

    _truncateOutput(output) {
        if (!output) return null;
        const preview = {};
        for (const [k, v] of Object.entries(output)) {
            if (typeof v === 'string' && v.length > 200) {
                preview[k] = v.substring(0, 200) + '...';
            } else if (typeof v !== 'object') {
                preview[k] = v;
            }
        }
        return preview;
    }

    // ==================== 分析报告生成 ====================

    _generateReport(finalState) {
        const totalDuration = this._elapsed();
        const analysis = this._analyze(totalDuration);

        this._record('ANALYSIS', analysis);

        // 生成 HTML 报告
        try {
            const html = this._buildHTML(analysis, finalState);
            if (this._htmlFile) {
                fs.writeFileSync(this._htmlFile, html, 'utf-8');
            }
        } catch (_) { }

        this._active = false;
        return analysis;
    }

    _analyze(totalDuration) {
        // 工具统计
        const toolRanking = Object.entries(this._toolStats)
            .map(([name, stat]) => ({
                name,
                count: stat.count,
                avgMs: stat.count > 0 ? Math.round(stat.totalMs / stat.count) : 0,
                maxMs: stat.maxMs,
                errorRate: stat.count > 0 ? (stat.errors / stat.count * 100).toFixed(1) + '%' : '0%',
                errors: stat.errors,
            }))
            .sort((a, b) => b.count - a.count);

        // 迭代统计
        const iterDurations = this._iterationTimes.map(i => i.durationMs);
        const avgIterMs = iterDurations.length > 0
            ? Math.round(iterDurations.reduce((a, b) => a + b, 0) / iterDurations.length)
            : 0;
        const maxIterMs = iterDurations.length > 0 ? Math.max(...iterDurations) : 0;
        const slowIterations = this._iterationTimes
            .filter(i => i.durationMs > avgIterMs * 2)
            .map(i => ({ iteration: i.iteration, durationMs: i.durationMs }));

        // 问题诊断
        const diagnoses = [];
        if (this._errors.length > 5) {
            diagnoses.push(`高错误频率：${this._errors.length} 个错误，可能存在系统性问题`);
        }
        const toolErrors = this._errors.filter(e => e.type === 'tool_error');
        const editErrors = toolErrors.filter(e => e.toolName === 'edit_file');
        if (editErrors.length >= 2) {
            diagnoses.push(`edit_file 失败 ${editErrors.length} 次，建议检查 old_string 匹配策略`);
        }
        if (this._llmStats.errors > 2) {
            diagnoses.push(`LLM 调用失败 ${this._llmStats.errors} 次，可能存在网络或 API 配额问题`);
        }
        if (slowIterations.length > 2) {
            diagnoses.push(`${slowIterations.length} 轮迭代执行异常缓慢（超过平均 2x），建议检查长耗时工具调用`);
        }
        const excessiveReads = Object.entries(this._toolStats)
            .filter(([n]) => n === 'read_file')
            .map(([, s]) => s.count)
            .find(c => c > 10);
        if (excessiveReads) {
            diagnoses.push(`read_file 调用 ${excessiveReads} 次，存在过度读取问题`);
        }

        return {
            sessionId: this._sessionId,
            modelId: this._modelId,
            totalDurationMs: totalDuration,
            totalDurationFormatted: this._formatDuration(totalDuration),
            totalIterations: this._currentIteration,
            avgIterationMs: avgIterMs,
            maxIterationMs: maxIterMs,
            slowIterations,
            llmStats: {
                ...this._llmStats,
                avgMs: this._llmStats.calls > 0 ? Math.round(this._llmStats.totalMs / this._llmStats.calls) : 0,
            },
            tokenStats: {
                totalPrompt: this._tokenStats.totalPrompt,
                totalCompletion: this._tokenStats.totalCompletion,
                total: this._tokenStats.total,
                avgPerIteration: this._currentIteration > 0 ? Math.round(this._tokenStats.total / this._currentIteration) : 0,
                perIteration: this._tokenStats.perIteration,
            },
            toolRanking,
            totalToolCalls: Object.values(this._toolStats).reduce((s, t) => s + t.count, 0),
            totalErrors: this._errors.length,
            errorsByType: this._groupBy(this._errors, 'type'),
            diagnoses,
            logFile: this._logFile,
            htmlReport: this._htmlFile,
        };
    }

    _groupBy(arr, key) {
        const groups = {};
        for (const item of arr) {
            const k = item[key] || 'unknown';
            groups[k] = (groups[k] || 0) + 1;
        }
        return groups;
    }

    _formatDuration(ms) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const min = Math.floor(ms / 60000);
        const sec = Math.round((ms % 60000) / 1000);
        return `${min}m ${sec}s`;
    }

    // ==================== HTML 报告 ====================

    _buildHTML(analysis, finalState) {
        const stateColor = finalState === 'complete' ? '#22c55e' : finalState === 'error' ? '#ef4444' : '#f59e0b';
        const stateLabel = finalState === 'complete' ? '✅ 完成' : finalState === 'error' ? '❌ 错误' : '⚠️ 未完成';

        // 工具统计表格行
        const toolRows = (analysis.toolRanking || []).map(t =>
            `<tr>
        <td>${t.name}</td>
        <td>${t.count}</td>
        <td>${t.avgMs}ms</td>
        <td>${t.maxMs}ms</td>
        <td class="${t.errors > 0 ? 'error-text' : ''}">${t.errorRate}</td>
      </tr>`
        ).join('');

        // 错误列表
        const errorItems = this._errors.slice(0, 30).map(e =>
            `<div class="error-item">
        <span class="error-time">[${this._formatDuration(e.elapsed)}]</span>
        <span class="error-type">${e.type}</span>
        <span class="error-iter">Iter #${e.iteration}</span>
        ${e.toolName ? `<span class="error-tool">${e.toolName}</span>` : ''}
        <div class="error-msg">${this._escapeHtml(e.message || e.errorMessage || '')}</div>
      </div>`
        ).join('');

        // 迭代耗时柱状图数据
        const iterData = this._iterationTimes.map(i =>
            `{ iter: ${i.iteration}, ms: ${i.durationMs}, tools: ${i.toolCount} }`
        ).join(',');

        // 诊断结果
        const diagItems = (analysis.diagnoses || []).map(d =>
            `<div class="diag-item">⚠️ ${this._escapeHtml(d)}</div>`
        ).join('') || '<div class="diag-ok">✅ 未发现明显异常</div>';

        // 时间线（最近 100 条）
        const timelineItems = this._timeline.slice(-100).map(entry => {
            const icon = this._getTypeIcon(entry.type);
            const cls = entry.type.includes('ERROR') || entry.type.includes('FAIL') ? 'timeline-error' : '';
            const detail = entry.toolName ? ` → ${entry.toolName}` : '';
            const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : '';
            return `<div class="tl-item ${cls}">
        <span class="tl-time">${this._formatDuration(entry.elapsed)}</span>
        <span class="tl-icon">${icon}</span>
        <span class="tl-type">${entry.type}${detail}${duration}</span>
        ${entry.text ? `<span class="tl-text">${this._escapeHtml(entry.text).substring(0, 100)}</span>` : ''}
      </div>`;
        }).join('');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Agent 运行报告 - ${analysis.sessionId?.substring(0, 8) || 'unknown'}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { color: #f8fafc; font-size: 24px; margin-bottom: 8px; }
  h2 { color: #94a3b8; font-size: 18px; margin: 24px 0 12px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .state-badge { padding: 6px 16px; border-radius: 20px; font-weight: 600; background: ${stateColor}22; color: ${stateColor}; border: 1px solid ${stateColor}44; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 12px; padding: 16px; border: 1px solid #334155; }
  .card-label { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .card-value { color: #f1f5f9; font-size: 28px; font-weight: 700; margin-top: 4px; }
  .card-sub { color: #94a3b8; font-size: 12px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  th { background: #334155; color: #94a3b8; padding: 10px 14px; text-align: left; font-size: 12px; text-transform: uppercase; }
  td { padding: 10px 14px; border-top: 1px solid #334155; font-size: 14px; }
  tr:hover { background: #334155; }
  .error-text { color: #ef4444; font-weight: 600; }
  .error-item { background: #1e293b; border-left: 3px solid #ef4444; padding: 10px 14px; margin-bottom: 8px; border-radius: 0 8px 8px 0; }
  .error-time { color: #64748b; font-size: 12px; margin-right: 8px; }
  .error-type { background: #ef444422; color: #ef4444; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-right: 8px; }
  .error-iter { color: #94a3b8; font-size: 12px; margin-right: 8px; }
  .error-tool { background: #3b82f622; color: #60a5fa; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
  .error-msg { color: #cbd5e1; margin-top: 6px; font-size: 13px; word-break: break-all; }
  .diag-item { background: #f59e0b11; border-left: 3px solid #f59e0b; padding: 10px 14px; margin-bottom: 8px; border-radius: 0 8px 8px 0; color: #fbbf24; }
  .diag-ok { background: #22c55e11; border-left: 3px solid #22c55e; padding: 10px 14px; border-radius: 0 8px 8px 0; color: #86efac; }
  .tl-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid #1e293b; }
  .tl-item:hover { background: #1e293b; }
  .timeline-error { background: #ef444411; }
  .tl-time { color: #64748b; min-width: 60px; font-family: monospace; }
  .tl-icon { font-size: 14px; }
  .tl-type { color: #e2e8f0; font-weight: 500; }
  .tl-text { color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chart-container { background: #1e293b; border-radius: 12px; padding: 16px; border: 1px solid #334155; }
  .bar { display: inline-block; background: #3b82f6; border-radius: 2px; min-width: 2px; margin: 0 1px; vertical-align: bottom; }
  .bar.slow { background: #f59e0b; }
  .chart-row { display: flex; align-items: flex-end; height: 120px; gap: 2px; padding: 0 8px; }
  .timeline-container { max-height: 400px; overflow-y: auto; background: #0f172a; border-radius: 12px; border: 1px solid #334155; }
  .meta { color: #64748b; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>🔍 Agent 运行监测报告</h1>
    <div class="meta">Session: ${analysis.sessionId || 'N/A'} | Model: ${analysis.modelId || 'N/A'} | ${new Date().toLocaleString('zh-CN')}</div>
  </div>
  <span class="state-badge">${stateLabel}</span>
</div>

<div class="cards">
  <div class="card">
    <div class="card-label">总耗时</div>
    <div class="card-value">${analysis.totalDurationFormatted}</div>
  </div>
  <div class="card">
    <div class="card-label">迭代轮数</div>
    <div class="card-value">${analysis.totalIterations}</div>
    <div class="card-sub">平均 ${this._formatDuration(analysis.avgIterationMs)}/轮</div>
  </div>
  <div class="card">
    <div class="card-label">工具调用</div>
    <div class="card-value">${analysis.totalToolCalls}</div>
    <div class="card-sub">${(analysis.toolRanking || []).length} 种工具</div>
  </div>
  <div class="card">
    <div class="card-label">LLM 调用</div>
    <div class="card-value">${analysis.llmStats.calls}</div>
    <div class="card-sub">平均 ${this._formatDuration(analysis.llmStats.avgMs)}/次</div>
  </div>
  <div class="card">
    <div class="card-label">错误</div>
    <div class="card-value" style="color:${analysis.totalErrors > 0 ? '#ef4444' : '#22c55e'}">${analysis.totalErrors}</div>
  </div>
  <div class="card">
    <div class="card-label">Token 总消耗</div>
    <div class="card-value">${this._formatTokens(analysis.tokenStats?.total || 0)}</div>
    <div class="card-sub">Prompt: ${this._formatTokens(analysis.tokenStats?.totalPrompt || 0)} | Completion: ${this._formatTokens(analysis.tokenStats?.totalCompletion || 0)}</div>
  </div>
</div>

<h2>📊 迭代耗时分布</h2>
<div class="chart-container">
  <div class="chart-row" id="iterChart"></div>
</div>
<script>
  const data = [${iterData}];
  const maxMs = Math.max(...data.map(d => d.ms), 1);
  const avgMs = ${analysis.avgIterationMs};
  const chart = document.getElementById('iterChart');
  data.forEach(d => {
    const h = Math.max(4, Math.round(d.ms / maxMs * 110));
    const bar = document.createElement('div');
    bar.className = 'bar' + (d.ms > avgMs * 2 ? ' slow' : '');
    bar.style.height = h + 'px';
    bar.style.width = Math.max(8, Math.round(600 / data.length)) + 'px';
    bar.title = '#' + d.iter + ': ' + d.ms + 'ms (' + d.tools + ' tools)';
    chart.appendChild(bar);
  });
</script>

<h2>🔧 工具调用统计</h2>
<table>
  <tr><th>工具名</th><th>调用次数</th><th>平均耗时</th><th>最大耗时</th><th>错误率</th></tr>
  ${toolRows}
</table>

<h2>🩺 诊断分析</h2>
${diagItems}

${this._errors.length > 0 ? `<h2>❌ 错误详情 (${this._errors.length})</h2>${errorItems}` : ''}

<h2>📋 执行时间线 (最近 100 条)</h2>
<div class="timeline-container">${timelineItems}</div>

<div class="meta" style="margin-top:24px">
  日志文件: ${this._logFile || 'N/A'}<br>
  用户消息: ${this._escapeHtml((this._userMessage || '').substring(0, 200))}
</div>
</body></html>`;
    }

    _getTypeIcon(type) {
        const icons = {
            SESSION_START: '🚀', AGENT_STARTED: '▶️', AGENT_COMPLETE: '✅', AGENT_INCOMPLETE: '⚠️',
            AGENT_ERROR: '❌', STATE_CHANGE: '🔄', PROGRESS: '📝', LLM_RESPONSE: '🤖', LLM_FIRST_TOKEN: '⚡',
            TOOL_START: '🔧', TOOL_RESULT: '📦', ITERATION_END: '🔁', METRICS: '📊',
            SKILL_USED: '🎯', WORKFLOW: '📋', MODE_SWITCH: '🔀', ANALYSIS: '🔍',
        };
        return icons[type] || '•';
    }

    _escapeHtml(str) {
        return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

// 单例
let _monitorInstance = null;
function getRuntimeMonitor() {
    if (!_monitorInstance) _monitorInstance = new RuntimeMonitor();
    return _monitorInstance;
}

module.exports = { RuntimeMonitor, getRuntimeMonitor };
