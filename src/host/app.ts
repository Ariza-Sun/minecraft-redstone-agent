import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { createProxyMiddleware, type RequestHandler as ProxyRequestHandler } from 'http-proxy-middleware'
import { z } from 'zod'
import { selectableModelOptions } from '@domain/model-catalog'
import type { ArtifactStore } from '@platform/artifact-store'
import { projectRoot, type AppConfig } from '@platform/config'
import { isAuthorized, WWW_AUTHENTICATE } from '@platform/basic-auth'
import type { SessionController } from '@agent/controller/session-controller'
import type { SessionViewerManager } from '@minecraft/session-viewers'

const createSessionSchema = z.object({
  request: z.string().trim().min(3).max(20_000),
  mode: z.enum(['interactive', 'benchmark']).default('interactive'),
  model: z.string().trim().min(1).max(200).optional(),
})
const messageSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  focus: z.object({
    logicId: z.string().min(1).optional(),
    caseIndex: z.number().int().nonnegative().optional(),
  }).optional(),
})
const showCaseSchema = z.object({ caseIndex: z.number().int().nonnegative() })
const reviseLayoutSchema = z.object({
  instruction: z.string().trim().max(2_000).optional(),
})
function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next)
  }
}

export function createViewerProxy(config: AppConfig, viewers?: SessionViewerManager): ProxyRequestHandler | undefined {
  if (config.minecraft.mode !== 'live' || !config.minecraft.viewerEnabled) return undefined
  return createProxyMiddleware({
    target: `http://127.0.0.1:${config.minecraft.viewerPort}`,
    changeOrigin: true,
    // Upgrades are routed explicitly by index.ts after auth/session checks.
    ws: false,
    pathFilter: (pathname) => pathname.startsWith('/minecraft-viewer/'),
    ...(viewers ? { router: (request) => {
      const id = /^\/minecraft-viewer\/([^/]+)\//.exec((request as Request).originalUrl ?? request.url ?? '')?.[1]
      const port = id && viewers.port(decodeURIComponent(id))
      if (!port) throw new Error('Session viewer is not ready')
      return `http://127.0.0.1:${port}`
    } } : { pathRewrite: { '^/minecraft-viewer': '' } }),
    logger: console,
  })
}

let bridgedViewerClient: string | undefined

function viewerClientWithCameraBridge(): string {
  if (bridgedViewerClient) return bridgedViewerClient
  const clientPath = path.join(projectRoot, 'node_modules/prismarine-viewer/public/index.js')
  const source = readFileSync(clientPath, 'utf8')
  const controlsCreation = 'let h=new THREE.OrbitControls(u.camera,l.domElement);'
  const positionHandler = 'o.on("position",(({pos:t,addMesh:i,yaw:r,pitch:o})=>{'
  if (!source.includes(controlsCreation) || !source.includes(positionHandler)) {
    throw new Error('Installed prismarine-viewer client does not expose the expected OrbitControls bootstrap')
  }
  bridgedViewerClient = source.replace(
    controlsCreation,
    `${controlsCreation}window.__MC_VIEWER_BRIDGE__={camera:u.camera,get controls(){return h}};`,
  // The observer is the camera anchor, not a player to draw in the circuit.
  ).replace(positionHandler, `${positionHandler}i=false;`)
  return bridgedViewerClient
}

export function createApp(
  config: AppConfig,
  controller: SessionController,
  store: ArtifactStore,
  viewerProxy?: ProxyRequestHandler,
  viewers?: SessionViewerManager,
) {
  const app = express()
  const modelOptions = config.modelMode === 'openrouter'
    ? selectableModelOptions(config.openRouter.model)
    : [{
        id: 'fixture/not-gate-v1',
        name: 'Fixture · 预置 NOT',
        provider: 'Local',
        description: '离线确定性样例',
        context: 'fixed',
        free: true,
        supportsResponseFormat: true,
        supportsStructuredOutputs: false,
      }]
  const defaultModel = config.modelMode === 'openrouter' ? config.openRouter.model : modelOptions[0].id
  const selectableModelIds = new Set(modelOptions.map((option) => option.id))
  app.disable('x-powered-by')
  // Shared-credential gate for public exposure. When config.auth is unset the
  // app stays open (localhost / tunnel use). /api/health is left reachable for
  // uptime probes, and OPTIONS preflights never carry credentials.
  if (config.auth) {
    const auth = config.auth
    app.use((request, response, next) => {
      if (request.method === 'OPTIONS' || request.path === '/api/health') return next()
      if (isAuthorized(request.headers.authorization, auth)) return next()
      response.setHeader('WWW-Authenticate', WWW_AUTHENTICATE)
      return response.status(401).json({ error: { code: 'UNAUTHORIZED', message: '需要登录。' } })
    })
  }
  app.use(express.json({ limit: '2mb' }))
  app.use((request, response, next) => {
    response.header('Access-Control-Allow-Origin', config.webOrigin)
    response.header('Access-Control-Allow-Headers', 'Content-Type')
    response.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    if (request.method === 'OPTIONS') return response.sendStatus(204)
    next()
  })

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, modelMode: config.modelMode, minecraftMode: config.minecraft.mode })
  })

  app.get('/api/config', (_request, response) => {
    response.json({
      model: defaultModel,
      models: modelOptions,
      modelMode: config.modelMode,
      minecraftMode: config.minecraft.mode,
      authoritative: config.minecraft.mode === 'live',
      runPolicy: config.runPolicy,
      viewerUrl: config.minecraft.mode === 'live' && config.minecraft.viewerEnabled
        ? config.minecraft.viewerPublicUrl
        : undefined,
    })
  })

  if (viewerProxy) {
    if (viewers) app.get('/minecraft-viewer', (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      // Older open tabs used a shared viewer URL. Recover only the session
      // named by this tab, never the last globally active Minecraft task.
      let sessionId = typeof request.query.session === 'string' ? request.query.session : undefined
      if (!sessionId && request.get('referer')) {
        try {
          const parent = new URL(request.get('referer')!)
          if (parent.host === request.get('host')) sessionId = parent.searchParams.get('session') ?? undefined
        } catch { /* No usable parent URL; ask for a session explicitly. */ }
      }
      if (sessionId) {
        const view = controller.worldView(sessionId)
        if (view.available && view.viewerUrl) {
          response.redirect(302, view.viewerUrl)
          return
        }
        response.status(409).json({ error: { code: 'WORLD_SESSION_NOT_ACTIVE', message: view.reason ?? '此会话的 Minecraft 画面尚未就绪。' } })
        return
      }
      response.status(410).json({ error: { code: 'SESSION_VIEWER_REQUIRED', message: '请刷新任务页面后查看 Minecraft 画面，或从具体会话重新打开。' } })
    })
    if (viewers) app.use('/minecraft-viewer/:sessionId', asyncRoute(async (request, response, next) => {
      // All viewer HTTP resources are scoped, including Socket.IO polling.
      await viewers.ensure(String(request.params.sessionId))
      response.locals.sessionViewerReady = true
      next()
    }))
    app.get('/minecraft-viewer/:sessionId/index.js', (_request, response, next) => {
      try {
        response.type('application/javascript').header('Cache-Control', 'no-store').send(viewerClientWithCameraBridge())
      } catch (error) {
        next(error)
      }
    })
    if (viewers) {
      app.use('/minecraft-viewer', (request, response, next) => {
        if (!response.locals.sessionViewerReady) {
          response.header('Cache-Control', 'no-store').status(410).json({ error: { code: 'SESSION_VIEWER_REQUIRED', message: '请从具体会话打开 Minecraft 画面。' } })
          return
        }
        next()
      })
      app.use(viewerProxy)
    } else app.use('/minecraft-viewer', viewerProxy)
  }

  app.get('/api/sessions', (request, response) => {
    response.json(request.query.view === 'summary' ? controller.summaries() : controller.list())
  })

  app.post('/api/sessions', asyncRoute(async (request, response) => {
    const body = createSessionSchema.parse(request.body)
    const selectedModel = body.model ?? defaultModel
    if (!selectableModelIds.has(selectedModel)) {
      response.status(400).json({ error: {
        code: 'MODEL_NOT_ALLOWED',
        message: '请选择服务端提供的模型。',
      } })
      return
    }
    const snapshot = await controller.create(body.request, body.mode, selectedModel)
    controller.begin(snapshot.id)
    response.status(202).json(snapshot)
  }))

  app.get('/api/sessions/:sessionId', (request, response) => {
    response.json(controller.get(request.params.sessionId))
  })

  app.get('/api/sessions/:sessionId/artifacts', (request, response) => {
    response.json(controller.get(request.params.sessionId).artifacts)
  })

  app.get('/api/artifacts/:artifactId/versions/:version', (request, response) => {
    const artifact = controller.findArtifact(request.params.artifactId, Number.parseInt(request.params.version, 10))
    if (!artifact) return response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Artifact version not found' } })
    response.json(artifact)
  })

  app.post('/api/sessions/:sessionId/messages', asyncRoute(async (request, response) => {
    const body = messageSchema.parse(request.body)
    const reply = await controller.sendMessage(String(request.params.sessionId), body.message, body.focus)
    response.json({ accepted: true, reply })
  }))

  app.post('/api/sessions/:sessionId/commands/approve-design', (request, response) => {
    controller.approveDesign(request.params.sessionId)
    response.status(202).json({ accepted: true })
  })

  app.post('/api/sessions/:sessionId/commands/start-build', (request, response) => {
    controller.startBuild(request.params.sessionId)
    response.status(202).json({ accepted: true })
  })

  app.post('/api/sessions/:sessionId/commands/revise-layout', (request, response) => {
    const body = reviseLayoutSchema.parse(request.body)
    controller.reviseLayout(request.params.sessionId, body.instruction || undefined)
    response.status(202).json({ accepted: true })
  })

  // Old clients must not resume the retired post-verification design loop.
  for (const command of ['correct-from-world', 'recover-world-correction']) {
    app.post(`/api/sessions/:sessionId/commands/${command}`, (_request, response) => {
      response.status(410).json({ error: {
        code: 'WORLD_CORRECTION_RETIRED',
        message: '实测后的设计纠错已取消；请在第三步通过布局检查与模拟进行修订。',
      } })
    })
  }

  app.post('/api/sessions/:sessionId/commands/retry-layout', (request, response) => {
    const body = reviseLayoutSchema.parse(request.body)
    controller.retryLayout(request.params.sessionId, body.instruction || undefined)
    response.status(202).json({ accepted: true })
  })

  app.post('/api/sessions/:sessionId/commands/show-case', asyncRoute(async (request, response) => {
    const body = showCaseSchema.parse(request.body)
    const worldState = await controller.showVerificationCase(String(request.params.sessionId), body.caseIndex)
    response.json(worldState)
  }))

  app.get('/api/sessions/:sessionId/events', (request, response) => {
    const after = Number.parseInt(String(request.query.after ?? '0'), 10) || 0
    const events = controller.events(request.params.sessionId, after)
    if (!request.headers.accept?.includes('text/event-stream')) return response.json(events)

    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders()
    for (const event of events) response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    const unsubscribe = store.subscribe(request.params.sessionId, (event) => {
      if (event.seq > after) response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000)
    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  const webDir = path.join(projectRoot, 'dist/web')
  if (existsSync(webDir)) {
    app.use(express.static(webDir, { setHeaders(response, filePath) {
      if (filePath.endsWith('.html')) response.setHeader('Cache-Control', 'no-store')
    } }))
    app.use((request, response, next) => {
      if (request.method !== 'GET' || request.path.startsWith('/api/')) return next()
      response.header('Cache-Control', 'no-store').sendFile(path.join(webDir, 'index.html'))
    })
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const structured = error && typeof error === 'object' && 'code' in error && 'message' in error
      ? error as { code: unknown; message: unknown }
      : undefined
    const structuredCode = structured ? String(structured.code) : undefined
    const status = error instanceof z.ZodError
      ? 400
      : structuredCode === 'LAYOUT_REVISION_INSTRUCTION_TOO_LONG'
        || structuredCode === 'LAYOUT_RETRY_INSTRUCTION_TOO_LONG'
        || structuredCode === 'LAYOUT_RESTART_INSTRUCTION_TOO_LONG'
        ? 400
      : structuredCode === 'CASE_NOT_FOUND'
        ? 404
        : structuredCode === 'WORLD_SESSION_NOT_ACTIVE'
          || structuredCode?.startsWith('LAYOUT_RESTART_')
          || structuredCode?.startsWith('LAYOUT_REVISION_')
          || structuredCode?.startsWith('LAYOUT_RETRY_')
          ? 409
      : error instanceof Error && error.message.startsWith('Unknown session')
        ? 404
        : error instanceof Error && error.message.includes('is not allowed in')
          ? 409
          : 500
    const message = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : structured ? String(structured.message)
      : error instanceof Error ? error.message : String(error)
    response.status(status).json({ error: {
      code: structured
        ? String(structured.code)
        : status === 400 ? 'INVALID_REQUEST' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'INVALID_STATE' : 'INTERNAL_ERROR',
      message,
    } })
  })

  return app
}
