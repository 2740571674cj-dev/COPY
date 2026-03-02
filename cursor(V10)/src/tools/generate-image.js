const fs = require('fs');
const path = require('path');
const { validatePath } = require('../core/security-layer');

module.exports = {
  name: 'generate_image',
  description: `Generate an image from a text description. ONLY use when the user explicitly asks for an image. Do NOT generate images proactively. Do NOT use for data visualizations — generate those with code instead.`,
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Detailed description of the image to generate.',
      },
      filename: {
        type: 'string',
        description: 'Output filename (e.g. "icon.png"). Saved in project root.',
      },
    },
    required: ['description'],
  },
  riskLevel: 'low',
  timeout: 60000,

  async handler(args, projectPath) {
    const filename = args.filename || `generated_${Date.now()}.png`;
    const pathCheck = validatePath(filename, projectPath);
    if (!pathCheck.valid) return pathCheck;
    const outputPath = pathCheck.resolvedPath;

    const providers = [
      () => this._openaiDalle(args.description),
    ];

    for (const provider of providers) {
      try {
        const imageData = await provider();
        if (imageData) {
          const outputDir = path.dirname(outputPath);
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          const buffer = Buffer.from(imageData, 'base64');
          fs.writeFileSync(outputPath, buffer);
          const relativePath = path.relative(projectPath, outputPath).replace(/\\/g, '/');
          return {
            success: true,
            path: relativePath,
            absolutePath: outputPath,
            size: buffer.length,
          };
        }
      } catch (_) {
        continue;
      }
    }

    return {
      success: false,
      error: 'Image generation not configured. To enable, configure an image generation API key in settings.',
      code: 'E_NO_IMAGE_PROVIDER',
    };
  },

  async _openaiDalle(description) {
    // Load config to check for API key
    const { app } = require('electron');
    const configPath = path.join(app.getPath('userData'), 'mode-config.json');
    let config = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch (_) {}

    const apiKey = config?.imageGeneration?.openaiApiKey;
    if (!apiKey) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000);

    try {
      const resp = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config?.imageGeneration?.dalleModel || 'dall-e-3',
          prompt: description,
          n: 1,
          size: config?.imageGeneration?.imageSize || '1024x1024',
          response_format: 'b64_json',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await resp.json();
      return data.data?.[0]?.b64_json;
    } catch (e) {
      clearTimeout(timeout);
      return null;
    }
  },
};
