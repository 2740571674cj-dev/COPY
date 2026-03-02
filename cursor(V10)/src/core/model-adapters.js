/**
 * Model Adapters — 集中管理不同模型系列的配置差异 + 智能路由。
 *
 * 生产级原则:
 * 1. 所有自动检测都有用户显式配置覆盖路径
 * 2. 路由依赖模型配置的 routeRole 字段而非硬编码 regex
 * 3. Prompt Caching 依赖模型配置的 promptCaching 字段
 * 4. 未知情况一律保守回退
 */

// ─── 模型能力分级（仅用于 classifyModel 辅助判断，不直接驱动路由） ───
const MODEL_TIERS = {
    heavy: {
        patterns: [/opus/i, /o1/i, /o3/i, /deepseek-r1/i, /gemini-2\.5-pro/i, /gpt-4-?turbo/i],
    },
    medium: {
        patterns: [/sonnet/i, /gpt-4o(?!-mini)/i, /gemini-2\.0/i, /deepseek-v3/i, /qwen-?max/i, /codex/i],
    },
    light: {
        patterns: [/haiku/i, /gpt-4o-mini/i, /flash/i, /mini/i, /lite/i, /qwen-?turbo/i],
    },
};

function classifyModel(modelName) {
    if (!modelName) return 'medium';
    for (const [tier, def] of Object.entries(MODEL_TIERS)) {
        if (def.patterns.some(p => p.test(modelName))) return tier;
    }
    return 'medium';
}

// ─── Prompt Caching 支持检测 ───
// 优先读模型配置的 `promptCaching` 字段（显式 true/false），
// 只在用户未设置时才根据模型名自动推断，且推断结果偏保守。
function supportsCaching(model) {
    if (!model) return false;

    // 1) 用户显式配置优先（models.json 中的 promptCaching 字段）
    if (model.promptCaching === true) return true;
    if (model.promptCaching === false) return false;

    // 2) 未配置时，仅对确定支持的场景返回 true
    //    Anthropic 原生 API 支持 cache_control
    const url = (model.baseUrl || '').toLowerCase();
    if (/api\.anthropic\.com/i.test(url)) return true;

    // 其他场景一律不注入（保守），避免对不支持的 API 发送未知字段导致请求失败
    return false;
}

// ─── 适配器定义 ───
const ADAPTERS = {
    gemini: {
        match: (modelId) => /gemini/i.test(modelId),
        llmConfig: {
            temperature: 0.3,
            parallelToolCalls: false,
            toolChoiceMapping: { required: 'any' },
            // Gemini 通过 OpenAI 兼容层时，工具结果后必须以 user 结尾
            requireUserLast: true,
        },
        agentConfig: {
            stallThreshold: 1,
            jsonRepairEnabled: true,
            editRetryCautious: true,
        },
    },

    codex: {
        match: (modelId) => /codex/i.test(modelId),
        llmConfig: {
            temperature: 0.2,
            parallelToolCalls: false,
        },
        agentConfig: {
            stallThreshold: 2,
            jsonRepairEnabled: false,
            editRetryCautious: false,
        },
    },

    deepseek: {
        match: (modelId) => /deepseek/i.test(modelId),
        llmConfig: {
            temperature: 0.3,
            parallelToolCalls: false,
            // DeepSeek 后端要求严格的 user/assistant 交替，不允许连续 assistant
            requireUserLast: true,
            strictAlternation: true,
            // Reasoner 推理阶段需要更长超时
            getTimeouts: (modelName) => {
                if (/deepseek-r1|deepseek-reasoner/i.test(modelName || '')) {
                    return { fetchTimeout: 300000, chunkIdleTimeout: 180000, maxStreamDuration: 300000 };
                }
                return {};
            },
        },
        agentConfig: {
            stallThreshold: 2,
            jsonRepairEnabled: true,
            editRetryCautious: false,
        },
        isReasoningModel: (modelName) => /deepseek-r1|deepseek-reasoner/i.test(modelName || ''),
        supportsToolCalls: (modelName) => !/deepseek-r1|deepseek-reasoner/i.test(modelName || ''),
    },

    claude: {
        match: (modelId) => /claude/i.test(modelId),
        llmConfig: {
            // Anthropic-compatible backends may reject assistant prefill when the last
            // message is not a user turn.
            requireUserLast: true,
        },
        agentConfig: {
            stallThreshold: 2,
            jsonRepairEnabled: false,
            editRetryCautious: false,
        },
    },

    default: {
        match: () => true,
        llmConfig: {},
        agentConfig: {
            stallThreshold: 2,
            jsonRepairEnabled: false,
            editRetryCautious: false,
        },
    },
};

function getAdapter(modelId) {
    if (!modelId) return { name: 'default', ...ADAPTERS.default };
    for (const [name, adapter] of Object.entries(ADAPTERS)) {
        if (name !== 'default' && adapter.match(modelId)) {
            return { name, ...adapter };
        }
    }
    return { name: 'default', ...ADAPTERS.default };
}

// ─── 智能模型路由（依赖模型配置的 routeRole 字段） ───
// 模型配置中设置 routeRole: 'lightweight' 表示该模型可以接收简单任务分流。
// 不再使用硬编码 regex 白名单——用户完全控制哪些模型参与路由。
//
// models.json 示例:
// { "id": "mdl_...", "modelName": "gemini-3.1-pro-preview", "routeRole": "lightweight", ... }
// { "id": "mdl_...", "modelName": "claude-opus-4-6", "routeRole": "primary", ... }
//
// routeRole 取值:
//   - 'primary'      : 主力模型（默认，不设也视为 primary）
//   - 'lightweight'   : 可接收只读/简单任务分流
//   - 'disabled'      : 不参与任何路由

/**
 * 从用户已配置的可用模型中选择分流目标。
 * @param {Array} models       - loadModels() 返回的模型列表
 * @param {string} primaryId   - 用户主选模型 ID
 * @param {string} tier        - 所需等级: 'light' | 'medium' | 'heavy'
 * @returns {object|null}      - 分流模型或 null（使用主选模型）
 */
function routeModel(models, primaryId, tier = 'medium') {
    if (!models || models.length === 0) return null;

    // heavy 任务不分流
    if (tier === 'heavy') return null;

    const enabledModels = models.filter(m => m.enabled !== false);
    if (enabledModels.length <= 1) return null;

    // 只选 routeRole === 'lightweight' 且不是主选模型的
    const candidates = enabledModels.filter(m =>
        m.routeRole === 'lightweight' && m.id !== primaryId
    );

    if (candidates.length === 0) return null;

    // 多个候选时按 routePriority 排序（数字越小越优先，默认 100）
    candidates.sort((a, b) => (a.routePriority || 100) - (b.routePriority || 100));
    return candidates[0];
}

/**
 * 判断最近的工具调用组合需要什么等级的模型
 */
function estimateRequiredTier(recentToolNames) {
    if (!recentToolNames || recentToolNames.length === 0) return 'medium';

    const READONLY_SET = new Set([
        'read_file', 'grep_search', 'file_search', 'list_dir', 'read_lints', 'diff_history',
    ]);

    // 纯读操作可以用 light
    if (recentToolNames.every(n => READONLY_SET.has(n))) return 'light';

    return 'medium';
}

// ─── Auto Agent 任务复杂度分类 ───
// 分析用户消息来判断任务复杂度，用于 Auto Agent 模式的智能路由
const COMPLEXITY_KEYWORDS = {
    complex: [
        /重构/i, /refactor/i, /架构/i, /architect/i, /迁移/i, /migrat/i,
        /大规模/i, /large.?scale/i, /全面/i, /comprehensive/i,
        /多个文件/i, /multiple.?files/i, /整个项目/i, /entire.?project/i,
        /从零/i, /from.?scratch/i, /设计/i, /design/i,
        /数据库/i, /database/i, /性能优化/i, /performance/i,
        /安全/i, /security/i, /测试覆盖/i, /test.?coverage/i,
        /CI\/CD/i, /部署/i, /deploy/i, /微服务/i, /microservice/i,
    ],
    simple: [
        /解释/i, /explain/i, /什么是/i, /what.?is/i,
        /怎么用/i, /how.?to.?use/i, /查看/i, /查找/i, /find/i,
        /读取/i, /read/i, /列出/i, /list/i,
        /格式化/i, /format/i, /拼写/i, /typo/i,
        /注释/i, /comment/i, /重命名/i, /rename/i,
        /简单/i, /simple/i, /小改/i, /minor/i, /quick/i,
    ],
};

/**
 * 分析用户消息的任务复杂度
 * @param {string} userMessage - 用户消息
 * @returns {'complex'|'medium'|'simple'} 任务复杂度等级
 */
function classifyTaskComplexity(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return 'medium';

    const msg = userMessage.substring(0, 2000);

    let complexScore = 0;
    let simpleScore = 0;

    for (const pat of COMPLEXITY_KEYWORDS.complex) {
        if (pat.test(msg)) complexScore++;
    }
    for (const pat of COMPLEXITY_KEYWORDS.simple) {
        if (pat.test(msg)) simpleScore++;
    }

    // 多个需求点（用数字编号或分隔符）增加复杂度
    const numberedItems = (msg.match(/^\s*\d+[.、)）]/gm) || []).length;
    if (numberedItems >= 3) complexScore += 2;
    else if (numberedItems >= 2) complexScore += 1;

    // 消息长度也是复杂度信号
    if (msg.length > 800) complexScore += 1;
    if (msg.length > 1500) complexScore += 1;
    if (msg.length < 100) simpleScore += 1;

    if (complexScore >= 2 && complexScore > simpleScore) return 'complex';
    if (simpleScore >= 2 && simpleScore > complexScore) return 'simple';

    return 'medium';
}

/**
 * Auto Agent 智能路由：根据任务复杂度从可用模型中选择最合适的模型。
 *
 * 路由策略：
 * - complex → routeRole: 'complex' 或 'primary'（Claude/Codex 级别）
 * - medium  → routeRole: 'medium'  或 fallback 到 primary
 * - simple  → routeRole: 'simple'  或 'lightweight' 或 fallback
 *
 * 模型配置中需要设置 routeRole 字段：
 *   'complex'     : 复杂任务模型（Claude/Codex）
 *   'primary'     : 主力模型（默认，同时可接收复杂任务）
 *   'medium'      : 中等任务模型（Gemini）
 *   'simple'      : 简单任务模型（DeepSeek）
 *   'lightweight' : 同 'simple'，兼容旧配置
 *
 * @param {Array} models         - loadModels() 返回的模型列表
 * @param {string} primaryId     - 用户主选模型 ID
 * @param {'complex'|'medium'|'simple'} complexity - 任务复杂度
 * @returns {object|null}        - 路由目标模型或 null（使用主选模型）
 */
function autoRouteModel(models, primaryId, complexity) {
    if (!models || models.length === 0) return null;

    const enabledModels = models.filter(m => m.enabled !== false);
    if (enabledModels.length <= 1) return null;

    // complex → 用主选模型或 routeRole='complex'/'primary' 的模型
    if (complexity === 'complex') {
        const complexCandidates = enabledModels.filter(m =>
            m.routeRole === 'complex' && m.id !== primaryId
        );
        if (complexCandidates.length > 0) {
            complexCandidates.sort((a, b) => (a.routePriority || 100) - (b.routePriority || 100));
            return complexCandidates[0];
        }
        return null; // 使用主选模型
    }

    // medium → routeRole='medium' 的模型
    if (complexity === 'medium') {
        const mediumCandidates = enabledModels.filter(m =>
            m.routeRole === 'medium' && m.id !== primaryId
        );
        if (mediumCandidates.length > 0) {
            mediumCandidates.sort((a, b) => (a.routePriority || 100) - (b.routePriority || 100));
            return mediumCandidates[0];
        }
        return null; // 没有 medium 模型，使用主选
    }

    // simple → routeRole='simple' 或 'lightweight'
    if (complexity === 'simple') {
        const simpleCandidates = enabledModels.filter(m =>
            (m.routeRole === 'simple' || m.routeRole === 'lightweight') && m.id !== primaryId
        );
        if (simpleCandidates.length > 0) {
            simpleCandidates.sort((a, b) => (a.routePriority || 100) - (b.routePriority || 100));
            return simpleCandidates[0];
        }
        return null;
    }

    return null;
}

module.exports = {
    getAdapter, ADAPTERS,
    classifyModel, MODEL_TIERS,
    supportsCaching, routeModel, estimateRequiredTier,
    classifyTaskComplexity, autoRouteModel,
};
