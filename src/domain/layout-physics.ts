import {
  normalizeBlockName,
  positionKey,
  type LayoutBlock,
  type Position,
} from './domain'

export function attachmentSupportPosition(block: LayoutBlock): Position | undefined {
  const { x, y, z } = block.position
  const name = normalizeBlockName(block.block)
  if (['minecraft:redstone_wire', 'minecraft:redstone_torch', 'minecraft:repeater', 'minecraft:comparator'].includes(name)) {
    return { x, y: y - 1, z }
  }
  if (name === 'minecraft:lever') {
    const face = String(block.properties.face ?? 'wall')
    if (face === 'floor') return { x, y: y - 1, z }
    if (face === 'ceiling') return { x, y: y + 1, z }
  }
  if (name !== 'minecraft:lever' && name !== 'minecraft:redstone_wall_torch') return undefined
  const facing = String(block.properties.facing ?? 'north')
  if (facing === 'north') return { x, y, z: z + 1 }
  if (facing === 'south') return { x, y, z: z - 1 }
  if (facing === 'east') return { x: x - 1, y, z }
  if (facing === 'west') return { x: x + 1, y, z }
  return undefined
}

/**
 * Produce a stable, support-safe construction order. Explicit phases remain a
 * priority among blocks that are currently placeable, but a mounted block can
 * never be emitted before the layout block it depends on.
 */
export function orderBlocksForBuild(blocks: LayoutBlock[]): LayoutBlock[] {
  const indexed = blocks.map((block, index) => ({ block, index }))
  const byPosition = new Map(indexed.map((item) => [positionKey(item.block.position), item]))
  const dependents = new Map<number, number[]>()
  const indegree = indexed.map(() => 0)

  for (const item of indexed) {
    const supportPosition = attachmentSupportPosition(item.block)
    if (!supportPosition) continue
    const support = byPosition.get(positionKey(supportPosition))
    if (!support || support.index === item.index) continue
    const targets = dependents.get(support.index) ?? []
    targets.push(item.index)
    dependents.set(support.index, targets)
    indegree[item.index] += 1
  }

  const priority = (left: typeof indexed[number], right: typeof indexed[number]) =>
    (left.block.phase ?? 0) - (right.block.phase ?? 0) || left.index - right.index
  const ready = indexed.filter((item) => indegree[item.index] === 0).sort(priority)
  const ordered: LayoutBlock[] = []

  while (ready.length > 0) {
    const item = ready.shift()!
    ordered.push(item.block)
    for (const dependentIndex of dependents.get(item.index) ?? []) {
      indegree[dependentIndex] -= 1
      if (indegree[dependentIndex] === 0) {
        ready.push(indexed[dependentIndex])
        ready.sort(priority)
      }
    }
  }

  // A valid layout cannot contain an attachment cycle because supports must be
  // solid, but retain deterministic behavior if this helper is used directly.
  if (ordered.length !== blocks.length) {
    const emitted = new Set(ordered)
    ordered.push(...indexed.filter((item) => !emitted.has(item.block)).sort(priority).map((item) => item.block))
  }
  return ordered
}
