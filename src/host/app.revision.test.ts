import type { Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from '@platform/artifact-store'
import { createApp } from './app'
import type { AppConfig } from '@platform/config'
import { SessionCommandError, type SessionController } from '@agent/controller/session-controller'
import { SessionViewerManager } from '@minecraft/session-viewers'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

const config: AppConfig = {
  apiPort: 0,
  webOrigin: 'http://localhost:5173',
  runsDir: '/tmp/mc-ic-unused-test-runs',
  modelMode: 'fixture',
  runPolicy: { maxTaskVersions: 2, maxLogicVersions: 3, maxLayoutVersions: 5 },
  openRouter: {
    model: 'fixture/not-gate-v1',
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

describe('legacy viewer links', () => {
  it('uses only the requesting tab session and never a global current world', async () => {
    const worldView = vi.fn((id: string) => ({ available: true, viewerUrl: `/minecraft-viewer/${id}/` }))
    const controller = { worldView } as unknown as SessionController
    const viewers = new SessionViewerManager(config.minecraft, () => ({ view: { available: false } }))
    const proxy = ((_request, response) => { response.statusCode = 204; response.end() }) as NonNullable<Parameters<typeof createApp>[3]>
    const app = createApp(config, controller, new ArtifactStore(config.runsDir), proxy, viewers)
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const base = `http://127.0.0.1:${address.port}`
    for (const id of ['session-student', 'session-teacher']) {
      const response = await fetch(`${base}/minecraft-viewer/`, {
        headers: { Referer: `${base}/?session=${id}` }, redirect: 'manual',
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`/minecraft-viewer/${id}/`)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const direct = await fetch(`${base}/minecraft-viewer/?session=session-student`, { redirect: 'manual' })
    expect(direct.headers.get('location')).toBe('/minecraft-viewer/session-student/')
    for (const headers of [new Headers(), new Headers({ Referer: 'http://other.test/?session=other' })]) {
      const response = await fetch(`${base}/minecraft-viewer/`, { headers, redirect: 'manual' })
      expect(response.status).toBe(410)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(worldView.mock.calls).toEqual([['session-student'], ['session-teacher'], ['session-student']])
  })
})

async function startApi(reviseLayout: (sessionId: string, instruction?: string) => void) {
  const controller = { reviseLayout } as unknown as SessionController
  const app = createApp(config, controller, new ArtifactStore(config.runsDir))
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function post(baseUrl: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/sessions/session-test/commands/revise-layout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

async function startRetryApi(retryLayout: (sessionId: string, instruction?: string) => void) {
  const controller = { retryLayout } as unknown as SessionController
  const app = createApp(config, controller, new ArtifactStore(config.runsDir))
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function postRetry(baseUrl: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/sessions/session-test/commands/retry-layout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

describe('POST revise-layout API', () => {
  it('accepts an empty object, trims instructions, and treats a blank instruction as absent', async () => {
    const reviseLayout = vi.fn<(sessionId: string, instruction?: string) => void>()
    const baseUrl = await startApi(reviseLayout)

    const automatic = await post(baseUrl, {})
    expect(automatic.response.status).toBe(202)
    expect(automatic.body).toEqual({ accepted: true })

    const guided = await post(baseUrl, { instruction: '  简化为平面布局  ' })
    expect(guided.response.status).toBe(202)

    const blank = await post(baseUrl, { instruction: '   ' })
    expect(blank.response.status).toBe(202)
    expect(reviseLayout.mock.calls).toEqual([
      ['session-test', undefined],
      ['session-test', '简化为平面布局'],
      ['session-test', undefined],
    ])
  })

  it('returns HTTP 400 when the trimmed instruction exceeds 2000 characters', async () => {
    const reviseLayout = vi.fn<(sessionId: string, instruction?: string) => void>()
    const baseUrl = await startApi(reviseLayout)

    const result = await post(baseUrl, { instruction: `  ${'x'.repeat(2_001)}  ` })

    expect(result.response.status).toBe(400)
    expect(result.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    expect(reviseLayout).not.toHaveBeenCalled()
  })

  it('maps revision state conflicts to HTTP 409 with the controller message', async () => {
    const reviseLayout = vi.fn(() => {
      throw new SessionCommandError(
        'Layout changes are only allowed before building; current state is VERIFYING.',
        'LAYOUT_RETRY_INVALID_STATE',
      )
    })
    const baseUrl = await startApi(reviseLayout)

    const result = await post(baseUrl, {})

    expect(result.response.status).toBe(409)
    expect(result.body).toEqual({
      error: {
        code: 'LAYOUT_RETRY_INVALID_STATE',
        message: 'Layout changes are only allowed before building; current state is VERIFYING.',
      },
    })
  })
})

describe('POST retry-layout API', () => {
  it('starts a new layout cycle and accepts an optional instruction', async () => {
    const retryLayout = vi.fn<(sessionId: string, instruction?: string) => void>()
    const baseUrl = await startRetryApi(retryLayout)

    const automatic = await postRetry(baseUrl, {})
    const guided = await postRetry(baseUrl, { instruction: '  保留第三版已修好的支撑关系  ' })

    expect(automatic.response.status).toBe(202)
    expect(guided.response.status).toBe(202)
    expect(retryLayout.mock.calls).toEqual([
      ['session-test', undefined],
      ['session-test', '保留第三版已修好的支撑关系'],
    ])
  })

  it('returns a conflict when the failed session is not layout-recoverable', async () => {
    const retryLayout = vi.fn(() => {
      throw new SessionCommandError('This failure cannot restart from PhysicalLayout.', 'LAYOUT_RETRY_UNSUPPORTED_FAILURE')
    })
    const baseUrl = await startRetryApi(retryLayout)

    const result = await postRetry(baseUrl, {})

    expect(result.response.status).toBe(409)
    expect(result.body).toEqual({
      error: {
        code: 'LAYOUT_RETRY_UNSUPPORTED_FAILURE',
        message: 'This failure cannot restart from PhysicalLayout.',
      },
    })
  })
})

describe('retired world correction APIs', () => {
  it('rejects old clients without starting another design or build', async () => {
    const reviseLayout = vi.fn()
    const baseUrl = await startApi(reviseLayout)
    for (const command of ['correct-from-world', 'recover-world-correction']) {
      const response = await fetch(`${baseUrl}/api/sessions/session-test/commands/${command}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      expect(response.status).toBe(410)
      expect(await response.json()).toMatchObject({ error: { code: 'WORLD_CORRECTION_RETIRED' } })
    }
    expect(reviseLayout).not.toHaveBeenCalled()
  })
})
