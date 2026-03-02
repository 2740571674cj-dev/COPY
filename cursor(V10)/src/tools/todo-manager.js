module.exports = {
  name: 'todo_write',
  description: `Create or update a structured task list. Use to track progress on multi-step operations. Each todo has: id, content, status (pending/in_progress/completed/cancelled). Set merge=true to update existing todos; merge=false to replace all. Best practice: mark items in_progress before completed.`,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier.' },
            content: { type: 'string', description: 'Task description.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
          required: ['id', 'content', 'status'],
        },
        description: 'Array of TODO items.',
      },
      merge: {
        type: 'boolean',
        description: 'If true, merge with existing todos by id. If false, replace all.',
      },
      step_id: {
        type: 'string',
        description: 'Optional workflow step id to explicitly mark current workflow progress.',
      },
      stepId: {
        type: 'string',
        description: 'Alias of step_id for compatibility.',
      },
    },
    required: ['todos', 'merge'],
  },
  riskLevel: 'safe',
  timeout: 1000,

  async handler(args, projectPath, context) {
    const { todoStore } = context || {};
    const explicitStepId = args.step_id || args.stepId || null;
    if (!todoStore) {
      return {
        success: true,
        note: 'TodoStore not available — todos recorded but not persisted to UI',
        ...(explicitStepId ? { stepId: explicitStepId } : {}),
      };
    }

    const existing = todoStore.get();
    const existingById = new Map(existing.map(item => [item.id, item]));
    const rollbackConflicts = args.todos
      .filter(newTodo => {
        const oldTodo = existingById.get(newTodo.id);
        if (!oldTodo) return false;
        return oldTodo.status === 'completed' && (newTodo.status === 'pending' || newTodo.status === 'in_progress');
      })
      .map(t => ({ id: t.id, targetStatus: t.status }));

    if (rollbackConflicts.length > 0) {
      const details = rollbackConflicts.map(c => `[${c.id}] -> ${c.targetStatus}`).join(', ');
      return {
        success: false,
        error: `Forbidden status rollback from completed: ${details}`,
        code: 'E_TODO_ROLLBACK_FORBIDDEN',
        conflicts: rollbackConflicts,
        ...(explicitStepId ? { stepId: explicitStepId } : {}),
      };
    }

    if (args.merge) {
      const merged = [...existing];
      const warnings = [];
      const completedInBatch = args.todos.filter(t => t.status === 'completed').length;
      let batchCompletedWarned = false;

      for (const newTodo of args.todos) {
        const idx = merged.findIndex(t => t.id === newTodo.id);
        if (idx >= 0) {
          const oldStatus = merged[idx].status;
          const newStatus = newTodo.status;

          // 引导：pending → completed 跳过 in_progress（warning 但允许执行）
          if (oldStatus === 'pending' && newStatus === 'completed') {
            warnings.push(`[${newTodo.id}] pending → completed 跳过了 in_progress，建议先标记 in_progress`);
          }

          // 引导：一次多个 completed（warning 但允许执行）
          if (completedInBatch > 1 && newStatus === 'completed' && oldStatus !== 'completed') {
            if (!batchCompletedWarned) {
              warnings.push(`本次同时标记 ${completedInBatch} 个 completed，建议逐步完成以获得更好的进度追踪`);
              batchCompletedWarned = true;
            }
          }

          merged[idx] = { ...merged[idx], ...newTodo };
        } else {
          if (newTodo.status === 'completed') {
            warnings.push(`[${newTodo.id}] 新建项直接标记为 completed，建议先标记 in_progress`);
          }
          merged.push(newTodo);
        }
      }
      todoStore.set(merged);
      const progress = todoStore.getProgress();
      return {
        success: true,
        count: progress.total,
        completed: progress.completed,
        percent: progress.percent,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(explicitStepId ? { stepId: explicitStepId } : {}),
      };
    } else {
      todoStore.set(args.todos);
    }

    const progress = todoStore.getProgress();
    return {
      success: true,
      count: progress.total,
      completed: progress.completed,
      percent: progress.percent,
      ...(explicitStepId ? { stepId: explicitStepId } : {}),
    };
  },
};
