import { describe, expect, it } from 'vitest'
import type { LayoutBlock } from './domain'
import { orderBlocksForBuild } from './layout-physics'

function block(
  id: string,
  name: string,
  position: { x: number; y: number; z: number },
  phase?: number,
): LayoutBlock {
  return { id, block: name, position, properties: {}, implements: ['e1'], phase }
}

describe('orderBlocksForBuild', () => {
  it('places an explicit support before its attached component', () => {
    const wire = block('wire', 'minecraft:redstone_wire', { x: 2, y: 1, z: 0 })
    const lamp = block('lamp', 'minecraft:redstone_lamp', { x: 2, y: 0, z: 0 })

    expect(orderBlocksForBuild([wire, lamp]).map((item) => item.id)).toEqual(['lamp', 'wire'])
  })

  it('lets physical support dependencies override a contradictory phase', () => {
    const torch = block('torch', 'minecraft:redstone_torch', { x: 1, y: 1, z: 0 }, 0)
    const base = block('base', 'minecraft:iron_block', { x: 1, y: 0, z: 0 }, 2)

    expect(orderBlocksForBuild([torch, base]).map((item) => item.id)).toEqual(['base', 'torch'])
  })
})
