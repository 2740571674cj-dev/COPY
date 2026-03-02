const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class WorkflowStore {
  constructor(storePath) {
    this.storePath = storePath;
    this.workflows = [];
    this._load();
  }

  _load() {
    try {
      if (this.storePath && fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        this.workflows = Array.isArray(parsed) ? parsed : [];
      }
    } catch (_) {
      this.workflows = [];
    }
  }

  _save() {
    try {
      if (!this.storePath) return;
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.workflows, null, 2), 'utf-8');
    } catch (e) {
      console.error('[WorkflowStore] Save failed:', e.message);
    }
  }

  list() {
    return this.workflows.map(wf => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      activeVersionId: wf.activeVersionId,
      versionCount: wf.versions?.length || 0,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
    }));
  }

  get(id) {
    return this.workflows.find(wf => wf.id === id) || null;
  }

  create({ name, description, steps, modelId }) {
    const now = new Date().toISOString();
    const versionId = randomUUID();
    const wf = {
      id: randomUUID(),
      name: name || '未命名工作流',
      description: description || '',
      activeVersionId: versionId,
      versions: [{
        id: versionId,
        label: 'v1',
        steps: steps || [],
        createdAt: now,
        modelId: modelId || null,
      }],
      createdAt: now,
      updatedAt: now,
    };
    this.workflows.push(wf);
    this._save();
    return wf;
  }

  update(id, updates) {
    const wf = this.workflows.find(w => w.id === id);
    if (!wf) return null;
    if (updates.name !== undefined) wf.name = updates.name;
    if (updates.description !== undefined) wf.description = updates.description;
    if (updates.activeVersionId !== undefined) wf.activeVersionId = updates.activeVersionId;
    wf.updatedAt = new Date().toISOString();
    this._save();
    return wf;
  }

  delete(id) {
    const idx = this.workflows.findIndex(w => w.id === id);
    if (idx === -1) return false;
    this.workflows.splice(idx, 1);
    this._save();
    return true;
  }

  // 更新当前活跃版本的步骤（不创建新版本）
  updateActiveVersion(workflowId, { steps, modelId }) {
    const wf = this.workflows.find(w => w.id === workflowId);
    if (!wf) return null;
    const ver = wf.versions.find(v => v.id === wf.activeVersionId);
    if (!ver) return null;
    if (steps !== undefined) ver.steps = steps;
    if (modelId !== undefined) ver.modelId = modelId;
    wf.updatedAt = new Date().toISOString();
    this._save();
    return ver;
  }

  // --- 版本管理 ---

  saveVersion(workflowId, { steps, label, modelId }) {
    const wf = this.workflows.find(w => w.id === workflowId);
    if (!wf) return null;
    const versionId = randomUUID();
    const vNum = wf.versions.length + 1;
    const version = {
      id: versionId,
      label: label || `v${vNum}`,
      steps: steps || [],
      createdAt: new Date().toISOString(),
      modelId: modelId || null,
    };
    wf.versions.push(version);
    wf.activeVersionId = versionId;
    wf.updatedAt = new Date().toISOString();
    this._save();
    return version;
  }

  deleteVersion(workflowId, versionId) {
    const wf = this.workflows.find(w => w.id === workflowId);
    if (!wf) return false;
    const idx = wf.versions.findIndex(v => v.id === versionId);
    if (idx === -1) return false;
    wf.versions.splice(idx, 1);
    if (wf.activeVersionId === versionId) {
      wf.activeVersionId = wf.versions.length > 0 ? wf.versions[wf.versions.length - 1].id : null;
    }
    wf.updatedAt = new Date().toISOString();
    this._save();
    return true;
  }

  getActiveSteps(workflowId) {
    const wf = this.workflows.find(w => w.id === workflowId);
    if (!wf) return null;
    const ver = wf.versions.find(v => v.id === wf.activeVersionId);
    return ver ? ver.steps : null;
  }

  // 根据任务描述匹配工作流（由 agent 调用）
  matchWorkflow(taskDescription) {
    if (!taskDescription || this.workflows.length === 0) return null;
    const desc = taskDescription.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const wf of this.workflows) {
      if (!wf.activeVersionId) continue;
      const keywords = (wf.name + ' ' + wf.description).toLowerCase().split(/\s+/);
      let score = 0;
      for (const kw of keywords) {
        if (kw.length >= 2 && desc.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = wf;
      }
    }

    return bestScore >= 2 ? bestMatch : null;
  }
}

module.exports = { WorkflowStore };
