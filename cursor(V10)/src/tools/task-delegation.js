const SUBAGENT_TYPES = {
  explore: {
    description: 'Fast agent for codebase exploration — finding files, searching code, answering questions about the codebase.',
    allowedTools: ['read_file', 'search_files', 'grep_search', 'glob_search', 'file_search', 'list_directory', 'list_dir', 'read_lints'],
    defaultModel: 'fast',
    defaultIterations: 10,
    readonly: true,
  },
  general: {
    description: 'General-purpose agent for complex multi-step tasks with full tool access.',
    allowedTools: null,
    defaultModel: 'default',
    defaultIterations: 20,
    readonly: false,
  },
  shell: {
    description: 'Command execution specialist for running bash/terminal commands.',
    allowedTools: ['run_terminal_cmd', 'read_file'],
    defaultModel: 'fast',
    defaultIterations: 8,
    readonly: false,
  },
};

module.exports = {
  name: 'task',
  description: `Launch a sub-agent to handle a complex sub-task autonomously. Each sub-agent runs with its own context window. Available subagent_type values:
- "explore": Fast codebase exploration (file search, code search, reading). Readonly. Use for gathering context from unfamiliar codebases.
- "general": Full-capability agent for multi-step tasks. Use for complex changes that would fill your context.
- "shell": Command execution specialist. Use for running terminal commands.
Do NOT use for simple operations — use the other tools directly.
You can launch multiple sub-agents concurrently (up to 4) by requesting multiple task calls in one round.`,
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short (3-5 word) description of the sub-task.',
      },
      prompt: {
        type: 'string',
        description: 'Detailed instructions for the sub-agent. Include ALL context needed since it cannot see the parent conversation.',
      },
      subagent_type: {
        type: 'string',
        enum: ['explore', 'general', 'shell'],
        description: 'Type of sub-agent to use. Defaults to "general".',
      },
      model: {
        type: 'string',
        enum: ['default', 'fast'],
        description: 'Model to use. "fast" for quick/simple tasks (lower cost), "default" for complex ones.',
      },
      readonly: {
        type: 'boolean',
        description: 'If true, sub-agent can only read files and search, not modify anything. Overrides subagent_type default.',
      },
      explanation: {
        type: 'string',
        description: 'One sentence explaining why a sub-agent is needed for this task.',
      },
    },
    required: ['description', 'prompt'],
  },
  riskLevel: 'medium',
  timeout: 300000,

  async handler(args, projectPath, context) {
    const { agentLoopFactory, modelId, parentEmitter } = context || {};

    if (!agentLoopFactory) {
      return { success: false, error: 'Sub-agent system not available', code: 'E_NO_FACTORY' };
    }

    // Recursive depth limit to prevent agent storms
    const currentDepth = (context?.subAgentDepth || 0);
    const MAX_DEPTH = 3;
    if (currentDepth >= MAX_DEPTH) {
      return {
        success: false,
        error: `Sub-agent depth limit reached (max ${MAX_DEPTH}). Cannot nest further. Complete this task directly using available tools.`,
        code: 'E_MAX_DEPTH',
      };
    }

    const typeName = args.subagent_type || 'general';
    const typeConfig = SUBAGENT_TYPES[typeName];
    if (!typeConfig) {
      return { success: false, error: `Unknown subagent_type: ${typeName}. Use: explore, general, shell`, code: 'E_INVALID_TYPE' };
    }

    const useReadonly = args.readonly !== undefined ? args.readonly : typeConfig.readonly;
    const useModel = args.model || typeConfig.defaultModel;

    const effectiveModelId = useModel === 'fast'
      ? this._selectFastModel(modelId)
      : modelId;

    // At depth ≥2, strip 'task' tool from general agents to prevent further nesting
    let allowedTools = typeConfig.allowedTools;
    if (!allowedTools && currentDepth >= 1) {
      // null means "all tools" — we need to explicitly exclude 'task'
      allowedTools = '__exclude_task__';
    }

    const subAgent = agentLoopFactory.create({
      projectPath,
      modelId: effectiveModelId,
      maxIterations: typeConfig.defaultIterations,
      readonly: useReadonly,
      allowedTools,
      subAgentDepth: currentDepth + 1,
    });

    // Layer 5: Forward sub-agent progress-note events to parent with prefix
    if (parentEmitter) {
      subAgent.setEmitter((event, data) => {
        if (event === 'progress-note') {
          parentEmitter('progress-note', { ...data, text: `[Sub-agent] ${data.text || ''}` });
        }
      });
    }

    try {
      // Propagate parent abort signal to sub-agent
      const parentSignal = context?.signal;
      if (parentSignal) {
        const onAbort = () => subAgent.cancel();
        if (parentSignal.aborted) {
          subAgent.cancel();
        } else {
          parentSignal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const result = await subAgent.run(args.prompt);
      return {
        success: result.success,
        subagent_type: typeName,
        content: result.finalContent || '',
        iterations: result.iteration,
        toolsUsed: result.toolCallCount,
        error: result.error,
      };
    } catch (err) {
      return { success: false, error: `Sub-agent failed: ${err.message}`, code: 'E_SUBAGENT_FAIL' };
    } finally {
      subAgent.destroy();
    }
  },

  _selectFastModel(parentModelId) {
    if (!parentModelId) return parentModelId;
    const fastMappings = {
      'gpt-4o': 'gpt-4o-mini',
      'gpt-4': 'gpt-4o-mini',
      'gpt-4.1': 'gpt-4.1-mini',
      'o3': 'o4-mini',
      'o4-mini': 'o4-mini',
      'claude-3-opus': 'claude-3-haiku',
      'claude-3.5-sonnet': 'claude-3-haiku',
      'claude-sonnet-4': 'claude-3.5-haiku',
      'claude-4': 'claude-3.5-haiku',
      'gemini-2.5-pro': 'gemini-2.0-flash',
      'gemini-2.0-pro': 'gemini-2.0-flash',
      'gemini-2.5-flash': 'gemini-2.0-flash',
      'deepseek-r1': 'deepseek-v3',
      'deepseek-v3': 'deepseek-v3',
    };
    for (const [prefix, fast] of Object.entries(fastMappings)) {
      if (parentModelId.toLowerCase().includes(prefix.toLowerCase())) return fast;
    }
    return parentModelId;
  },
};
