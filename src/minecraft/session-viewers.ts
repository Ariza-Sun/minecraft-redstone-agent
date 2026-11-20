import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import mineflayer, { type Bot } from 'mineflayer'
import type { Position, SessionSnapshot, TaskSpec } from '@domain/domain'
import type { AppConfig } from '@platform/config'
import { closestViewerVersion } from './live-adapter'
import { createViewerBotBridge } from './viewer-version-bridge'

type Viewer = { port: number; close(): Promise<void> }
type View = NonNullable<SessionSnapshot['worldView']>
type Factory = (sessionId: string, view: View, task: TaskSpec) => Promise<Viewer>

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a viewer port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

export type ViewerLimits = {
  /** Observer bots kept online at once. */
  maxViewers: number
  /** An observer nobody has requested for this long is logged out. */
  idleMs: number
  /** How often idle observers are swept. */
  sweepMs: number
  now: () => number
}

// The Minecraft server allows 100 players and RedstoneBot (the builder) holds
// one slot, so at most 99 observers. Observers only render the view; logging
// one out never touches blocks, and its page reconnects on the next request.
export const DEFAULT_VIEWER_LIMITS: ViewerLimits = {
  maxViewers: 99,
  idleMs: 24 * 60 * 60 * 1000,
  sweepMs: 60 * 60 * 1000,
  now: () => Date.now(),
}

// Each browser stream follows its own stationary observer. Viewing one task
// never teleports the builder or changes another student's camera/inputs.
export class SessionViewerManager {
  private readonly viewers = new Map<string, Promise<Viewer>>()
  private readonly ports = new Map<string, number>()
  private readonly lastUsed = new Map<string, number>()
  private readonly limits: ViewerLimits
  private readonly sweeper: NodeJS.Timeout
  constructor(
    private readonly config: AppConfig['minecraft'],
    private readonly resolve: (id: string) => { view: View; task?: TaskSpec },
    private readonly factory: Factory = (id, view, task) => this.start(id, view, task),
    private readonly positionObserver?: (username: string, position: Position) => Promise<void>,
    limits: Partial<ViewerLimits> = {},
  ) {
    this.limits = { ...DEFAULT_VIEWER_LIMITS, ...limits }
    this.sweeper = setInterval(() => { void this.sweep() }, this.limits.sweepMs)
    this.sweeper.unref()
  }

  async ensure(id: string): Promise<number> {
    const { view, task } = this.resolve(id)
    if (!view.available || !view.origin || !task) throw { code: 'WORLD_SESSION_NOT_ACTIVE', message: view.reason ?? '此会话尚无可展示的 Minecraft 电路。' }
    this.lastUsed.set(id, this.limits.now())
    let pending = this.viewers.get(id)
    if (!pending) {
      // Free a slot first (least recently used), so the server never answers
      // a new observer with "server full".
      const evicted = this.evictLeastRecentlyUsed(this.limits.maxViewers - 1)
      const created: Promise<Viewer> = Promise.all(evicted).then(() => this.factory(id, view, task))
      pending = created
      this.viewers.set(id, created)
      created.catch(() => {
        if (this.viewers.get(id) !== created) return
        this.viewers.delete(id)
        this.ports.delete(id)
      })
    }
    const viewer = await pending
    if (this.viewers.get(id) === pending) this.ports.set(id, viewer.port)
    return viewer.port
  }

  port(id: string): number | undefined { return this.ports.get(id) }

  /** Log out every observer that has not been requested within idleMs. */
  async sweep(): Promise<void> {
    const cutoff = this.limits.now() - this.limits.idleMs
    const idle = [...this.viewers.keys()].filter((id) => (this.lastUsed.get(id) ?? 0) <= cutoff)
    await Promise.all(idle.map((id) => this.retire(id)))
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper)
    await Promise.all([...this.viewers.keys()].map((id) => this.retire(id)))
  }

  private evictLeastRecentlyUsed(keep: number): Promise<void>[] {
    const evicted: Promise<void>[] = []
    while (this.viewers.size > Math.max(0, keep)) {
      let oldest: string | undefined
      for (const id of this.viewers.keys()) {
        if (oldest === undefined || (this.lastUsed.get(id) ?? 0) < (this.lastUsed.get(oldest) ?? 0)) oldest = id
      }
      evicted.push(this.retire(oldest!))
    }
    return evicted
  }

  // Forget the observer synchronously, then log it out once it has connected.
  private retire(id: string): Promise<void> {
    const pending = this.viewers.get(id)
    this.viewers.delete(id)
    this.ports.delete(id)
    this.lastUsed.delete(id)
    if (!pending) return Promise.resolve()
    return pending.then((viewer) => viewer.close(), () => undefined).catch(() => undefined)
  }

  private async start(id: string, view: View, task: TaskSpec): Promise<Viewer> {
    const bot = mineflayer.createBot({ host: this.config.host, port: this.config.port, auth: 'offline',
      username: `MICA_v_${createHash('sha256').update(id).digest('hex').slice(0, 8)}` })
    bot.on('error', (error) => console.warn(`Session viewer ${id}:`, error.message))
    let pulse: NodeJS.Timeout | undefined
    const close = async () => {
      if (pulse) clearInterval(pulse)
      ;(bot as Bot & { viewer?: { close(): void } }).viewer?.close()
      bot.quit()
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('Minecraft viewer connection timed out')), 30_000)
        const finish = (error?: Error) => {
          clearTimeout(timeout); bot.off('spawn', spawned); bot.off('error', failed); bot.off('kicked', kicked)
          error ? reject(error) : resolve()
        }
        const spawned = () => finish()
        const failed = (error: Error) => finish(error)
        const kicked = (reason: unknown) => finish(new Error(String(reason)))
        bot.once('spawn', spawned); bot.once('error', failed); bot.once('kicked', kicked)
      })
      bot.physicsEnabled = false
      const origin = view.origin!
      const target = { x: origin.x + Math.floor(task.workspace.size.x / 2), y: origin.y + 4, z: origin.z + Math.floor(task.workspace.size.z / 2) }
      // These commands only move the observer; no block or redstone is changed.
      if (this.positionObserver) await this.positionObserver(bot.username, target)
      else {
        bot.chat('/gamemode spectator @s')
        await pause(100)
        bot.chat(`/tp @s ${target.x} ${target.y} ${target.z}`)
      }
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (Math.abs(bot.entity.position.x - target.x) < 2 && Math.abs(bot.entity.position.y - target.y) < 2 && Math.abs(bot.entity.position.z - target.z) < 2) break
        if (attempt === 49) throw new Error('Minecraft viewer could not reach its session workspace')
        await pause(100)
      }
      const viewerModule = await import('prismarine-viewer')
      const viewer = (viewerModule.default ?? viewerModule) as typeof viewerModule
      const version = closestViewerVersion(bot.version, viewerModule.supportedVersions ?? viewer.supportedVersions)
      const port = await availablePort()
      const viewerOptions = { port, firstPerson: false, prefix: `/minecraft-viewer/${id}` }
      viewer.mineflayer(createViewerBotBridge(bot, version, [this.config.username]), viewerOptions)
      pulse = setInterval(() => bot.emit('move', bot.entity.position.clone()), 1000)
      pulse.unref()
      bot.once('end', () => {
        if (pulse) clearInterval(pulse)
        ;(bot as Bot & { viewer?: { close(): void } }).viewer?.close()
        // Only clean up if this bot is still the session's current observer;
        // a retired one may already have been replaced by a newer observer.
        if (this.ports.get(id) !== port) return
        this.viewers.delete(id)
        this.ports.delete(id)
        this.lastUsed.delete(id)
      })
      await pause(20)
      return { port, close }
    } catch (error) {
      await close()
      throw error
    }
  }
}
