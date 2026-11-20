import { describe, expect, it } from 'vitest'
import { allocateSessionWorkspace, workspacesOverlap } from './session-workspace'
import { grasslandResetCommands } from '@minecraft/grassland-workspace'
import type { TaskSpec } from './domain'

describe('Minecraft session workspace isolation', () => {
  it('reserves disjoint clearing aprons even for large tasks and previously occupied legacy regions', () => {
    const base = { x: 0, y: 72, z: 0 }
    const legacy = { origin: base, size: { x: 32, y: 12, z: 32 } }
    const first = allocateSessionWorkspace(base, { x: 256, y: 32, z: 64 }, [legacy])
    const second = allocateSessionWorkspace(base, { x: 48, y: 16, z: 48 }, [legacy, first])
    expect(workspacesOverlap(legacy, first)).toBe(false)
    expect(workspacesOverlap(first, second)).toBe(false)
    const commands = grasslandResetCommands({ workspace: { size: second.size } } as TaskSpec, second.origin)
    for (const command of commands) {
      const [, x1, , , x2] = command.split(' ')
      expect(Number(x1)).toBeGreaterThan(first.origin.x + first.size.x + 16)
      expect(Number(x2)).toBeGreaterThan(first.origin.x + first.size.x + 16)
    }
  })

  it('detects legacy collisions and refuses allocations beyond the world border', () => {
    const region = { origin: { x: 0, y: 72, z: 0 }, size: { x: 32, y: 8, z: 32 } }
    expect(workspacesOverlap(region, { ...region, origin: { ...region.origin, x: 40 } })).toBe(true)
    expect(() => allocateSessionWorkspace({ x: 29_999_980, y: 72, z: 0 }, region.size, [])).toThrow('world boundary')
  })
})
