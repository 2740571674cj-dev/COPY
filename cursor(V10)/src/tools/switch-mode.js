module.exports = {
  name: 'switch_mode',
  description: `Switch the interaction mode to better match the current task. Use this to proactively suggest switching to Plan mode when the task has multiple valid approaches with significant trade-offs, requires architectural decisions, or the requirements are unclear. The switch requires user approval before taking effect.

Available target modes:
- "plan": Read-only collaborative mode for designing implementation approaches before coding. Use when: multiple valid approaches exist, architecture decisions needed, large refactors, unclear requirements.

Do NOT switch when: the task is simple and clear, you're making good progress, or the current mode is working well.`,
  parameters: {
    type: 'object',
    properties: {
      target_mode: {
        type: 'string',
        enum: ['plan'],
        description: 'The mode to switch to.',
      },
      explanation: {
        type: 'string',
        description: 'Brief explanation of why this mode switch is recommended. Shown to the user for approval.',
      },
    },
    required: ['target_mode', 'explanation'],
  },
  riskLevel: 'safe',
  timeout: 300000,

  async handler(args, projectPath, context) {
    const { target_mode, explanation } = args;

    const validModes = ['plan'];
    if (!validModes.includes(target_mode)) {
      return {
        success: false,
        error: `Invalid target mode: ${target_mode}. Available: ${validModes.join(', ')}`,
        code: 'E_INVALID_MODE',
      };
    }

    return {
      success: true,
      type: 'switch_mode',
      target_mode,
      explanation: explanation || '',
      awaiting_approval: true,
    };
  },
};
