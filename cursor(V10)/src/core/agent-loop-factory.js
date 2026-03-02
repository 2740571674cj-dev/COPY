const { AgentLoopController } = require('./agent-loop-controller');
const { ToolExecutor } = require('./tool-executor');
const { TodoStore } = require('./todo-store');

class AgentLoopFactory {
  constructor({ llmGateway, toolExecutor, promptAssembler, contextEngine, securityLayer }) {
    this.deps = { llmGateway, toolExecutor, promptAssembler, contextEngine, securityLayer };
  }

  create({ projectPath, modelId, maxIterations, maxTokenBudget, responseTokenReserve, readonly, allowedTools, subAgentDepth, emitter }) {
    let toolExec;
    if (allowedTools === '__exclude_task__') {
      // Get all tool names, filter out 'task' to prevent recursive nesting
      const allTools = this.deps.toolExecutor.getAllToolNames
        ? this.deps.toolExecutor.getAllToolNames()
        : [];
      toolExec = this._createFilteredExecutor(allTools.filter(n => n !== 'task'));
    } else if (allowedTools && Array.isArray(allowedTools)) {
      toolExec = this._createFilteredExecutor(allowedTools);
    } else if (readonly) {
      toolExec = this._createFilteredExecutor(['read_file', 'search_files', 'grep_search', 'glob_search', 'file_search', 'list_directory', 'list_dir', 'read_lints']);
    } else {
      toolExec = this.deps.toolExecutor;
    }

    const agent = new AgentLoopController({
      llmGateway: this.deps.llmGateway,
      toolExecutor: toolExec,
      promptAssembler: this.deps.promptAssembler,
      contextEngine: this.deps.contextEngine,
      config: {
        maxIterations: maxIterations || 15,
        maxTokenBudget: maxTokenBudget || 64000,
        responseTokenReserve: responseTokenReserve || 2048,
        subAgentDepth: subAgentDepth || 0,
        agentLoopFactory: this,
        todoStore: new TodoStore(),
      },
    });

    if (emitter) agent.setEmitter(emitter);
    agent.projectPath = projectPath;
    agent.modelId = modelId;

    return {
      async run(prompt) {
        return agent.start({
          sessionId: `sub_${Date.now()}`,
          modelId,
          userMessage: prompt,
          projectPath,
          mode: 'agent',
          autoApprove: true,
        });
      },
      setEmitter(fn) { agent.setEmitter(fn); },
      cancel() { agent.cancel(); },
      destroy() { agent.destroy(); },
    };
  }

  _createFilteredExecutor(toolNames) {
    const filtered = new ToolExecutor();
    for (const name of toolNames) {
      const tool = this.deps.toolExecutor.getTool(name);
      if (tool) filtered.register(tool);
    }
    return filtered;
  }
}

module.exports = { AgentLoopFactory };
