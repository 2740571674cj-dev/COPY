const path = require('path');
const { CheckpointStore } = require('../core/checkpoint-store');
const { validatePath } = require('../core/security-layer');

module.exports = {
    name: 'undo_checkpoint',
    description: `Undo a previous file edit by restoring from a checkpoint snapshot.
Every edit_file, write_file, and delete_file operation automatically creates a checkpoint before modifying the file.
Use this tool to revert a file to its state before the last modification.

Rules:
1. Use this when a previous edit caused problems and needs to be reverted.
2. If no checkpoint_id is provided, the most recent checkpoint is used.
3. You can list available checkpoints by omitting checkpoint_id — the tool will show available snapshots.`,
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The file path to restore, relative to the project root.',
            },
            checkpoint_id: {
                type: 'string',
                description: 'Optional. The specific checkpoint ID to restore to. If omitted, restores to the most recent checkpoint.',
            },
            list_only: {
                type: 'boolean',
                description: 'If true, only list available checkpoints without restoring.',
            },
        },
        required: ['path'],
    },
    riskLevel: 'medium',
    timeout: 10000,

    async handler(args, projectPath) {
        const check = validatePath(args.path, projectPath);
        if (!check.valid) return check;

        const fullPath = check.resolvedPath;

        // 仅列出模式
        if (args.list_only) {
            const snapshots = CheckpointStore.list(fullPath);
            if (snapshots.length === 0) {
                return {
                    success: true,
                    message: `No checkpoints available for ${args.path}`,
                    checkpoints: [],
                };
            }
            return {
                success: true,
                message: `${snapshots.length} checkpoint(s) available for ${args.path}`,
                checkpoints: snapshots.map(s => ({
                    id: s.id,
                    time: new Date(s.timestamp).toISOString(),
                    tool: s.toolName,
                    size: s.originalSize,
                })),
            };
        }

        // 回滚
        const result = CheckpointStore.restore(fullPath, args.checkpoint_id || null);
        return result;
    },
};
