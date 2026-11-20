import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from '@platform/artifact-store'
import type { AppConfig } from '@platform/config'
import {
  logicDesignSchema,
  taskSpecSchema,
  type ArtifactBundle,
} from '@domain/domain'
import type { ModelProgress, ModelStage } from './model-adapter'
import { OpenRouterModelAdapter } from './openrouter-adapter'

const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const config: AppConfig['openRouter'] = {
  apiKey: 'test-key',
  model: 'nvidia/nemotron-3.5-lightning:free',
  baseUrl: 'https://openrouter.invalid/api/v1',
  timeoutMs: 1_000,
  maxAttempts: 1,
  retryBaseMs: 1,
  maxOutputTokens: 65_536,
}

async function requestFor(
  model: string,
  stage: ModelStage = 'task',
  artifacts: ArtifactBundle = {},
  feedback?: unknown,
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-model-request-'))
  tempDirs.push(root)
  const sessionId = 'session-test'
  await mkdir(path.join(root, sessionId, 'model'), { recursive: true })
  const store = new ArtifactStore(root)
  const adapter = new OpenRouterModelAdapter(config, store)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    model,
    choices: [{ message: { content: JSON.stringify({ type: 'report_blocker', code: 'TEST', message: 'test' }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

  await adapter.generate({
    sessionId,
    requestedModel: model,
    stage,
    sessionState: 'COLLECTING_REQUIREMENTS',
    userRequest: 'test request',
    artifacts,
    feedback,
  })

  return JSON.parse(await readFile(path.join(root, sessionId, 'model', 'request-0001.json'), 'utf8'))
}

describe('OpenRouterModelAdapter model capabilities', () => {
  it('excludes reasoning traces without setting a reasoning token budget for any model', async () => {
    const request = await requestFor('nvidia/nemotron-3.5-lightning:free')

    expect(request.model).toBe('nvidia/nemotron-3.5-lightning:free')
    expect(request).not.toHaveProperty('response_format')
    expect(request.reasoning).toEqual({ exclude: true })
  })

  it('retains JSON response mode for models that advertise support', async () => {
    const request = await requestFor('openrouter/free')

    expect(request.response_format).toEqual({ type: 'json_object' })

    const deepseekRequest = await requestFor('deepseek/deepseek-v4-flash-0731')
    expect(deepseekRequest.response_format).toEqual({ type: 'json_object' })
    expect(deepseekRequest.reasoning).toEqual({ exclude: true })
    expect(deepseekRequest.max_tokens).toBe(16_384)
    expect(deepseekRequest.provider).toEqual({
      sort: 'latency',
      allow_fallbacks: true,
      require_parameters: true,
      ignore: ['reka'],
    })
  })

  it('omits unsupported temperature for Kimi K3.1 Pro', async () => {
    const request = await requestFor('moonshotai/kimi-k3.1-pro', 'layout')

    expect(request).not.toHaveProperty('temperature')
    expect(request.max_tokens).toBe(65_536)
    expect(request.provider).toEqual(expect.objectContaining({ require_parameters: true }))
  })

  it.each([
    'deepseek/deepseek-v4-pro',
    'z-ai/glm-5.2',
    'deepseek/deepseek-v4.1-flash-1017',
    'qwen/qwen3.8-flash',
    'qwen/qwen3.8-max-0902',
    'moonshotai/kimi-k3.1-pro',
    'minimax/minimax-m3.1-flash',
    'x-ai/grok-4.6',
    'moonshotai/kimi-k2.6',
  ])('uses strict layout output and parameter-compatible routing for %s', async (model) => {
    const request = await requestFor(model, 'layout')

    expect(request.response_format).toEqual(expect.objectContaining({
      type: 'json_schema',
      json_schema: expect.objectContaining({ name: 'physical_layout_action', strict: true }),
    }))
    expect(request.provider).toEqual(expect.objectContaining({
      sort: 'latency',
      allow_fallbacks: true,
      require_parameters: true,
    }))
  })

  it('gives MiniMax layout a 65K budget and low mandatory reasoning from attempt one', async () => {
    const layoutRequest = await requestFor('minimax/minimax-m3.1-flash', 'layout')
    const taskRequest = await requestFor('minimax/minimax-m3.1-flash', 'task')

    // Mandatory reasoning and visible layout JSON share the completion budget.
    expect(layoutRequest.max_tokens).toBe(65_536)
    expect(layoutRequest).not.toHaveProperty('max_completion_tokens')
    expect(layoutRequest.reasoning).toEqual({ effort: 'low', exclude: true })
    expect(taskRequest.max_tokens).toBe(16_384)
    expect(taskRequest.reasoning).toEqual({ exclude: true })
  })

  it('starts Qwen3.8 Max layouts with bounded mandatory reasoning', async () => {
    const request = await requestFor('qwen/qwen3.8-max-0902', 'layout')

    expect(request.reasoning).toEqual({ effort: 'low', exclude: true })
    expect(request.max_tokens).toBe(65_536)
  })

  it('switches structured layout retries to a local repair patch contract', async () => {
    const repairBase: NonNullable<ArtifactBundle['physicalLayout']> = {
      id: 'layout-repair-base',
      version: 3,
      logicDesignRef: { id: 'logic-repair-base', version: 1 },
      bounds: { x: 5, y: 3, z: 5 },
      blocks: [{
        id: 'lamp-Y',
        block: 'minecraft:redstone_lamp',
        position: { x: 4, y: 0, z: 2 },
        properties: {},
        implements: ['Y'],
      }],
      explanation: { overview: 'repair base', criticalOrientations: [], routingNotes: [] },
    }
    const request = await requestFor('z-ai/glm-5.2', 'layout', { physicalLayout: repairBase }, {
      reason: 'layout_validation_failed',
      repairMode: 'patch_best_candidate',
      repairBaseLayoutRef: { id: repairBase.id, version: repairBase.version },
    })
    const messages = request.messages as Array<{ role: string; content: string }>
    const prompt = messages.at(-1)?.content ?? ''

    expect(request.response_format).toEqual(expect.objectContaining({
      type: 'json_schema',
      json_schema: expect.objectContaining({ name: 'physical_layout_repair_action', strict: true }),
    }))
    expect(prompt).toContain('one local repair_layout patch')
    expect(prompt).toContain('do not return propose_layout')
    expect(prompt).toContain('Set baseVersion exactly to artifacts.physicalLayout.version')
    expect(prompt).toContain('at most 64 combined changes')
    expect(prompt).toContain('"version":3')
  })

  it('offers optional guidance for a fresh layout and preserves correct behavior in a guided adjustment', async () => {
    const feedback = { retryMode: 'human_guided', userInstruction: '保持端口位置，减少绕线' }
    const fresh = await requestFor('z-ai/glm-5.2', 'layout', {}, feedback)
    const freshPrompt = (fresh.messages as Array<{ content: string }>).at(-1)?.content ?? ''
    expect(freshPrompt).toContain('Human guidance is optional')
    expect(freshPrompt).toContain(feedback.userInstruction)
    const repairBase: NonNullable<ArtifactBundle['physicalLayout']> = {
      id: 'layout', version: 3, logicDesignRef: { id: 'logic', version: 1 },
      bounds: { x: 7, y: 4, z: 5 }, blocks: [],
      explanation: { overview: 'checked layout', criticalOrientations: [], routingNotes: [] },
    }
    const repair = await requestFor('z-ai/glm-5.2', 'layout', { physicalLayout: repairBase }, {
      ...feedback, repairMode: 'patch_best_candidate', repairBaseValidation: { passed: true },
    })
    const repairPrompt = (repair.messages as Array<{ content: string }>).at(-1)?.content ?? ''
    expect(repairPrompt).toContain('If repairBaseValidation.passed is true')
    expect(repairPrompt).toContain('preserving the passing behavior')
    expect(repairPrompt).toContain(feedback.userInstruction)
  })

  it('uses deliberately loose technical max-token ceilings by stage', async () => {
    const layoutRequest = await requestFor('deepseek/deepseek-v4-flash-0731', 'layout')
    const conversationRequest = await requestFor('deepseek/deepseek-v4-flash-0731', 'conversation')

    expect(layoutRequest.max_tokens).toBe(65_536)
    expect(conversationRequest.max_tokens).toBe(8_192)
    expect(layoutRequest.reasoning).toEqual({ enabled: false, exclude: true })
    expect(conversationRequest.reasoning).toEqual({ exclude: true })
    expect(layoutRequest.response_format).toEqual(expect.objectContaining({
      type: 'json_schema',
      json_schema: expect.objectContaining({ name: 'physical_layout_action', strict: true }),
    }))
    expect(layoutRequest.provider).toEqual(expect.objectContaining({ sort: 'latency', ignore: ['reka'] }))
    expect(conversationRequest.provider).toEqual(expect.objectContaining({ sort: 'latency' }))
  })

  it('injects general knowledge beside active artifact facts without deriving a task-specific layout', async () => {
    const task = taskSpecSchema.parse({
      id: 'task-contract',
      version: 1,
      title: 'NOT gate',
      description: 'contract test',
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 1, z: 1 }, facing: 'north' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 3, y: 1, z: 1 }, facing: 'east' } }],
      truthTable: [
        { inputs: { A: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 1 }, outputs: { Y: 0 } },
      ],
      workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 5, y: 5, z: 5 } },
      allowedBlocks: ['minecraft:stone', 'minecraft:lever', 'minecraft:redstone_torch', 'minecraft:redstone_wall_torch', 'minecraft:redstone_wire', 'minecraft:redstone_lamp'],
      maxBlocks: 12,
      acceptance: { requireAllCases: true, stableReads: 2 },
    })
    const design = logicDesignSchema.parse({
      id: 'logic-contract',
      version: 1,
      taskSpecRef: { id: task.id, version: task.version },
      nodes: [
        { id: 'A', kind: 'input', label: 'A' },
        { id: 'NOT_A', kind: 'not', label: 'NOT A' },
        { id: 'Y', kind: 'output', label: 'Y' },
      ],
      edges: [
        { id: 'e-in', from: 'A', to: 'NOT_A', signal: 'A' },
        { id: 'e-out', from: 'NOT_A', to: 'Y', signal: 'NOT A' },
      ],
      equations: { Y: 'NOT A' },
      explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
    })

    const request = await requestFor('deepseek/deepseek-v4-flash-0731', 'layout', { task, logicDesign: design })
    const messages = request.messages as Array<{ role: string; content: string }>
    const prompt = messages.at(-1)?.content ?? ''

    expect(prompt).toContain('GENERAL MINECRAFT REDSTONE KNOWLEDGE BASE')
    expect(prompt).toContain('"scope":"general_cross_task_knowledge"')
    expect(prompt).toContain('physics.lever.attachment_and_input')
    expect(prompt).toContain('implementation.not.direct_wall_torch')
    expect(prompt).toContain('implementation.and.de_morgan_three_inverters')
    expect(prompt).toContain('ACTIVE LAYOUT ARTIFACT FACTS')
    expect(prompt).toContain('Fixed port coordinate ledger')
    expect(prompt).toContain('1,1,1 = INPUT A: exactly one minecraft:lever')
    expect(prompt).toContain('3,1,1 = OUTPUT Y: exactly one minecraft:redstone_lamp')
    expect(prompt).toContain('Valid logic node IDs: A, NOT_A, Y')
    expect(prompt).toContain('Valid logic edge IDs: e-in, e-out')
    expect(prompt).toContain('Derive all mounting choices, relative support coordinates, implementation topology, and routes')
    expect(prompt).not.toContain('wall torch can go at')
    expect(prompt).not.toContain('horizontal Manhattan distance 2; this is crowded')
  })

  it('reports every output and format rejection before retrying', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-model-progress-'))
    tempDirs.push(root)
    const sessionId = 'session-progress'
    await mkdir(path.join(root, sessionId, 'model'), { recursive: true })
    const store = new ArtifactStore(root)
    const adapter = new OpenRouterModelAdapter({ ...config, maxAttempts: 2 }, store)
    const responses = [
      '{broken',
      JSON.stringify({ type: 'report_blocker', code: 'TEST', message: 'test' }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'nvidia/nemotron-3.5-lightning:free',
      choices: [{ finish_reason: 'stop', message: { content: responses.shift() } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const progress: ModelProgress[] = []

    const result = await adapter.generate({
      sessionId,
      stage: 'task',
      sessionState: 'COLLECTING_REQUIREMENTS',
      userRequest: 'test request',
      artifacts: {},
    }, (event) => { progress.push(event) })

    expect(result.attempts).toBe(2)
    expect(progress.map((event) => event.type)).toEqual([
      'attempt.started',
      'output.received',
      'output.rejected',
      'attempt.started',
      'output.received',
      'output.accepted',
    ])
    expect(progress[2]).toEqual(expect.objectContaining({
      type: 'output.rejected',
      category: 'format',
      retrying: true,
    }))
  })

  it('keeps max_tokens fixed and switches provider after an exhausted empty response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-provider-switch-'))
    tempDirs.push(root)
    const sessionId = 'session-provider-switch'
    await mkdir(path.join(root, sessionId, 'model'), { recursive: true })
    const store = new ArtifactStore(root)
    const adapter = new OpenRouterModelAdapter({ ...config, maxAttempts: 2 }, store)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'deepseek/deepseek-v4-flash-0731',
        provider: 'Sail Research',
        choices: [{ finish_reason: 'length', message: { content: null } }],
        usage: {
          prompt_tokens: 600,
          completion_tokens: 16_384,
          total_tokens: 16_984,
          completion_tokens_details: { reasoning_tokens: 16_000 },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'deepseek/deepseek-v4-flash-0731',
        provider: 'DeepInfra',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ type: 'report_blocker', code: 'TEST', message: 'test' }) },
        }],
        usage: {
          prompt_tokens: 620,
          completion_tokens: 1_000,
          total_tokens: 1_620,
          completion_tokens_details: { reasoning_tokens: 500 },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.generate({
      sessionId,
      requestedModel: 'deepseek/deepseek-v4-flash-0731',
      stage: 'task',
      sessionState: 'COLLECTING_REQUIREMENTS',
      userRequest: 'test request',
      artifacts: {},
    })

    expect(result.attempts).toBe(2)
    const firstRequest = JSON.parse(await readFile(path.join(root, sessionId, 'model', 'request-0001.json'), 'utf8'))
    const secondRequest = JSON.parse(await readFile(path.join(root, sessionId, 'model', 'request-0002.json'), 'utf8'))
    expect(firstRequest.max_tokens).toBe(16_384)
    expect(secondRequest.max_tokens).toBe(16_384)
    expect(firstRequest.reasoning).toEqual({ exclude: true })
    expect(secondRequest.reasoning).toEqual({ exclude: true })
    expect(firstRequest.provider.ignore).toEqual(['reka'])
    expect(secondRequest.provider.ignore).toEqual(['reka', 'sail-research'])
    expect(secondRequest.messages.at(-1).content).toContain('will be excluded from the next attempt')
  })

  it('retains the configured per-request technical ceiling', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-technical-token-ceiling-'))
    tempDirs.push(root)
    const sessionId = 'session-technical-token-ceiling'
    await mkdir(path.join(root, sessionId, 'model'), { recursive: true })
    const store = new ArtifactStore(root)
    const adapter = new OpenRouterModelAdapter({ ...config, maxOutputTokens: 1_000 }, store)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'deepseek/deepseek-v4-flash-0731',
      choices: [{ message: { content: JSON.stringify({ type: 'report_blocker', code: 'TEST', message: 'test' }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await adapter.generate({
      sessionId,
      requestedModel: 'deepseek/deepseek-v4-flash-0731',
      stage: 'task',
      sessionState: 'COLLECTING_REQUIREMENTS',
      userRequest: 'test request',
      artifacts: {},
    })

    const request = JSON.parse(await readFile(path.join(root, sessionId, 'model', 'request-0001.json'), 'utf8'))
    expect(request.reasoning).toEqual({ exclude: true })
    expect(request.max_tokens).toBe(1_000)
  })

  async function generateWithResponses(
    sessionId: string,
    responses: Array<{ status?: number; body: unknown }>,
    context: { stage: ModelStage; artifacts?: ArtifactBundle; requestedModel?: string },
    adapterConfig: Partial<AppConfig['openRouter']> = {},
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), `mc-ic-${sessionId}-`))
    tempDirs.push(root)
    await mkdir(path.join(root, sessionId, 'model'), { recursive: true })
    const store = new ArtifactStore(root)
    const adapter = new OpenRouterModelAdapter({ ...config, maxAttempts: responses.length, ...adapterConfig }, store)
    const fetchMock = vi.fn()
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    }
    vi.stubGlobal('fetch', fetchMock)
    const progress: ModelProgress[] = []
    const result = await adapter.generate({
      sessionId,
      requestedModel: context.requestedModel ?? 'nvidia/nemotron-3.5-lightning:free',
      stage: context.stage,
      sessionState: 'PLANNING_LAYOUT',
      userRequest: 'test request',
      artifacts: context.artifacts ?? {},
    }, (event) => { progress.push(event) })
    const requests = await Promise.all(Array.from({ length: fetchMock.mock.calls.length }, (_, index) =>
      readFile(path.join(root, sessionId, 'model', `request-${String(index + 1).padStart(4, '0')}.json`), 'utf8').then((text) => JSON.parse(text))))
    return { result, progress, requests }
  }

  const ok = (action: unknown) => ({
    body: {
      model: 'nvidia/nemotron-3.5-lightning:free',
      provider: 'Nvidia',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  })

  it('tolerates numeric port ids, boolean truth-table bits and a missing summary message', async () => {
    const { result } = await generateWithResponses('lenient-task', [ok({
      type: 'propose_task_spec',
      taskSpec: {
        title: 'NOT',
        description: 'NOT gate',
        inputs: [{ id: 1, label: 'A', port: { position: { x: 1, y: 1, z: 1 }, facing: 'north' } }],
        outputs: [{ id: 2, label: 'Y', port: { position: { x: 5, y: 0, z: 1 }, facing: 'up' } }],
        truthTable: [
          { inputs: { 1: false }, outputs: { 2: 'true' } },
          { inputs: { 1: true }, outputs: { 2: '0' } },
        ],
        workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 7, y: 4, z: 5 } },
        allowedBlocks: ['minecraft:stone', 'minecraft:lever', 'minecraft:redstone_wall_torch', 'minecraft:redstone_wire', 'minecraft:redstone_lamp'],
        maxBlocks: 20,
        acceptance: { requireAllCases: true, stableReads: 3 },
      },
    })], { stage: 'task' })

    expect(result.action.type).toBe('propose_task_spec')
    if (result.action.type !== 'propose_task_spec') throw new Error('unexpected action')
    expect(result.action.taskSpec.inputs[0].id).toBe('1')
    expect(result.action.taskSpec.truthTable).toEqual([
      { inputs: { 1: 0 }, outputs: { 2: 1 } },
      { inputs: { 1: 1 }, outputs: { 2: 0 } },
    ])
    expect(result.action.message).toBe('')
    expect(result.formatErrors.join('\n')).toContain('Coerced numeric inputs id')
    expect(result.formatErrors.join('\n')).toContain('truth-table values')
  })

  it('fills empty implements on support blocks from the component they carry', async () => {
    const { result } = await generateWithResponses('lenient-layout', [ok({
      type: 'propose_layout',
      layout: {
        bounds: { x: 4, y: 3, z: 3 },
        blocks: [
          { id: 'base', block: 'minecraft:stone', position: { x: 1, y: 0, z: 1 }, properties: {}, implements: [] },
          { id: 'lever', block: 'minecraft:lever', position: { x: 1, y: 1, z: 1 }, properties: { face: 'floor' }, implements: ['A'] },
          { id: 'orphan', block: 'minecraft:stone', position: { x: 3, y: 2, z: 2 }, properties: {}, implements: [] },
        ],
        explanation: { overview: 'o', criticalOrientations: [], routingNotes: [] },
      },
      message: 'ok',
    }), ok({
      type: 'propose_layout',
      layout: {
        bounds: { x: 4, y: 3, z: 3 },
        blocks: [
          { id: 'base', block: 'minecraft:stone', position: { x: 1, y: 0, z: 1 }, properties: {}, implements: [] },
          { id: 'lever', block: 'minecraft:lever', position: { x: 1, y: 1, z: 1 }, properties: { face: 'floor' }, implements: ['A'] },
        ],
        explanation: { overview: 'o', criticalOrientations: [], routingNotes: [] },
      },
      message: 'ok',
    })], { stage: 'layout' })

    // The first response still fails: the orphan has no tagged neighbour.
    expect(result.attempts).toBe(2)
    if (result.action.type !== 'propose_layout') throw new Error('unexpected action')
    expect(result.action.layout.blocks.find((block) => block.id === 'base')?.implements).toEqual(['A'])
    expect(result.formatErrors.join('\n')).toContain('Filled empty implements from the adjacent component for: base')
    expect(result.formatErrors.join('\n')).toContain('layout.blocks.2.implements: Array must contain at least 1 element(s)')
  })

  it('treats a wrapped upstream provider error as transient and retries', async () => {
    const { result, progress } = await generateWithResponses('transient-404', [
      { status: 404, body: { error: { message: 'Provider returned error', code: 404, metadata: { raw: '', provider_name: 'Nvidia' } } } },
      ok({ type: 'report_blocker', code: 'TEST', message: 'test' }),
    ], { stage: 'logic' })

    expect(result.attempts).toBe(2)
    expect(progress.find((event) => event.type === 'output.rejected')).toEqual(expect.objectContaining({
      category: 'upstream',
      retrying: true,
      reason: 'Provider returned error (provider Nvidia)',
    }))
  })

  it('keeps hidden reasoning on when the endpoint refuses to disable it', async () => {
    const { result, requests } = await generateWithResponses('reasoning-mandatory', [
      { status: 400, body: { error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400 } } },
      ok({ type: 'report_blocker', code: 'TEST', message: 'test' }),
    ], { stage: 'layout' })

    expect(result.attempts).toBe(2)
    expect(requests[0].reasoning).toEqual({ enabled: false, exclude: true })
    expect(requests[1].reasoning).toEqual({ exclude: true })
  })

  it('retries a truncated MiniMax layout without excluding its compatible provider', async () => {
    const { result, progress, requests } = await generateWithResponses('minimax-layout-length', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{ finish_reason: 'length', message: { content: '{"type":"propose_layout"' } }],
        usage: { prompt_tokens: 8_000, completion_tokens: 65_536, total_tokens: 73_536 },
      },
    }, {
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ type: 'report_blocker', code: 'TEST', message: 'test' }) },
        }],
        usage: { prompt_tokens: 8_100, completion_tokens: 100, total_tokens: 8_200 },
      },
    }], { stage: 'layout', requestedModel: 'minimax/minimax-m3.1-flash' })

    expect(result.attempts).toBe(2)
    expect(requests[0].max_tokens).toBe(65_536)
    expect(requests[0].reasoning).toEqual({ effort: 'low', exclude: true })
    expect(requests[1].provider).not.toHaveProperty('ignore')
    expect(requests[1].messages.at(-1).content).toContain('65536-token completion limit was reached')
    expect(progress.find((event) => event.type === 'output.rejected')).toEqual(expect.objectContaining({
      category: 'format',
      reason: expect.stringContaining('65536-token completion limit was reached'),
      retrying: true,
    }))
  })

  it('rejects a repair collision before it consumes a controller layout version', async () => {
    const base: NonNullable<ArtifactBundle['physicalLayout']> = {
      id: 'layout-preflight-base',
      version: 2,
      logicDesignRef: { id: 'logic-preflight', version: 1 },
      bounds: { x: 7, y: 4, z: 7 },
      blocks: [{
        id: 'lamp-Y',
        block: 'minecraft:redstone_lamp',
        position: { x: 5, y: 0, z: 3 },
        properties: {},
        implements: ['Y'],
      }],
      explanation: { overview: 'base', criticalOrientations: [], routingNotes: [] },
    }
    const { result, progress, requests } = await generateWithResponses('repair-coordinate-preflight', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'repair_layout',
            patch: {
              baseVersion: 2,
              upsertBlocks: [{
                id: 'new-wire',
                block: 'minecraft:redstone_wire',
                position: { x: 5, y: 0, z: 3 },
                properties: {},
                implements: ['edge-Y'],
              }],
              removeBlockIds: [],
              explanation: base.explanation,
              changeSummary: { reason: 'test', changed: ['new-wire'], impact: ['test'] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }, {
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ type: 'report_blocker', code: 'TEST', message: 'test' }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
    }], {
      stage: 'layout',
      requestedModel: 'minimax/minimax-m3.1-flash',
      artifacts: { physicalLayout: base },
    })

    expect(result.attempts).toBe(2)
    expect(progress.find((event) => event.type === 'output.rejected')).toEqual(expect.objectContaining({
      category: 'action',
      reason: expect.stringContaining('new-wire overlaps lamp-Y at 5,0,3'),
    }))
    expect(requests[1].messages.at(-1).content).toContain('Every coordinate must be unique after applying the patch')
  })

  it('treats a component upsert onto an unchanged resident wire as a coordinate replacement', async () => {
    const base: NonNullable<ArtifactBundle['physicalLayout']> = {
      id: 'layout-wire-replacement-base',
      version: 4,
      logicDesignRef: { id: 'logic-wire-replacement', version: 1 },
      bounds: { x: 7, y: 4, z: 7 },
      blocks: [{
        id: 'old-wire',
        block: 'minecraft:redstone_wire',
        position: { x: 3, y: 0, z: 3 },
        properties: {},
        implements: ['edge-old'],
      }],
      explanation: { overview: 'base', criticalOrientations: [], routingNotes: [] },
    }
    const { result } = await generateWithResponses('repair-wire-replacement', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'repair_layout',
            patch: {
              baseVersion: 4,
              upsertBlocks: [{
                id: 'new-repeater',
                block: 'minecraft:repeater',
                position: { x: 3, y: 0, z: 3 },
                properties: { facing: 'east', delay: 1 },
                implements: ['edge-new'],
              }],
              removeBlockIds: [],
              explanation: base.explanation,
              changeSummary: { reason: 'replace wire', changed: ['new-repeater'], impact: ['test'] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }], {
      stage: 'layout',
      requestedModel: 'minimax/minimax-m3.1-flash',
      artifacts: { physicalLayout: base },
    })

    expect(result.action.type).toBe('repair_layout')
    if (result.action.type !== 'repair_layout') throw new Error('unexpected action')
    expect(result.action.patch.removeBlockIds).toEqual(['old-wire'])
    expect(result.action.patch.upsertBlocks).toEqual([
      expect.objectContaining({ id: 'new-repeater', implements: ['edge-old', 'edge-new'] }),
    ])
    expect(result.formatErrors).toContain('Replaced resident passive block old-wire with new-repeater at 3,0,3')
  })

  it('treats a neutral input-block upsert onto an unchanged wire as a coordinate replacement', async () => {
    const base: NonNullable<ArtifactBundle['physicalLayout']> = {
      id: 'layout-wire-to-solid-base',
      version: 4,
      logicDesignRef: { id: 'logic-wire-to-solid', version: 1 },
      bounds: { x: 7, y: 4, z: 7 },
      blocks: [{
        id: 'old-wire',
        block: 'minecraft:redstone_wire',
        position: { x: 3, y: 0, z: 3 },
        properties: {},
        implements: ['edge-in'],
      }],
      explanation: { overview: 'base', criticalOrientations: [], routingNotes: [] },
    }
    const { result } = await generateWithResponses('repair-wire-to-solid', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'repair_layout',
            patch: {
              baseVersion: 4,
              upsertBlocks: [{
                id: 'new-input-block',
                block: 'minecraft:stone',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['node-not'],
              }],
              removeBlockIds: [],
              explanation: base.explanation,
              changeSummary: { reason: 'add inverter input', changed: ['new-input-block'], impact: ['test'] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }], {
      stage: 'layout',
      requestedModel: 'minimax/minimax-m3.1-flash',
      artifacts: { physicalLayout: base },
    })

    expect(result.action.type).toBe('repair_layout')
    if (result.action.type !== 'repair_layout') throw new Error('unexpected action')
    expect(result.action.patch.removeBlockIds).toEqual(['old-wire'])
    expect(result.action.patch.upsertBlocks).toEqual([
      expect.objectContaining({ id: 'new-input-block', implements: ['edge-in', 'node-not'] }),
    ])
    expect(result.formatErrors).toContain('Replaced resident passive block old-wire with new-input-block at 3,0,3')
  })

  it('merges a symbolic wire into the sole signal component at an initial-layout coordinate', async () => {
    const { result } = await generateWithResponses('merge-initial-component-wire', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'propose_layout',
            layout: {
              bounds: { x: 7, y: 4, z: 7 },
              blocks: [{
                id: 'path-wire',
                block: 'minecraft:redstone_wire',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['edge-path'],
              }, {
                id: 'path-repeater',
                block: 'minecraft:repeater',
                position: { x: 3, y: 0, z: 3 },
                properties: { facing: 'east', delay: 1 },
                implements: ['node-buffer'],
              }],
              explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }], { stage: 'layout', requestedModel: 'minimax/minimax-m3.1-flash' })

    expect(result.action.type).toBe('propose_layout')
    if (result.action.type !== 'propose_layout') throw new Error('unexpected action')
    expect(result.action.layout.blocks).toEqual([
      expect.objectContaining({ id: 'path-repeater', implements: ['node-buffer', 'edge-path'] }),
    ])
    expect(result.formatErrors).toContain('Merged symbolic passive block path-wire into path-repeater at 3,0,3')
  })

  it('merges an initial route-end wire into its sole neutral attachment block', async () => {
    const { result } = await generateWithResponses('merge-initial-solid-wire', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'propose_layout',
            layout: {
              bounds: { x: 7, y: 4, z: 7 },
              blocks: [{
                id: 'route-end-wire',
                block: 'minecraft:redstone_wire',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['edge-in'],
              }, {
                id: 'inverter-body',
                block: 'minecraft:stone',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['node-not'],
              }],
              explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }], { stage: 'layout', requestedModel: 'minimax/minimax-m3.1-flash' })

    expect(result.action.type).toBe('propose_layout')
    if (result.action.type !== 'propose_layout') throw new Error('unexpected action')
    expect(result.action.layout.blocks).toEqual([
      expect.objectContaining({ id: 'inverter-body', implements: ['node-not', 'edge-in'] }),
    ])
    expect(result.formatErrors).toContain('Merged symbolic passive block route-end-wire into inverter-body at 3,0,3')
  })

  it('merges co-upserted symbolic wires into a repair component', async () => {
    const base: NonNullable<ArtifactBundle['physicalLayout']> = {
      id: 'layout-component-wire-patch-base',
      version: 5,
      logicDesignRef: { id: 'logic-component-wire-patch', version: 1 },
      bounds: { x: 7, y: 4, z: 7 },
      blocks: [{
        id: 'lamp-Y',
        block: 'minecraft:redstone_lamp',
        position: { x: 6, y: 0, z: 3 },
        properties: {},
        implements: ['Y'],
      }],
      explanation: { overview: 'base', criticalOrientations: [], routingNotes: [] },
    }
    const { result } = await generateWithResponses('merge-repair-component-wire', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'repair_layout',
            patch: {
              baseVersion: 5,
              upsertBlocks: [{
                id: 'new-wire',
                block: 'minecraft:redstone_wire',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['edge-path'],
              }, {
                id: 'new-repeater',
                block: 'minecraft:repeater',
                position: { x: 3, y: 0, z: 3 },
                properties: { facing: 'east', delay: 1 },
                implements: ['node-buffer'],
              }],
              removeBlockIds: [],
              explanation: base.explanation,
              changeSummary: { reason: 'add buffer', changed: ['new-repeater'], impact: ['test'] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }], {
      stage: 'layout',
      requestedModel: 'minimax/minimax-m3.1-flash',
      artifacts: { physicalLayout: base },
    })

    expect(result.action.type).toBe('repair_layout')
    if (result.action.type !== 'repair_layout') throw new Error('unexpected action')
    expect(result.action.patch.upsertBlocks).toEqual([
      expect.objectContaining({ id: 'new-repeater', implements: ['node-buffer', 'edge-path'] }),
    ])
    expect(result.action.patch.removeBlockIds).toEqual([])
    expect(result.formatErrors).toContain('Merged symbolic passive block new-wire into new-repeater at 3,0,3')
  })

  it('merges duplicate symbolic wires in an initial layout into one physical block', async () => {
    const { result } = await generateWithResponses('merge-symbolic-wires', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'propose_layout',
            layout: {
              bounds: { x: 7, y: 4, z: 7 },
              blocks: [{
                id: 'wire-A',
                block: 'minecraft:redstone_wire',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['edge-A'],
              }, {
                id: 'wire-B',
                block: 'minecraft:redstone_wire',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['edge-B'],
              }],
              explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }], { stage: 'layout', requestedModel: 'minimax/minimax-m3.1-flash' })

    expect(result.action.type).toBe('propose_layout')
    if (result.action.type !== 'propose_layout') throw new Error('unexpected action')
    expect(result.action.layout.blocks).toHaveLength(1)
    expect(result.action.layout.blocks[0].implements).toEqual(['edge-A', 'edge-B'])
    expect(result.formatErrors).toContain('Merged co-located minecraft:redstone_wire wire-B into wire-A at 3,0,3')
  })

  it('merges a repair wire into the stable wire already occupying its coordinate', async () => {
    const base: NonNullable<ArtifactBundle['physicalLayout']> = {
      id: 'layout-wire-merge-base',
      version: 3,
      logicDesignRef: { id: 'logic-wire-merge', version: 1 },
      bounds: { x: 7, y: 4, z: 7 },
      blocks: [{
        id: 'wire-A',
        block: 'minecraft:redstone_wire',
        position: { x: 3, y: 0, z: 3 },
        properties: {},
        implements: ['edge-A'],
      }],
      explanation: { overview: 'base', criticalOrientations: [], routingNotes: [] },
    }
    const { result } = await generateWithResponses('merge-repair-wires', [{
      body: {
        model: 'minimax/minimax-m3.1-flash',
        provider: 'InferenceNet',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            type: 'repair_layout',
            patch: {
              baseVersion: 3,
              upsertBlocks: [{
                id: 'wire-B',
                block: 'minecraft:redstone_wire',
                position: { x: 3, y: 0, z: 3 },
                properties: {},
                implements: ['edge-B'],
              }],
              removeBlockIds: [],
              explanation: base.explanation,
              changeSummary: { reason: 'test', changed: ['wire-B'], impact: ['test'] },
            },
            message: 'test',
          }) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      },
    }], {
      stage: 'layout',
      requestedModel: 'minimax/minimax-m3.1-flash',
      artifacts: { physicalLayout: base },
    })

    expect(result.action.type).toBe('repair_layout')
    if (result.action.type !== 'repair_layout') throw new Error('unexpected action')
    expect(result.action.patch.upsertBlocks).toEqual([
      expect.objectContaining({ id: 'wire-A', implements: ['edge-A', 'edge-B'] }),
    ])
    expect(result.action.patch.removeBlockIds).toEqual([])
    expect(result.formatErrors).toContain('Merged co-located minecraft:redstone_wire wire-B into wire-A at 3,0,3')
  })
})
