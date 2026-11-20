import mineflayer, { type Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import {
  normalizeBlockName,
  type BuildProgress,
  type BuildRun,
  type EvidenceRef,
  type LayoutBlock,
  type MinecraftEnvironment,
  type OutputReading,
  type OutputValue,
  type PhysicalLayout,
  type Position,
  type TaskSpec,
  type WorldBlockObservation,
} from '@domain/domain'
import { blockCapability } from '@domain/block-capabilities'
import type { AppConfig } from '@platform/config'
import { attachmentSupportPosition, orderBlocksForBuild } from '@domain/layout-physics'
import { GRASSLAND, isGrasslandSurface } from '@domain/world-environment'
import { MinecraftAdapterError, type MinecraftAdapter } from './minecraft-adapter'
import { grasslandResetCommands } from './grassland-workspace'
import { createViewerBotBridge } from './viewer-version-bridge'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const SETBLOCK_READBACK_TIMEOUT_MS = 3_000

function properties(block: ReturnType<Bot['blockAt']>): Record<string, unknown> {
  if (!block) return {}
  const candidate = block as typeof block & { _properties?: Record<string, unknown>; getProperties?: () => Record<string, unknown> }
  return candidate.getProperties?.() ?? candidate._properties ?? {}
}

function asBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

function propertyValue(value: string | boolean | number): string {
  const rendered = String(value)
  if (!/^[a-z0-9_-]+$/i.test(rendered)) throw new MinecraftAdapterError(`Unsafe blockstate value: ${rendered}`, 'UNSAFE_BLOCKSTATE')
  return rendered.toLowerCase()
}

function setblockSpec(block: LayoutBlock): string {
  const name = normalizeBlockName(block.block)
  if (!/^minecraft:[a-z0-9_]+$/.test(name)) throw new MinecraftAdapterError(`Unsafe block name: ${name}`, 'UNSAFE_BLOCK_NAME')
  const entries = Object.entries(block.properties).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return name
  const rendered = entries.map(([key, value]) => {
    if (!/^[a-z0-9_]+$/i.test(key)) throw new MinecraftAdapterError(`Unsafe blockstate key: ${key}`, 'UNSAFE_BLOCKSTATE')
    return `${key}=${propertyValue(value)}`
  })
  return `${name}[${rendered.join(',')}]`
}

export function closestViewerVersion(actual: string, supported: string[]): string {
  if (supported.includes(actual)) return actual
  const [major, minor, patch = 0] = actual.split('.').map((part) => Number.parseInt(part, 10))
  const sameSeries = supported
    .map((version) => ({ version, parts: version.split('.').map((part) => Number.parseInt(part, 10)) }))
    .filter(({ parts }) => parts[0] === major && parts[1] === minor)
    .sort((left, right) => Math.abs((left.parts[2] ?? 0) - patch) - Math.abs((right.parts[2] ?? 0) - patch))
  const match = sameSeries[0]?.version
  if (!match) {
    throw new MinecraftAdapterError(
      `Minecraft Viewer does not support server version ${actual}`,
      'VIEWER_VERSION_UNSUPPORTED',
      { supportedVersions: supported, recoverable: true },
    )
  }
  return match
}

export class LiveMinecraftAdapter implements MinecraftAdapter {
  readonly mode = 'live' as const
  readonly authoritative = true
  private bot?: Bot
  private environment?: MinecraftEnvironment
  private viewerPulse?: NodeJS.Timeout
  readonly baseOrigin: Position
  private origin: Position

  constructor(private readonly config: AppConfig['minecraft']) {
    this.baseOrigin = { ...config.origin }
    this.origin = { ...config.origin }
  }

  selectWorkspace(origin: Position): void {
    this.origin = { ...origin }
  }

  async positionObserver(username: string, position: Position): Promise<void> {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new Error('Invalid observer username')
    await this.command(`/gamemode spectator ${username}`, 100)
    await this.command(`/tp ${username} ${position.x} ${position.y} ${position.z}`, 200)
  }

  private world(relative: Position): Position {
    return {
      x: this.origin.x + relative.x,
      y: this.origin.y + relative.y,
      z: this.origin.z + relative.z,
    }
  }

  private requireBot(): Bot {
    if (!this.bot) throw new MinecraftAdapterError('Minecraft bot is not connected', 'MC_NOT_CONNECTED')
    return this.bot
  }

  private async command(command: string, delay = this.config.commandDelayMs): Promise<void> {
    this.requireBot().chat(command)
    await sleep(delay)
  }

  private async moveBotNear(target: Position): Promise<void> {
    const bot = this.requireBot()
    const destination = new Vec3(target.x + 0.5, target.y, target.z + 0.5)
    bot.creative.startFlying()

    // A single teleport from the flat-world spawn at Y=-60 to the viewer deck
    // at Y=74 is rejected by the server's moved-too-quickly check. Move in small
    // command-driven steps so both server and Mineflayer converge on positive Y.
    for (let step = 0; step < 48; step += 1) {
      const delta = destination.minus(bot.entity.position)
      const distance = Math.sqrt(delta.x ** 2 + delta.y ** 2 + delta.z ** 2)
      if (distance <= 6) break
      const next = bot.entity.position.plus(delta.scaled(6 / distance))
      await this.command(`/tp @s ${next.x.toFixed(3)} ${next.y.toFixed(3)} ${next.z.toFixed(3)}`, 90)
    }
    await this.command(`/tp @s ${destination.x} ${destination.y} ${destination.z}`, 180)
    bot.entity.velocity.set(0, 0, 0)
    bot.emit('move', bot.entity.position.clone())

    if (bot.entity.position.distanceTo(destination) > 2) {
      throw new MinecraftAdapterError(
        `Viewer bot could not reach positive-Y workspace: ${bot.entity.position.toString()}`,
        'MC_VIEWER_POSITION_FAILED',
      )
    }
  }

  async connect(): Promise<MinecraftEnvironment> {
    if (this.bot && this.environment) return { ...this.environment, worldOrigin: { ...this.origin } }
    const bot = mineflayer.createBot({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: 'offline',
    })
    this.bot = bot

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new MinecraftAdapterError('Minecraft spawn timed out', 'MC_CONNECT_TIMEOUT')), 30_000)
      const onSpawn = () => {
        clearTimeout(timeout)
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        clearTimeout(timeout)
        cleanup()
        reject(new MinecraftAdapterError(error.message, 'MC_CONNECT_ERROR'))
      }
      const onKicked = (reason: unknown) => {
        clearTimeout(timeout)
        cleanup()
        reject(new MinecraftAdapterError(`Minecraft bot was kicked: ${String(reason)}`, 'MC_KICKED'))
      }
      const cleanup = () => {
        bot.off('spawn', onSpawn)
        bot.off('error', onError)
        bot.off('kicked', onKicked)
      }
      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('kicked', onKicked)
    })

    // The server can drop the bot later (keep-alive "Timed out"). Without this
    // the adapter would keep the dead bot, report itself connected, and every
    // following build would fail or hang. Forget the bot so the next connect()
    // logs in again.
    bot.on('error', (error) => console.error('Minecraft bot error:', error instanceof Error ? error.message : error))
    bot.once('end', (reason) => {
      if (this.bot !== bot) return
      console.error(`Minecraft bot disconnected (${String(reason)}); it will reconnect on the next Minecraft operation`)
      if (this.viewerPulse) {
        clearInterval(this.viewerPulse)
        this.viewerPulse = undefined
      }
      try {
        (bot as Bot & { viewer?: { close?: () => void } }).viewer?.close?.()
      } catch { /* viewer already gone */ }
      this.bot = undefined
      this.environment = undefined
    })

    if (this.config.viewerEnabled) {
      try {
        const viewer = await import('prismarine-viewer')
        const viewerApi = (viewer.default ?? viewer) as typeof viewer
        const supportedVersions = viewer.supportedVersions ?? viewerApi.supportedVersions
        const renderVersion = closestViewerVersion(bot.version, supportedVersions)
        const viewerBot = createViewerBotBridge(bot, renderVersion)
        viewerApi.mineflayer(viewerBot, { port: this.config.viewerPort, firstPerson: false })
        console.log(`Minecraft Viewer renderer: ${renderVersion} (server: ${bot.version})`)
        // prismarine-viewer sends camera position only on a bot `move` event.
        // Pulse it so clients opened after the build still receive an initial
        // positive-Y camera position and current chunk center.
        this.viewerPulse = setInterval(() => bot.emit('move', bot.entity.position.clone()), 1_000)
        this.viewerPulse.unref()
      } catch (error) {
        throw new MinecraftAdapterError(
          `Minecraft connected, but Viewer failed: ${error instanceof Error ? error.message : String(error)}`,
          'VIEWER_START_FAILED',
          { recoverable: true },
        )
      }
    }

    await this.command('/gamerule doDaylightCycle false')
    await this.command('/gamerule doWeatherCycle false')
    await this.command('/time set day')
    await this.command('/weather clear')
    await this.command('/gamemode creative @s')

    this.environment = {
      adapter: 'live',
      authoritative: true,
      host: this.config.host,
      port: this.config.port,
      version: bot.version,
      worldOrigin: { ...this.origin },
      viewerUrl: this.config.viewerEnabled ? this.config.viewerPublicUrl : undefined,
    }
    return this.environment
  }

  async resetWorkspace(task: TaskSpec): Promise<void> {
    await this.connect()
    const from = this.world({ x: 0, y: 0, z: 0 })
    // /fill cannot prepare an unloaded region. Enter this session's region
    // before issuing commands, then wait for every chunk in the apron.
    await this.moveBotNear({
      x: from.x + Math.floor(task.workspace.size.x / 2),
      y: from.y + 2,
      z: from.z + Math.floor(task.workspace.size.z / 2),
    })
    const minX = from.x - GRASSLAND.horizontalMargin
    const maxX = from.x + task.workspace.size.x - 1 + GRASSLAND.horizontalMargin
    const minZ = from.z - GRASSLAND.horizontalMargin
    const maxZ = from.z + task.workspace.size.z - 1 + GRASSLAND.horizontalMargin
    const surfaceY = from.y + GRASSLAND.surfaceY
    const chunkPositions: Vec3[] = []
    for (let x = Math.floor(minX / 16) * 16; x <= maxX; x += 16) {
      for (let z = Math.floor(minZ / 16) * 16; z <= maxZ; z += 16) {
        chunkPositions.push(new Vec3(Math.max(x, minX), surfaceY, Math.max(z, minZ)))
      }
    }
    const chunksDeadline = Date.now() + 15_000
    while (chunkPositions.some((position) => !this.requireBot().blockAt(position))) {
      if (Date.now() >= chunksDeadline) {
        throw new MinecraftAdapterError('搭建区域尚未加载，未开始铺设地面。请稍后重试。', 'MC_WORKSPACE_NOT_LOADED')
      }
      await sleep(100)
    }
    for (const command of grasslandResetCommands(task, this.origin)) {
      await this.command(command, 500)
    }
    // Command delivery alone is not success: a missing foundation makes
    // redstone dust and repeaters disappear immediately after placement.
    const groundDeadline = Date.now() + 5_000
    while (true) {
      let missing: { position: Position; actual: string } | undefined
      for (let x = minX; x <= maxX && !missing; x += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const position = new Vec3(x, surfaceY, z)
          const block = this.requireBot().blockAt(position)
          if (block?.name !== GRASSLAND.surfaceBlock.replace('minecraft:', '')) {
            missing = { position: { x, y: surfaceY, z }, actual: block?.name ?? 'unreadable' }
            break
          }
        }
      }
      if (!missing) break
      if (Date.now() >= groundDeadline) {
        throw new MinecraftAdapterError('搭建区域地面未铺设完整，已停止搭建，避免红石元件因缺少支撑而掉落。', 'MC_WORKSPACE_GROUND_MISSING', missing)
      }
      await sleep(100)
    }
  }

  async build(
    sessionId: string,
    runId: string,
    task: TaskSpec,
    layout: PhysicalLayout,
    onProgress: (progress: BuildProgress) => Promise<void> | void,
  ): Promise<BuildRun> {
    const environment = await this.connect()
    const startedAt = new Date().toISOString()
    const run: BuildRun = {
      id: runId,
      version: 1,
      sessionId,
      layoutRef: { id: layout.id, version: layout.version },
      environment,
      status: 'running',
      placed: 0,
      total: layout.blocks.length,
      startedAt,
      errors: [],
    }
    const ordered = orderBlocksForBuild(layout.blocks)

    for (const block of ordered) {
      const worldPosition = this.world(block.position)
      try {
        await this.command(`/setblock ${worldPosition.x} ${worldPosition.y} ${worldPosition.z} ${setblockSpec(block)}`)
        const readPosition = new Vec3(worldPosition.x, worldPosition.y, worldPosition.z)
        const expectedName = normalizeBlockName(block.block).replace('minecraft:', '')
        let actual = this.requireBot().blockAt(readPosition)
        // The fixed command delay does not guarantee the block update has reached
        // the bot: the server can log "Changed the block" for a placement that
        // still reads back as air. Keep reading until the update arrives before
        // calling it a mismatch.
        const readBackDeadline = Date.now() + SETBLOCK_READBACK_TIMEOUT_MS
        while ((!actual || actual.name !== expectedName) && Date.now() < readBackDeadline) {
          await sleep(25)
          actual = this.requireBot().blockAt(readPosition)
        }
        if (!actual || actual.name !== expectedName) {
          throw new MinecraftAdapterError(
            `Read-back mismatch for ${block.id}: expected ${expectedName}, got ${actual?.name ?? 'unreadable'}`,
            'SETBLOCK_READBACK_MISMATCH',
          )
        }
        run.placed += 1
        await onProgress({ runId, placed: run.placed, total: run.total, block, worldPosition })
      } catch (error) {
        run.status = 'failed'
        run.finishedAt = new Date().toISOString()
        run.errors.push({
          code: error instanceof MinecraftAdapterError ? error.code : 'SETBLOCK_FAILED',
          message: error instanceof Error ? error.message : String(error),
          details: { blockId: block.id, worldPosition },
          recoverable: false,
        })
        return run
      }
    }
    run.status = 'completed'
    run.finishedAt = new Date().toISOString()
    return run
  }

  async setInputs(task: TaskSpec, values: Record<string, 0 | 1>): Promise<void> {
    const bot = this.requireBot()
    for (const input of task.inputs) {
      const desired = values[input.id] === 1
      const world = this.world(input.port.position)
      let block = bot.blockAt(new Vec3(world.x, world.y, world.z))
      if (!block || block.name !== 'lever') {
        throw new MinecraftAdapterError(`Input ${input.id} is not a readable lever`, 'INPUT_UNREADABLE', { world })
      }
      const current = asBoolean(properties(block).powered)
      if (current !== desired) {
        await this.command(`/tp @s ${world.x} ${world.y} ${world.z + 2}`, 200)
        block = bot.blockAt(new Vec3(world.x, world.y, world.z))
        if (!block) throw new MinecraftAdapterError(`Input ${input.id} disappeared`, 'INPUT_UNREADABLE')
        await bot.activateBlock(block)
        await sleep(this.config.settleMs)
      }
      const after = bot.blockAt(new Vec3(world.x, world.y, world.z))
      if (asBoolean(properties(after).powered) !== desired) {
        throw new MinecraftAdapterError(`Input ${input.id} did not reach ${desired ? 1 : 0}`, 'INPUT_SET_FAILED', { world })
      }
    }
  }

  async triggerUpdate(task: TaskSpec, layout: PhysicalLayout): Promise<void> {
    // Commands that create redstone components can leave their derived power/lit
    // state stale. Touch an empty neighbour of every redstone component with a
    // transient stone block, then restore it to air. This creates a real Minecraft
    // neighbour update without changing any input value or persisted layout block.
    const occupied = new Set(layout.blocks.map((block) => `${block.position.x},${block.position.y},${block.position.z}`))
    const redstoneNames = new Set([
      'redstone_torch',
      'redstone_wall_torch',
      'redstone_wire',
      'redstone_lamp',
      'repeater',
      'comparator',
      'piston',
      'sticky_piston',
    ])
    const offsets: Position[] = [
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: -1, z: 0 },
    ]
    const probes = new Map<string, Position>()

    for (const block of layout.blocks) {
      if (!redstoneNames.has(normalizeBlockName(block.block).replace('minecraft:', ''))) continue
      const probe = offsets
        .map((offset) => ({
          x: block.position.x + offset.x,
          y: block.position.y + offset.y,
          z: block.position.z + offset.z,
        }))
        .find((position) => (
          position.x >= 0 && position.y >= 0 && position.z >= 0
          && position.x < task.workspace.size.x
          && position.y < task.workspace.size.y
          && position.z < task.workspace.size.z
          && !occupied.has(`${position.x},${position.y},${position.z}`)
        ))
      if (probe) probes.set(`${probe.x},${probe.y},${probe.z}`, probe)
    }

    if (probes.size === 0) {
      throw new MinecraftAdapterError('No empty neighbour is available to trigger redstone updates', 'UPDATE_PROBE_UNAVAILABLE')
    }

    for (const relative of probes.values()) {
      const world = this.world(relative)
      await this.command(`/setblock ${world.x} ${world.y} ${world.z} minecraft:stone`, 40)
      await this.command(`/setblock ${world.x} ${world.y} ${world.z} minecraft:air`, 40)
    }
    await sleep(this.config.settleMs)
  }

  async readOutputs(task: TaskSpec, stableReads: number): Promise<Record<string, OutputReading>> {
    const bot = this.requireBot()
    const samples = new Map<string, OutputValue[]>()
    const evidence = new Map<string, EvidenceRef[]>()
    for (const output of task.outputs) {
      samples.set(output.id, [])
      evidence.set(output.id, [])
    }

    for (let sample = 0; sample < stableReads; sample += 1) {
      for (const output of task.outputs) {
        const world = this.world(output.port.position)
        const block = bot.blockAt(new Vec3(world.x, world.y, world.z))
        const state = properties(block)
        const lit = asBoolean(state.lit ?? state.powered)
        samples.get(output.id)?.push(lit === undefined ? 'unreadable' : lit ? 1 : 0)
        evidence.get(output.id)?.push({
          type: 'minecraft-block-read',
          source: `mineflayer:${this.config.host}:${this.config.port}`,
          at: new Date().toISOString(),
          position: world,
          block: block ? normalizeBlockName(block.name) : undefined,
          properties: state,
        })
      }
      if (sample < stableReads - 1) await sleep(Math.max(100, Math.floor(this.config.settleMs / stableReads)))
    }

    return Object.fromEntries(task.outputs.map((output) => {
      const values = samples.get(output.id) ?? []
      const first = values[0] ?? 'unreadable'
      const value: OutputValue = values.every((candidate) => candidate === first) ? first : 'unstable'
      return [output.id, { value, evidence: evidence.get(output.id) ?? [] }]
    }))
  }

  async inspectWorld(_task: TaskSpec, layout: PhysicalLayout): Promise<WorldBlockObservation[]> {
    const bot = this.requireBot()
    const key = (position: Position) => `${position.x},${position.y},${position.z}`
    const layoutByPosition = new Map<string, LayoutBlock[]>()
    for (const block of layout.blocks) {
      const blocks = layoutByPosition.get(key(block.position)) ?? []
      blocks.push(block)
      layoutByPosition.set(key(block.position), blocks)
    }
    const targets = new Map<string, {
      position: Position
      expected: WorldBlockObservation['expected']
    }>()
    const addExpected = (
      position: Position,
      expected: WorldBlockObservation['expected'][number],
    ) => {
      const id = key(position)
      const target = targets.get(id) ?? { position, expected: [] }
      if (!target.expected.some((item) => item.blockId === expected.blockId && item.relation === expected.relation)) {
        target.expected.push(expected)
      }
      targets.set(id, target)
    }

    for (const block of layout.blocks) {
      addExpected(block.position, {
        blockId: block.id,
        block: normalizeBlockName(block.block),
        relation: 'layout',
      })
      const supportPosition = attachmentSupportPosition(block)
      if (!supportPosition) continue
      const explicitSupport = layoutByPosition.get(key(supportPosition))?.[0]
      addExpected(supportPosition, {
        blockId: block.id,
        block: explicitSupport
          ? normalizeBlockName(explicitSupport.block)
          : isGrasslandSurface(supportPosition)
            ? 'minecraft:grass_block'
            : 'minecraft:solid_support',
        relation: 'attachment_support',
      })
    }

    return [...targets.values()].map((target) => {
      const worldPosition = this.world(target.position)
      const actual = bot.blockAt(new Vec3(worldPosition.x, worldPosition.y, worldPosition.z))
      const actualBlock = actual ? normalizeBlockName(actual.name) : undefined
      const matchedExpected = target.expected.every((expected) => (
        expected.block === 'minecraft:solid_support'
          ? Boolean(actualBlock && blockCapability(actualBlock)?.solidSupport)
          : actualBlock === expected.block
      ))
      return {
        position: target.position,
        worldPosition,
        expected: target.expected,
        actualBlock,
        properties: properties(actual),
        matchedExpected,
      }
    })
  }

  async close(): Promise<void> {
    if (this.viewerPulse) {
      clearInterval(this.viewerPulse)
      this.viewerPulse = undefined
    }
    if (this.bot) {
      const viewerBot = this.bot as Bot & { viewer?: { close?: () => void } }
      viewerBot.viewer?.close?.()
      this.bot.quit('mc-ic prototype shutdown')
      this.bot = undefined
      this.environment = undefined
    }
  }
}
