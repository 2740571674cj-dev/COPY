const fs = require('fs');
const { validatePath } = require('../core/security-layer');

module.exports = {
  name: 'delete_file',
  description: `Delete a file at the specified path. The file must exist and be within the project directory.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path of the file to delete, relative to the project root.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used.' },
    },
    required: ['path'],
  },
  riskLevel: 'high',
  timeout: 5000,

  async handler(args, projectPath) {
    const check = validatePath(args.path, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${args.path}`, code: 'E_FILE_NOT_FOUND' };
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory. Use run_terminal_cmd with rmdir if needed.', code: 'E_IS_DIRECTORY' };
    }

    // Checkpoint: 删除前保存快照
    try {
      const { CheckpointStore } = require('../core/checkpoint-store');
      CheckpointStore.save(fullPath, { toolName: 'delete_file', projectPath });
    } catch (_) { }

    try {
      fs.unlinkSync(fullPath);
      return { success: true, path: args.path };
    } catch (err) {
      return { success: false, error: `Delete failed: ${err.message}`, code: 'E_DELETE_FAILED' };
    }
  },
};
