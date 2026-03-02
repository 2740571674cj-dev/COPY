const { ToolExecutor } = require('../core/tool-executor');

// 3.4: Tool tier classification — different tiers get different timeout/retry/parallel policies
const TOOL_TIERS = {
  // Tier 1: Pure local I/O, <100ms, no side effects
  local_readonly: ['read_file', 'grep_search', 'file_search', 'list_dir', 'read_lints', 'diff_history', 'codebase_search'],
  // Tier 2: Local I/O + file modifications, <1s, has side effects
  local_write: ['write_file', 'edit_file', 'delete_file', 'reapply', 'undo_checkpoint'],
  // Tier 3: Child process / network, unpredictable duration
  external: ['run_terminal_cmd', 'web_search', 'web_fetch', 'browser_use', 'generate_image'],
  // Tier 4: Control plane (affects Agent behavior)
  control: ['todo_write', 'task', 'ask_question', 'switch_mode', 'git'],
};

function getToolTier(toolName) {
  for (const [tier, tools] of Object.entries(TOOL_TIERS)) {
    if (tools.includes(toolName)) return tier;
  }
  return 'external'; // default to cautious tier
}

function createToolExecutor() {
  const executor = new ToolExecutor();

  const tools = [
    require('./read-file'),
    require('./write-file'),
    require('./edit-file'),
    require('./delete-file'),
    require('./run-terminal-cmd'),
    require('./search-files'),
    require('./glob-search'),
    require('./list-directory'),
  ];

  try { tools.push(require('./todo-manager')); } catch (_) { }
  try { tools.push(require('./task-delegation')); } catch (_) { }
  try { tools.push(require('./web-search')); } catch (_) { }
  try { tools.push(require('./web-fetch')); } catch (_) { }
  try { tools.push(require('./browser-use')); } catch (_) { }
  try { tools.push(require('./generate-image')); } catch (_) { }
  try { tools.push(require('./git-operations')); } catch (_) { }
  try { tools.push(require('./read-lints')); } catch (_) { }
  try { tools.push(require('./diff-history')); } catch (_) { }
  try { tools.push(require('./reapply')); } catch (_) { }
  try { tools.push(require('./ask-question')); } catch (_) { }
  try { tools.push(require('./switch-mode')); } catch (_) { }
  try { tools.push(require('./semantic-search')); } catch (_) { }
  try { tools.push(require('./undo-checkpoint')); } catch (_) { }

  for (const tool of tools) {
    executor.register(tool);
  }

  return executor;
}

module.exports = { createToolExecutor, TOOL_TIERS, getToolTier };

