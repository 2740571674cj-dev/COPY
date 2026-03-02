module.exports = {
  name: 'ask_question',
  description: `Collect structured multiple-choice answers from the user. Provide one or more questions with options. Use when you need to gather specific information through a structured format — for example, choosing between implementation approaches, confirming configuration options, or clarifying ambiguous requirements. Each question should have a unique id, clear prompt, and at least 2 options.`,
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional title for the questions form.',
      },
      questions: {
        type: 'array',
        description: 'Array of questions to present to the user (minimum 1).',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier for this question.' },
            prompt: { type: 'string', description: 'The question text to display.' },
            options: {
              type: 'array',
              description: 'Array of answer options (minimum 2).',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Unique identifier for this option.' },
                  label: { type: 'string', description: 'Display text for this option.' },
                },
                required: ['id', 'label'],
              },
            },
            allow_multiple: {
              type: 'boolean',
              description: 'If true, user can select multiple options. Defaults to false.',
            },
          },
          required: ['id', 'prompt', 'options'],
        },
      },
      explanation: { type: 'string', description: 'One sentence explaining why this question is needed.' },
    },
    required: ['questions'],
  },
  riskLevel: 'safe',
  timeout: 300000,

  async handler(args, projectPath, context) {
    const questions = args.questions;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return { success: false, error: 'At least one question is required', code: 'E_NO_QUESTIONS' };
    }

    for (const q of questions) {
      if (!q.id || !q.prompt) {
        return { success: false, error: `Question missing id or prompt`, code: 'E_INVALID_QUESTION' };
      }
      if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
        return { success: false, error: `Question "${q.id}" needs at least 2 options`, code: 'E_TOO_FEW_OPTIONS' };
      }
    }

    return {
      success: true,
      type: 'ask_question',
      title: args.title || null,
      questions: questions.map(q => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options.map(o => ({ id: o.id, label: o.label })),
        allow_multiple: q.allow_multiple || false,
      })),
      awaiting_response: true,
    };
  },
};
