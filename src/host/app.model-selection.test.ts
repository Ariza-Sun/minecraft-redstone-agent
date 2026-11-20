import type { Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from '@platform/artifact-store'
import { createApp } from './app'
import type { AppConfig } from '@platform/config'
import type { SessionController } from '@agent/controller/session-controller'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

const config: AppConfig = {
  apiPort: 0,
  webOrigin: 'http://localhost:5173',
  runsDir: '/tmp/mc-ic-unused-model-test-runs',
  modelMode: 'openrouter',
  runPolicy: { maxTaskVersions: 2, maxLogicVersions: 3, maxLayoutVersions: 5 },
  openRouter: {
    model: 'nvidia/nemotron-3.5-lightning:free',
    baseUrl: 'http://invalid.test',
    timeoutMs: 1,
    maxAttempts: 1,
    retryBaseMs: 1,
    maxOutputTokens: 1,
  },
  minecraft: {
    mode: 'mock',
    host: 'localhost',
    port: 25565,
    username: 'test',
    origin: { x: 0, y: 72, z: 0 },
    commandDelayMs: 0,
    settleMs: 0,
    viewerEnabled: false,
    viewerPort: 3007,
    viewerPublicUrl: '/minecraft-viewer/',
  },
}

async function startApi(overrides: Partial<AppConfig> = {}) {
  const create = vi.fn(async (_request: string, _mode: string, model?: string) => ({ id: 'session-test', model }))
  const begin = vi.fn()
  const controller = { create, begin, list: () => [] } as unknown as SessionController
  const app = createApp({ ...config, ...overrides }, controller, new ArtifactStore(config.runsDir))
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address')
  return { baseUrl: `http://127.0.0.1:${address.port}`, create, begin }
}

describe('OpenRouter model selection API', () => {
  it('exposes curated free and paid models with pricing and creates a session with the selected model', async () => {
    const { baseUrl, create, begin } = await startApi()
    const runtime = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as {
      models: Array<{
        id: string
        free: boolean
        pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number }
      }>
    }
    const nemotron = 'nvidia/nemotron-3.5-lightning:free'

    expect(runtime.models).toContainEqual(expect.objectContaining({ id: nemotron, free: true }))
    expect(runtime.models).toContainEqual(expect.objectContaining({
      id: 'deepseek/deepseek-v4-flash-0731',
      free: false,
      pricing: expect.objectContaining({
        inputUsdPerMillion: 0.119,
        outputUsdPerMillion: 0.238,
      }),
    }))
    expect(runtime.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'z-ai/glm-5.2', free: false }),
      expect.objectContaining({ id: 'x-ai/grok-4.6', free: false }),
      expect.objectContaining({ id: 'moonshotai/kimi-k2.6', free: false }),
      expect.objectContaining({ id: 'deepseek/deepseek-v4-pro', free: false }),
      expect.objectContaining({ id: 'deepseek/deepseek-v4.1-flash-1017', free: false }),
      expect.objectContaining({ id: 'qwen/qwen3.8-flash', free: false }),
      expect.objectContaining({ id: 'qwen/qwen3.8-max-0902', free: false }),
      expect.objectContaining({ id: 'moonshotai/kimi-k3.1-pro', free: false }),
      expect.objectContaining({ id: 'minimax/minimax-m3.1-flash', free: false }),
    ]))
    expect(runtime.models.some(({ id }) => /^(openai|anthropic|google)\//.test(id))).toBe(false)
    for (const id of ['qwen/qwen3-max', 'nvidia/nemotron-3-super-120b-a12b:free', 'cohere/north-mini-code:free']) {
      expect(runtime.models).not.toContainEqual(expect.objectContaining({ id }))
    }
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: '搭建并验证一个 NOT 门', model: nemotron }),
    })

    expect(response.status).toBe(202)
    expect(create).toHaveBeenCalledWith('搭建并验证一个 NOT 门', 'interactive', nemotron)
    expect(begin).toHaveBeenCalledWith('session-test')
  })

  it('rejects arbitrary model ids so the UI cannot select an unlisted paid model', async () => {
    const { baseUrl, create } = await startApi()
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: '搭建并验证一个 NOT 门', model: 'vendor/paid-model' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'MODEL_NOT_ALLOWED', message: '请选择服务端提供的模型。' },
    })
    expect(create).not.toHaveBeenCalled()
  })
})
