class TodoStore {
  constructor() {
    this.todos = [];
    this.listeners = new Set();
  }

  get() { return [...this.todos]; }

  set(todos) {
    this.todos = Array.isArray(todos) ? todos : [];
    this._notify();
  }

  getByStatus(status) {
    return this.todos.filter(t => t.status === status);
  }

  getProgress() {
    const total = this.todos.length;
    if (total === 0) return { total: 0, completed: 0, inProgress: 0, pending: 0, percent: 0 };
    const completed = this.todos.filter(t => t.status === 'completed').length;
    const inProgress = this.todos.filter(t => t.status === 'in_progress').length;
    const cancelled = this.todos.filter(t => t.status === 'cancelled').length;
    const pending = total - completed - inProgress - cancelled;
    return { total, completed, inProgress, pending, cancelled, percent: Math.round((completed / total) * 100) };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notify() {
    for (const listener of this.listeners) {
      try { listener(this.todos); } catch (_) {}
    }
  }

  reset() {
    this.todos = [];
    this._notify();
  }
}

module.exports = { TodoStore };
