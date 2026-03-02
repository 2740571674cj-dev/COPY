const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

module.exports = {
  name: 'write_file',
  description: `Write a file to the filesystem. This tool will overwrite the existing file if there is one at the provided path. Parent directories are created automatically.

Rules:
1. ALWAYS prefer edit_file for modifying existing files. Only use write_file when creating a new file or when edit_file has failed 3+ times.
2. NEVER write new files unless explicitly required by the task.
3. When overwriting, include the COMPLETE file content — partial content will corrupt the file.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The target file path, relative to the project root.' },
      content: { type: 'string', description: 'The full content to write to the file.' },
      explanation: { type: 'string', description: 'One sentence explanation as to why this tool is being used.' },
    },
    required: ['path', 'content'],
  },
  riskLevel: 'medium',
  timeout: 10000,

  async handler(args, projectPath) {
    const check = validatePath(args.path, projectPath);
    if (!check.valid) return check;

    const fullPath = check.resolvedPath;

    // Layer 6.4: Large file write protection
    if (fs.existsSync(fullPath)) {
      try {
        const existing = fs.readFileSync(fullPath, 'utf-8');
        const existingLines = existing.split('\n').length;
        if (existingLines > 500) {
          const ratio = args.content.length / existing.length;
          if (ratio < 0.3) {
            return {
              success: false,
              error: `File has ${existingLines} lines but new content is only ${Math.round(ratio * 100)}% of original. This looks like partial content. Use edit_file or re-read the file first.`,
              code: 'E_PARTIAL_OVERWRITE',
            };
          }
        }
      } catch (_) { /* file read failed, proceed with write */ }
    }

    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Checkpoint: 覆盖写入前保存快照（仅已存在的文件）
      if (fs.existsSync(fullPath)) {
        try {
          const { CheckpointStore } = require('../core/checkpoint-store');
          CheckpointStore.save(fullPath, { toolName: 'write_file', projectPath });
          CheckpointStore.ensureGitignore(projectPath);
        } catch (_) { }
      }

      fs.writeFileSync(fullPath, args.content, 'utf-8');

      const readback = fs.readFileSync(fullPath, 'utf-8');
      if (readback !== args.content) {
        return { success: false, error: 'Write verification failed — file content mismatch', code: 'E_VERIFY_FAILED' };
      }

      return { success: true, path: args.path, bytesWritten: Buffer.byteLength(args.content, 'utf-8') };
    } catch (err) {
      return { success: false, error: `Write failed: ${err.message}`, code: 'E_WRITE_FAILED' };
    }
  },
};
