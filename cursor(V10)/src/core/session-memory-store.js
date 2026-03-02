const fs = require('fs');
const path = require('path');

class SessionMemoryStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  _sessionDir(sessionId) {
    const sanitized = String(sessionId).replace(/[\/\\\.]+/g, '_');
    const dir = path.join(this.baseDir, sanitized);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  _summaryPath(sessionId) {
    return path.join(this._sessionDir(sessionId), 'summary.json');
  }

  /**
   * 获取会话记忆摘要
   * 返回 { background, keyDecisions, fileChanges, pendingIssues, progress, lastUpdated }
   */
  getSummary(sessionId) {
    try {
      const p = this._summaryPath(sessionId);
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch (_) {}
    return null;
  }

  /**
   * 保存/更新会话记忆摘要
   */
  saveSummary(sessionId, summary) {
    try {
      const p = this._summaryPath(sessionId);
      const data = {
        ...summary,
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[SessionMemory] Save failed:', e.message);
      return false;
    }
  }

  /**
   * 追加一次执行记录到会话记忆
   */
  appendExecution(sessionId, { userRequest, completedTasks, fileChanges, keyFindings, pendingIssues, projectStructure }) {
    const existing = this.getSummary(sessionId) || {
      background: '',
      executions: [],
      cumulativeFileChanges: [],
      pendingIssues: [],
      projectStructure: '',
      keyFilesRead: [],
    };

    const execution = {
      timestamp: new Date().toISOString(),
      userRequest: (userRequest || '').substring(0, 500),
      completedTasks: completedTasks || [],
      fileChanges: fileChanges || [],
      keyFindings: keyFindings || [],
      pendingIssues: pendingIssues || [],
    };

    existing.executions = existing.executions || [];
    existing.executions.push(execution);

    if (existing.executions.length > 20) {
      existing.executions = existing.executions.slice(-20);
    }

    const allFiles = new Set(existing.cumulativeFileChanges || []);
    for (const f of (fileChanges || [])) allFiles.add(f);
    existing.cumulativeFileChanges = [...allFiles];

    existing.pendingIssues = pendingIssues || existing.pendingIssues;

    if (projectStructure) {
      existing.projectStructure = projectStructure;
    }

    this.saveSummary(sessionId, existing);
    return existing;
  }

  appendReadFiles(sessionId, filePaths) {
    const existing = this.getSummary(sessionId);
    if (!existing) return;

    const readSet = new Set(existing.keyFilesRead || []);
    for (const f of filePaths) readSet.add(f);
    existing.keyFilesRead = [...readSet].slice(-30);
    this.saveSummary(sessionId, existing);
  }

  /**
   * 更新背景描述（通常由 AI 生成）
   */
  updateBackground(sessionId, background) {
    const existing = this.getSummary(sessionId) || {
      executions: [],
      cumulativeFileChanges: [],
      pendingIssues: [],
    };
    existing.background = background;
    this.saveSummary(sessionId, existing);
  }

  /**
   * 格式化为可注入 prompt 的文本
   */
  formatForPrompt(sessionId) {
    const summary = this.getSummary(sessionId);
    if (!summary) return '';

    const parts = ['[会话记忆] 以下是本次会话的历史上下文摘要。你已经了解这个项目，不需要重新探索已知部分。'];

    if (summary.background) {
      parts.push(`\n## 项目背景\n${summary.background}`);
    }

    if (summary.projectStructure) {
      parts.push(`\n## 项目结构\n${summary.projectStructure}`);
    }

    if (summary.keyFilesRead && summary.keyFilesRead.length > 0) {
      parts.push(`\n## 你已读过的关键文件\n${summary.keyFilesRead.slice(-20).join('、')}\n（这些文件你已经了解过内容，除非需要查看最新修改，否则不需要重新读取。）`);
    }

    if (summary.cumulativeFileChanges && summary.cumulativeFileChanges.length > 0) {
      const files = summary.cumulativeFileChanges.slice(-20);
      parts.push(`\n## 本会话已修改的文件\n${files.join('、')}`);
    }

    if (summary.executions && summary.executions.length > 0) {
      parts.push('\n## 历史执行摘要');
      const recent = summary.executions.slice(-8);
      for (const exec of recent) {
        if (!exec || typeof exec !== 'object') continue;
        const time = typeof exec.timestamp === 'string' ? exec.timestamp.substring(5, 16).replace('T', ' ') : '??';
        parts.push(`\n• [${time}] ${exec.userRequest || '(unknown)'}`);
        const tasks = Array.isArray(exec.completedTasks) ? exec.completedTasks : [];
        if (tasks.length > 0) {
          parts.push(`  完成：${tasks.slice(0, 8).join('、')}`);
        }
        if (Array.isArray(exec.fileChanges) && exec.fileChanges.length > 0) {
          parts.push(`  改动：${exec.fileChanges.slice(0, 5).join('、')}`);
        }
        const findings = Array.isArray(exec.keyFindings) ? exec.keyFindings : [];
        if (findings.length > 0) {
          parts.push(`  发现：${findings.slice(0, 3).join('；')}`);
        }
      }
    }

    if (summary.pendingIssues && summary.pendingIssues.length > 0) {
      parts.push(`\n## 待解决问题\n${summary.pendingIssues.map(i => `- ${i}`).join('\n')}`);
    }

    parts.push('\n---\n重要：基于以上记忆继续工作。不要重复读取你已经了解的文件，除非它们可能已被修改。');

    return parts.join('\n');
  }

  /**
   * 删除会话记忆
   */
  deleteSession(sessionId) {
    try {
      const sanitized = String(sessionId).replace(/[\/\\\.]+/g, '_');
      const dir = path.join(this.baseDir, sanitized);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  /**
   * 列出所有有记忆的会话 ID
   */
  listSessions() {
    try {
      return fs.readdirSync(this.baseDir).filter(d => {
        const stat = fs.statSync(path.join(this.baseDir, d));
        return stat.isDirectory();
      });
    } catch (_) {
      return [];
    }
  }
}

module.exports = { SessionMemoryStore };
