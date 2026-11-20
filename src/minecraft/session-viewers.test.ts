import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '@platform/config'
import type { TaskSpec } from '@domain/domain'
import { SessionViewerManager } from './session-viewers'

describe('session-scoped Minecraft viewer streams', () => {
  it('shares only same-session initialization and keeps different observers on separate ports', async () => {
    const factory = vi.fn(async (id: string) => ({ port: id === 'a' ? 41001 : 41002, close: vi.fn(async () => {}) }))
    const manager = new SessionViewerManager({} as AppConfig['minecraft'], () => ({
      view: { available: true, origin: { x: 0, y: 72, z: 0 } }, task: {} as TaskSpec,
    }), factory)
    expect(await Promise.all([manager.ensure('a'), manager.ensure('a'), manager.ensure('b')])).toEqual([41001, 41001, 41002])
    expect(factory).toHaveBeenCalledTimes(2)
    expect(manager.port('a')).toBe(41001)
    expect(manager.port('b')).toBe(41002)
    await manager.close()
    expect(manager.port('a')).toBeUndefined()
  })

  it('keeps at most maxViewers observers by logging out the least recently used one', async () => {
    let clock = 0
    const closed: string[] = []
    const factory = vi.fn(async (id: string) => ({ port: 41000 + id.charCodeAt(0), close: vi.fn(async () => { closed.push(id) }) }))
    const manager = new SessionViewerManager({} as AppConfig['minecraft'], () => ({
      view: { available: true, origin: { x: 0, y: 72, z: 0 } }, task: {} as TaskSpec,
    }), factory, undefined, { maxViewers: 2, now: () => clock })
    clock = 1; await manager.ensure('a')
    clock = 2; await manager.ensure('b')
    clock = 3; await manager.ensure('a') // a is now more recent than b
    clock = 4; await manager.ensure('c')
    expect(closed).toEqual(['b'])
    expect(manager.port('b')).toBeUndefined()
    expect(manager.port('a')).toBeDefined()
    expect(manager.port('c')).toBeDefined()
    clock = 5; await manager.ensure('b') // a returning page simply reconnects
    expect(closed).toEqual(['b', 'a'])
    expect(factory).toHaveBeenCalledTimes(4)
    await manager.close()
  })

  it('logs out observers idle for longer than idleMs and keeps recently used ones', async () => {
    let clock = 0
    const closed: string[] = []
    const factory = vi.fn(async (id: string) => ({ port: 41000 + id.charCodeAt(0), close: vi.fn(async () => { closed.push(id) }) }))
    const manager = new SessionViewerManager({} as AppConfig['minecraft'], () => ({
      view: { available: true, origin: { x: 0, y: 72, z: 0 } }, task: {} as TaskSpec,
    }), factory, undefined, { idleMs: 100, now: () => clock })
    await manager.ensure('a')
    clock = 60; await manager.ensure('b')
    clock = 150; await manager.sweep()
    expect(closed).toEqual(['a'])
    expect(manager.port('a')).toBeUndefined()
    expect(manager.port('b')).toBeDefined()
    await manager.close()
    expect(closed).toEqual(['a', 'b'])
  })

  it('blocks overwritten legacy circuits and can retry a failed observer without touching the world', async () => {
    let available = false
    const factory = vi.fn().mockRejectedValueOnce(new Error('connection failed'))
      .mockResolvedValue({ port: 41001, close: async () => {} })
    const manager = new SessionViewerManager({} as AppConfig['minecraft'], () => ({
      view: { available, origin: { x: 0, y: 72, z: 0 }, reason: 'overwritten' }, task: {} as TaskSpec,
    }), factory)
    await expect(manager.ensure('a')).rejects.toMatchObject({ message: 'overwritten' })
    expect(factory).not.toHaveBeenCalled()
    available = true
    await expect(manager.ensure('a')).rejects.toThrow('connection failed')
    expect(await manager.ensure('a')).toBe(41001)
    await manager.close()
  })
})
