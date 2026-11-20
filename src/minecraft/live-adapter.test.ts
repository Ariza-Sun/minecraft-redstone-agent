import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Vec3 } from 'vec3'
import mineflayer from 'mineflayer'
import type { AppConfig } from '@platform/config'
import type { TaskSpec } from '@domain/domain'
import { LiveMinecraftAdapter } from './live-adapter'

vi.mock('mineflayer', () => ({ default: { createBot: vi.fn() } }))

// Simulate server commands being ignored outside loaded chunks and a ground
// fill failing even though delivery of the chat command itself succeeds.
function setup(options: { neverLoads?: boolean; missingGround?: boolean } = {}) {
  const bot = Object.assign(new EventEmitter(), {
    version: '1.20.4',
    entity: { position: new Vec3(733, 74, 0), velocity: new Vec3(0, 0, 0) },
    creative: { startFlying: vi.fn() },
    chat: vi.fn(),
    blockAt: vi.fn(),
  })
  let loaded = false
  const ground = new Set<string>()
  bot.chat.mockImplementation((command: string) => {
    const parts = command.split(' ')
    if (parts[0] === '/tp') {
      bot.entity.position = new Vec3(+parts[2], +parts[3], +parts[4])
      if (!options.neverLoads) setTimeout(() => { loaded = true }, 300)
    }
    if (parts[0] === '/fill') {
      // This assertion reproduces the original bug if preparation runs first.
      expect(loaded).toBe(true)
      if (options.missingGround || parts[7] !== 'minecraft:grass_block') return
      for (let x = +parts[1]; x <= +parts[4]; x++) {
        for (let z = +parts[3]; z <= +parts[6]; z++) ground.add(`${x},${parts[2]},${z}`)
      }
    }
  })
  bot.blockAt.mockImplementation((pos: Vec3) => loaded
    ? { name: ground.has(`${pos.x},${pos.y},${pos.z}`) ? 'grass_block' : 'air' }
    : null)
  vi.mocked(mineflayer.createBot).mockImplementation(() => {
    setTimeout(() => bot.emit('spawn'), 0)
    return bot as unknown as ReturnType<typeof mineflayer.createBot>
  })
  const adapter = new LiveMinecraftAdapter({
    origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, viewerEnabled: false,
  } as AppConfig['minecraft'])
  adapter.selectWorkspace({ x: 733, y: 72, z: 0 })
  const task = { workspace: { size: { x: 19, y: 6, z: 17 } } } as TaskSpec
  return { adapter, task, bot }
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('live workspace preparation', () => {
  it('enters the session region and waits for chunks before preparing and checking all ground', async () => {
    vi.useFakeTimers()
    const { adapter, task, bot } = setup()
    const result = adapter.resetWorkspace(task)
    await vi.runAllTimersAsync()
    await result
    expect(bot.blockAt).toHaveBeenCalledWith(new Vec3(733, 71, 3))
    expect(bot.blockAt).toHaveBeenCalledWith(new Vec3(767, 71, 32))
    expect(bot.chat.mock.calls.some(([command]) => command.startsWith('/fill '))).toBe(true)
  })

  it('does not issue fill commands when the destination chunks never load', async () => {
    vi.useFakeTimers()
    const { adapter, task, bot } = setup({ neverLoads: true })
    const result = expect(adapter.resetWorkspace(task)).rejects.toMatchObject({ code: 'MC_WORKSPACE_NOT_LOADED' })
    await vi.runAllTimersAsync()
    await result
    expect(bot.chat.mock.calls.some(([command]) => command.startsWith('/fill '))).toBe(false)
  })

  it('rejects silently failed ground preparation before any circuit can be built', async () => {
    vi.useFakeTimers()
    const { adapter, task } = setup({ missingGround: true })
    const result = expect(adapter.resetWorkspace(task)).rejects.toMatchObject({
      code: 'MC_WORKSPACE_GROUND_MISSING',
      details: { position: { x: 717, y: 71, z: -16 }, actual: 'air' },
    })
    await vi.runAllTimersAsync()
    await result
  })
})
