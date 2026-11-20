import type { Socket } from 'node:net'
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { ArtifactStore } from '@platform/artifact-store'
import { createApp, createViewerProxy } from './app'
import { loadConfig } from '@platform/config'
import { isAuthorized } from '@platform/basic-auth'
import { LiveMinecraftAdapter } from '@minecraft/live-adapter'
import type { MinecraftAdapter } from '@minecraft/minecraft-adapter'
import { MockMinecraftAdapter } from '@minecraft/mock-adapter'
import { FixtureModelAdapter } from '@agent/model/fixture-adapter'
import type { ModelAdapter } from '@agent/model/model-adapter'
import { OpenRouterModelAdapter } from '@agent/model/openrouter-adapter'
import { SessionController } from '@agent/controller/session-controller'
import { SessionViewerManager } from '@minecraft/session-viewers'

const config = loadConfig()
const hasOutboundProxy = [
  process.env.HTTPS_PROXY,
  process.env.https_proxy,
  process.env.HTTP_PROXY,
  process.env.http_proxy,
].some(Boolean)

// Buffered layout responses can take longer than Undici's default five-minute
// header timeout. Match the transport ceiling to the model budget;
// the adapter still applies its shorter per-stage deadlines.
const transportTimeouts = { headersTimeout: config.openRouter.timeoutMs, bodyTimeout: config.openRouter.timeoutMs }
setGlobalDispatcher(hasOutboundProxy
  ? new EnvHttpProxyAgent(transportTimeouts)
  : new Agent(transportTimeouts))
const store = new ArtifactStore(config.runsDir)
await store.initialize()
const restoredSessions = await store.loadSessions()

const model: ModelAdapter = config.modelMode === 'fixture'
  ? new FixtureModelAdapter(store)
  : new OpenRouterModelAdapter(config.openRouter, store)

const minecraft: MinecraftAdapter = config.minecraft.mode === 'mock'
  ? new MockMinecraftAdapter(config.minecraft)
  : new LiveMinecraftAdapter({ ...config.minecraft, viewerEnabled: false })

const controller = new SessionController(store, model, minecraft, config.runPolicy, restoredSessions)
await controller.restoreWorldConnection().catch((error) => {
  console.warn('Unable to reconnect to the existing Minecraft circuit:', error)
})
const viewers = config.minecraft.mode === 'live' && config.minecraft.viewerEnabled
  ? new SessionViewerManager(config.minecraft, (id) => ({ view: controller.worldView(id), task: controller.get(id).artifacts.task }),
    undefined, (username, position) => controller.positionObserver(username, position))
  : undefined
const viewerProxy = createViewerProxy(config, viewers)
const app = createApp(config, controller, store, viewerProxy, viewers)
const server = app.listen(config.apiPort, '0.0.0.0', () => {
  console.log(`mc-ic API: http://localhost:${config.apiPort}`)
  console.log(`model=${model.model} (${model.mode}), minecraft=${minecraft.mode}, authoritative=${minecraft.authoritative}`)
  if (hasOutboundProxy) console.log('outbound proxy=environment')
  console.log(config.auth
    ? `web auth=basic (user "${config.auth.user}")`
    : 'web auth=OFF — do not expose this port publicly without WEB_AUTH_USER/WEB_AUTH_PASS')
  if (!minecraft.authoritative) console.log('WARNING: mock Minecraft mode is never authoritative and cannot produce SUCCEEDED.')
})

if (viewerProxy) {
  server.on('upgrade', (request, socket, head) => {
    // Express middleware does not see raw upgrades, so gate the viewer socket here too.
    if (config.auth && !isAuthorized(request.headers.authorization, config.auth)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="mc-ic"\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (request.url?.startsWith('/minecraft-viewer/')) {
      const id = /^\/minecraft-viewer\/([^/]+)\//.exec(request.url)?.[1]
      try {
        if (!id || !viewers?.port(decodeURIComponent(id)) || !controller.worldView(decodeURIComponent(id)).available) {
          socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); socket.destroy(); return
        }
        viewerProxy.upgrade(request, socket as Socket, head)
      } catch { socket.destroy() }
    }
    else socket.destroy()
  })
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}; closing mc-ic.`)
  server.close()
  await viewers?.close()
  await minecraft.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
