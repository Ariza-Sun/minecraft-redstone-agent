export type ModelOption = {
  id: string
  name: string
  provider: string
  description: string
  context: string
  free: boolean
  pricing?: {
    inputUsdPerMillion: number
    outputUsdPerMillion: number
    asOf: string
    sourceUrl: string
  }
  providerRouting?: {
    sort: 'price' | 'throughput' | 'latency'
    requireParameters: boolean
    ignore?: string[]
    only?: string[]
  }
  supportsResponseFormat: boolean
  supportsStructuredOutputs: boolean
  useStrictLayoutSchema?: boolean
  completionTokenParameter?: 'max_tokens' | 'max_completion_tokens'
  maxCompletionTokens?: number
  layoutMaxCompletionTokens?: number
  layoutReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Overrides the 180 s OpenRouter layout timeout for models that reason for minutes. */
  layoutTimeoutMs?: number
  omitTemperature?: boolean
}

/**
 * A deliberately small, server-owned allowlist for interactive sessions.
 * Free endpoints remain the default choice, while explicitly reviewed paid
 * entries carry a dated pricing snapshot. The browser cannot submit arbitrary
 * model ids outside this catalog.
 */
// Catalog and reference prices were checked against OpenRouter on the asOf
// date of each entry and go stale: recheck before relying on them. Routing can
// change the actual bill. Edit this list to match the models you want to offer.
export const OPENROUTER_MODEL_OPTIONS: readonly ModelOption[] = Object.freeze([
  {
    id: 'deepseek/deepseek-v4.1-flash-1017',
    name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
    provider: 'DeepSeek',
    description: '新版低成本代码与 agent 模型，支持长上下文和结构化输出',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 0.035,
      outputUsdPerMillion: 0.5,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017',
    },
    providerRouting: { sort: 'latency', requireParameters: true },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
    // Layout runs with high reasoning effort; reasoning shares the 128K
    // completion ceiling with the layout JSON.
    layoutMaxCompletionTokens: 128_000,
    layoutReasoningEffort: 'high',
    layoutTimeoutMs: 1_800_000,
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek: DeepSeek V4 Flash 0731',
    provider: 'DeepSeek',
    description: '高性价比的代码、推理与 agent 工作流',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 0.119,
      outputUsdPerMillion: 0.238,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/deepseek/deepseek-v4-flash-0731',
    },
    providerRouting: {
      sort: 'latency',
      requireParameters: true,
      ignore: ['reka'],
    },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek: DeepSeek V4 Pro',
    provider: 'DeepSeek',
    description: '强推理旗舰，长上下文代码与多步规划，性价比极高',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 1.6,
      outputUsdPerMillion: 3.2,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/deepseek/deepseek-v4-pro',
    },
    providerRouting: {
      sort: 'latency',
      requireParameters: true,
      ignore: ['reka'],
    },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'qwen/qwen3.8-flash',
    name: 'Qwen: Qwen3.8 Flash',
    provider: 'Qwen',
    description: '通义千问低成本长上下文模型，适合交互与结构化任务',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.47,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/qwen/qwen3.8-flash',
    },
    providerRouting: { sort: 'latency', requireParameters: true },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'qwen/qwen3.8-max-0902',
    name: 'Qwen: Qwen3.8 Max (0902)',
    provider: 'Qwen',
    description: '通义千问旗舰推理模型，适合复杂规划和空间布局',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 6,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/qwen/qwen3.8-max-0902',
    },
    providerRouting: { sort: 'latency', requireParameters: true },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
    layoutReasoningEffort: 'low',
  },
  {
    id: 'moonshotai/kimi-k3.1-pro',
    name: 'Moonshot: Kimi K3.1 Pro',
    provider: 'Moonshot AI',
    description: '新版长上下文旗舰，适合代码、多步规划与空间推理',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/moonshotai/kimi-k3.1-pro',
    },
    providerRouting: { sort: 'latency', requireParameters: true },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
    omitTemperature: true,
    // Layout runs with high reasoning effort; reasoning shares the 128K
    // completion ceiling with the layout JSON.
    layoutMaxCompletionTokens: 128_000,
    layoutReasoningEffort: 'high',
    layoutTimeoutMs: 1_800_000,
  },
  {
    id: 'moonshotai/kimi-k2.6',
    name: 'Moonshot: Kimi K2.6',
    provider: 'Moonshot AI',
    description: '长上下文 agent 与代码，OpenRouter 热门开放权重模型',
    context: '256K context',
    free: false,
    pricing: {
      inputUsdPerMillion: 0.65,
      outputUsdPerMillion: 3.41,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/moonshotai/kimi-k2.6',
    },
    providerRouting: {
      sort: 'latency',
      requireParameters: true,
    },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
  },
  {
    id: 'minimax/minimax-m3.1-flash',
    name: 'MiniMax: MiniMax M3.1 Flash',
    provider: 'MiniMax',
    description: '低成本代码与 agent 推理模型，支持长上下文',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.6,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/minimax/minimax-m3.1-flash',
    },
    providerRouting: { sort: 'latency', requireParameters: true },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
    // Mandatory reasoning shares the completion budget with the layout JSON.
    layoutMaxCompletionTokens: 65_536,
    layoutReasoningEffort: 'low',
  },
  {
    id: 'x-ai/grok-4.6',
    name: 'xAI: Grok 4.6',
    provider: 'xAI',
    description: '推理模型；布局阶段开启最高档思考，单次调用可能需要数分钟',
    context: '500K context',
    free: false,
    pricing: {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 6,
      asOf: '2026-11-18',
      sourceUrl: 'https://openrouter.ai/x-ai/grok-4.6',
    },
    providerRouting: {
      sort: 'latency',
      requireParameters: true,
    },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
    // Layout runs with high reasoning effort; reasoning shares the 128K
    // completion ceiling with the layout JSON.
    layoutMaxCompletionTokens: 128_000,
    layoutReasoningEffort: 'high',
    layoutTimeoutMs: 1_800_000,
  },
  {
    id: 'z-ai/glm-5.2',
    name: 'Z.ai: GLM 5.2',
    provider: 'Z.ai',
    description: '面向长程规划、代码与复杂多步自动化的推理模型',
    context: '1M context',
    free: false,
    pricing: {
      inputUsdPerMillion: 0.006,
      outputUsdPerMillion: 6.8,
      asOf: '2026-11-01',
      sourceUrl: 'https://openrouter.ai/z-ai/glm-5.2',
    },
    providerRouting: {
      sort: 'latency',
      requireParameters: true,
    },
    supportsResponseFormat: true,
    supportsStructuredOutputs: true,
    // Layout runs with high reasoning effort; reasoning shares the 128K
    // completion ceiling with the layout JSON.
    layoutMaxCompletionTokens: 128_000,
    layoutReasoningEffort: 'high',
    layoutTimeoutMs: 1_800_000,
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    name: 'NVIDIA: Nemotron 3.5 Lightning',
    provider: 'NVIDIA',
    description: '较快的 agent 推理',
    context: '1M context',
    free: true,
    supportsResponseFormat: false,
    supportsStructuredOutputs: false,
  },
  {
    id: 'openrouter/free',
    name: 'OpenRouter Free Router',
    provider: 'OpenRouter',
    description: '按请求能力自动选择可用免费模型',
    context: 'dynamic',
    free: true,
    supportsResponseFormat: true,
    supportsStructuredOutputs: false,
  },
])

export function modelOption(modelId: string): ModelOption | undefined {
  return OPENROUTER_MODEL_OPTIONS.find((option) => option.id === modelId)
}

export function selectableModelOptions(configuredModel: string): ModelOption[] {
  if (modelOption(configuredModel)) return [...OPENROUTER_MODEL_OPTIONS]
  return [
    {
      id: configuredModel,
      name: configuredModel,
      provider: 'Configured',
      description: '由服务端环境变量配置',
      context: 'custom',
      free: false,
      supportsResponseFormat: true,
      supportsStructuredOutputs: false,
    },
    ...OPENROUTER_MODEL_OPTIONS,
  ]
}
