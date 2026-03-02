/**
 * TrajectoryRecorder — 工具调用和 LLM 调用的全量轨迹记录器。
 * 用于循环检测、排查问题和分析看板。
 */
class TrajectoryRecorder {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.entries = [];
        this._maxEntries = 500;
    }

    recordToolCall({ iteration, toolName, argsHash, argsSummary, elapsed_ms, success, errorCode, tokenEstimate }) {
        this.entries.push({
            ts: Date.now(),
            iteration,
            type: 'tool_call',
            tool: toolName,
            argsHash: argsHash || null,
            argsSummary: argsSummary ? argsSummary.substring(0, 200) : null,
            elapsed_ms: elapsed_ms || 0,
            success: !!success,
            errorCode: errorCode || null,
            tokenEstimate: tokenEstimate || 0,
        });
        this._trimIfNeeded();
    }

    recordLLMCall({ iteration, elapsed_ms, hasToolCalls, toolCallCount, contentLength }) {
        this.entries.push({
            ts: Date.now(),
            iteration,
            type: 'llm_call',
            elapsed_ms: elapsed_ms || 0,
            hasToolCalls: !!hasToolCalls,
            toolCallCount: toolCallCount || 0,
            contentLength: contentLength || 0,
        });
        this._trimIfNeeded();
    }

    _trimIfNeeded() {
        if (this.entries.length > this._maxEntries) {
            this.entries = this.entries.slice(-this._maxEntries);
        }
    }

    /**
     * 时间维度循环检测：同一工具在 windowMs 内被调用 threshold+ 次
     */
    detectTimeBasedLoop(toolName, windowMs = 30000, threshold = 5) {
        const now = Date.now();
        const recent = this.entries.filter(e =>
            e.type === 'tool_call' && e.tool === toolName && (now - e.ts) < windowMs
        );
        return recent.length >= threshold;
    }

    /**
     * 成功/失败交替检测：success → fail → success → fail 模式
     */
    detectAlternatingResult(toolName, depth = 6) {
        const toolEntries = this.entries
            .filter(e => e.type === 'tool_call' && e.tool === toolName)
            .slice(-depth);
        if (toolEntries.length < depth) return false;
        return toolEntries.every((e, i) => e.success === (i % 2 === 0));
    }

    /**
     * 快速失败循环检测：最近 N 次同一工具调用总耗时 < thresholdMs
     */
    detectRapidFailLoop(toolName, count = 5, thresholdMs = 500) {
        const toolEntries = this.entries
            .filter(e => e.type === 'tool_call' && e.tool === toolName && !e.success)
            .slice(-count);
        if (toolEntries.length < count) return false;
        const totalElapsed = toolEntries.reduce((sum, e) => sum + e.elapsed_ms, 0);
        return totalElapsed < thresholdMs;
    }

    /**
     * 获取工具调用统计
     */
    getToolStats(toolName) {
        const calls = this.entries.filter(e => e.type === 'tool_call' && e.tool === toolName);
        return {
            totalCalls: calls.length,
            successCount: calls.filter(e => e.success).length,
            failCount: calls.filter(e => !e.success).length,
            totalElapsed: calls.reduce((sum, e) => sum + e.elapsed_ms, 0),
            totalTokens: calls.reduce((sum, e) => sum + e.tokenEstimate, 0),
        };
    }

    /**
     * 导出为 JSON（用于排查和分析看板）
     */
    export() {
        return {
            sessionId: this.sessionId,
            totalEntries: this.entries.length,
            entries: this.entries,
        };
    }
}

module.exports = { TrajectoryRecorder };
