import { describe, expect, it } from 'vitest'
import { taskSpecSchema, type Position, type TaskSpec } from '@domain/domain'
import { GRASSLAND } from '@domain/world-environment'
import { grasslandResetCommands } from './grassland-workspace'

const FILL_BLOCK_LIMIT = 32768

function makeTask(size: { x: number; y: number; z: number }): TaskSpec {
  return taskSpecSchema.parse({
    id: 'task', version: 1, title: 'test', description: 'test',
    inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 0, z: 0 }, facing: 'north' } }],
    outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 2, y: 0, z: 0 }, facing: 'east' } }],
    truthTable: [{ inputs: { A: 0 }, outputs: { Y: 1 } }],
    workspace: { origin: { x: 0, y: 0, z: 0 }, size },
    allowedBlocks: ['minecraft:lever', 'minecraft:redstone_lamp'],
    maxBlocks: 4,
    acceptance: { requireAllCases: true, stableReads: 1 },
  })
}

type Fill = { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; block: string }

function parse(command: string): Fill {
  const m = command.match(/^\/fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (minecraft:\w+)$/)
  if (!m) throw new Error(`unparseable fill: ${command}`)
  const [, x1, y1, z1, x2, y2, z2, block] = m
  return { x1: +x1, y1: +y1, z1: +z1, x2: +x2, y2: +y2, z2: +z2, block }
}

function volume(f: Fill): number {
  return (f.x2 - f.x1 + 1) * (f.y2 - f.y1 + 1) * (f.z2 - f.z1 + 1)
}

function expected(task: TaskSpec, origin: Position) {
  const minX = origin.x - GRASSLAND.horizontalMargin
  const maxX = origin.x + task.workspace.size.x - 1 + GRASSLAND.horizontalMargin
  const minZ = origin.z - GRASSLAND.horizontalMargin
  const maxZ = origin.z + task.workspace.size.z - 1 + GRASSLAND.horizontalMargin
  const surfaceY = origin.y + GRASSLAND.surfaceY
  const bottomY = surfaceY - GRASSLAND.subsurfaceDepth
  const clearTopY = Math.max(origin.y + task.workspace.size.y - 1, surfaceY + GRASSLAND.apronClearHeight)
  const apronArea = (maxX - minX + 1) * (maxZ - minZ + 1)
  return { minX, maxX, minZ, maxZ, surfaceY, bottomY, clearTopY, apronArea }
}

describe('grasslandResetCommands', () => {
  for (const size of [{ x: 3, y: 2, z: 2 }, { x: 25, y: 8, z: 25 }, { x: 9, y: 40, z: 9 }]) {
    it(`builds a seamless flat apron for a ${size.x}x${size.y}x${size.z} workspace`, () => {
      const task = makeTask(size)
      const origin: Position = { x: 10, y: 72, z: 20 }
      const e = expected(task, origin)
      const fills = grasslandResetCommands(task, origin).map(parse)

      // No command may exceed Minecraft's /fill block limit.
      for (const f of fills) expect(volume(f)).toBeLessThanOrEqual(FILL_BLOCK_LIMIT)

      // Every fill stays inside the apron footprint.
      for (const f of fills) {
        expect(f.x1).toBeGreaterThanOrEqual(e.minX)
        expect(f.x2).toBeLessThanOrEqual(e.maxX)
        expect(f.z1).toBeGreaterThanOrEqual(e.minZ)
        expect(f.z2).toBeLessThanOrEqual(e.maxZ)
      }

      const byBlock = (block: string) => fills.filter((f) => f.block === block)
      const total = (block: string) => byBlock(block).reduce((sum, f) => sum + volume(f), 0)

      // Grass covers exactly the apron surface layer at y = surfaceY.
      for (const f of byBlock('minecraft:grass_block')) expect(f.y1 === e.surfaceY && f.y2 === e.surfaceY).toBe(true)
      expect(total('minecraft:grass_block')).toBe(e.apronArea)

      // Dirt fills the two layers just below the surface.
      for (const f of byBlock('minecraft:dirt')) {
        expect(f.y1).toBeGreaterThanOrEqual(e.bottomY)
        expect(f.y2).toBeLessThanOrEqual(e.surfaceY - 1)
      }
      expect(total('minecraft:dirt')).toBe(e.apronArea * GRASSLAND.subsurfaceDepth)

      // Air is cleared from just above the surface up to clearTopY across the
      // whole apron (this is what shaves surrounding terrain to grass level).
      for (const f of byBlock('minecraft:air')) {
        expect(f.y1).toBeGreaterThanOrEqual(e.surfaceY + 1)
        expect(f.y2).toBeLessThanOrEqual(e.clearTopY)
      }
      expect(total('minecraft:air')).toBe(e.apronArea * (e.clearTopY - e.surfaceY))
    })
  }

  it('shaves surrounding terrain well above a short workspace (apronClearHeight)', () => {
    const e = expected(makeTask({ x: 3, y: 2, z: 2 }), { x: 0, y: 72, z: 0 })
    // A 2-tall workspace would only clear to y=73, but the apron clears higher
    // so nearby terrain/leftover cannot form walls around the circuit.
    expect(e.clearTopY).toBe(e.surfaceY + GRASSLAND.apronClearHeight)
  })
})
