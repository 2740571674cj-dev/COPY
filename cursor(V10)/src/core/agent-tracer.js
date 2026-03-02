const fs = require('fs');
const path = require('path');

class AgentTracer {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.startTime = Date.now();
    this.spans = [];
    this.currentSpan = null;
  }

  startSpan(name, meta = {}) {
    const span = {
      id: `span_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      startTime: Date.now(),
      endTime: null,
      duration: null,
      meta,
      children: [],
      status: 'running',
    };
    if (this.currentSpan) {
      this.currentSpan.children.push(span);
    }
    this.spans.push(span);
    const parent = this.currentSpan;
    this.currentSpan = span;
    return {
      end: (result = {}) => {
        if (span.status !== 'running') return;
        span.endTime = Date.now();
        span.duration = span.endTime - span.startTime;
        span.status = result.error ? 'error' : 'ok';
        span.result = result;
        if (this.currentSpan === span) {
          this.currentSpan = parent;
        }
      },
    };
  }

  log(level, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      sessionId: this.sessionId,
      message,
      data,
      spanId: this.currentSpan?.id || null,
    };
    console[level === 'error' ? 'error' : 'log'](`[Agent:${level}] ${message}`, data);
    return entry;
  }

  info(message, data) { return this.log('info', message, data); }
  warn(message, data) { return this.log('warn', message, data); }
  error(message, data) { return this.log('error', message, data); }

  getSummary() {
    return {
      sessionId: this.sessionId,
      totalDuration: Date.now() - this.startTime,
      spanCount: this.spans.length,
      spans: this.spans.map(s => ({
        name: s.name,
        duration: s.duration,
        status: s.status,
      })),
    };
  }
}

module.exports = { AgentTracer };
