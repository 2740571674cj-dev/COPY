const path = require('path');
const { getSemanticIndexService } = require('../core/semantic-index');

const semanticIndex = getSemanticIndexService();

module.exports = {
  name: 'codebase_search',
  description: `Find relevant code snippets by semantic meaning. Use natural language queries to search the codebase (e.g., "where is user authentication handled?" or "database connection setup"). This is best for understanding code structure when you don't know exact names. For exact text matching, use grep_search instead.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A natural language description of what you are looking for. Be specific and complete.',
      },
      target_directory: {
        type: 'string',
        description: 'Optional directory to search within, relative to project root.',
      },
      explanation: {
        type: 'string',
        description: 'One sentence explanation as to why this tool is being used.',
      },
    },
    required: ['query'],
  },
  riskLevel: 'safe',
  timeout: 30000,

  async handler(args, projectPath) {
    const query = (args.query || '').trim();
    if (!query || query.trim().length < 2) {
      return { success: false, error: 'Query must be at least 2 characters', code: 'E_INVALID_QUERY' };
    }

    const searchDir = args.target_directory
      ? path.resolve(projectPath, args.target_directory)
      : projectPath;

    const fs = require('fs');
    if (!fs.existsSync(searchDir)) {
      return { success: false, error: `Directory not found: ${args.target_directory || projectPath}`, code: 'E_DIR_NOT_FOUND' };
    }

    const relPrefix = args.target_directory
      ? path.relative(projectPath, searchDir).replace(/\\/g, '/')
      : '';
    const { results, stats } = semanticIndex.search(projectPath, query, {
      pathPrefix: relPrefix && relPrefix !== '.' ? relPrefix : '',
      maxResults: 10,
      maxChunks: 60,
    });

    return {
      success: true,
      results: results.map(r => ({
        file: r.file,
        score: r.score,
        lines: r.lines,
      })),
      totalFilesScanned: stats.scannedFiles || 0,
      totalMatches: results.length,
      indexStats: {
        totalChunks: stats.totalChunks || 0,
        candidates: stats.candidates || 0,
      },
    };
  },
};
