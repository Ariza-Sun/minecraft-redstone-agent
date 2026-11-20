import { normalizeBlockName, positionKey, type PhysicalLayout, type TaskSpec } from '@domain/domain'
import { attachmentSupportPosition } from '@domain/layout-physics'

const ARROW: Record<string, string> = { north: '^', south: 'v', east: '>', west: '<' }

function symbol(block: PhysicalLayout['blocks'][number]): string {
  const name = normalizeBlockName(block.block)
  const facing = ARROW[String(block.properties.facing ?? '')] ?? '?'
  switch (name) {
    case 'minecraft:stone':
    case 'minecraft:smooth_stone':
    case 'minecraft:polished_andesite':
    case 'minecraft:iron_block':
      return '##'
    case 'minecraft:glass': return 'GL'
    case 'minecraft:redstone_block': return 'RB'
    case 'minecraft:piston':
    case 'minecraft:sticky_piston':
      return 'PS'
    case 'minecraft:redstone_lamp': return 'LP'
    case 'minecraft:redstone_wire': return '~~'
    case 'minecraft:redstone_torch': return 't|'
    case 'minecraft:redstone_wall_torch': return `t${facing}`
    case 'minecraft:lever': {
      const face = String(block.properties.face ?? 'wall')
      return face === 'floor' ? 'l_' : face === 'ceiling' ? 'l=' : `l${facing}`
    }
    case 'minecraft:repeater': return `r${facing}`
    case 'minecraft:comparator': return `c${facing}`
    default: return '??'
  }
}

/**
 * Top-down grid per Y layer so the agent can see adjacency, collisions and
 * empty support coordinates at a glance instead of reconstructing them from a
 * list of coordinates. Purely a projection of the layout; nothing is inferred.
 */
export function renderLayoutMap(layout: PhysicalLayout, task: TaskSpec): string {
  const byPosition = new Map<string, PhysicalLayout['blocks']>()
  for (const block of layout.blocks) {
    const key = positionKey(block.position)
    byPosition.set(key, [...(byPosition.get(key) ?? []), block])
  }
  const ports = new Map<string, string>()
  for (const input of task.inputs) ports.set(positionKey(input.port.position), `IN ${input.id}`)
  for (const output of task.outputs) ports.set(positionKey(output.port.position), `OUT ${output.id}`)
  const missingSupports = new Map<string, string[]>()
  for (const block of layout.blocks) {
    const support = attachmentSupportPosition(block)
    if (!support || support.y < 0 || byPosition.has(positionKey(support))) continue
    missingSupports.set(positionKey(support), [...(missingSupports.get(positionKey(support)) ?? []), block.id])
  }

  const lines: string[] = []
  lines.push(`Top-down map of the current layout, one grid per Y layer (bounds ${layout.bounds.x}x${layout.bounds.y}x${layout.bounds.z}). Rows are z (north = smaller z, top row), columns are x (east = larger x, right). Cell codes: ## solid block, LP lamp, ~~ wire, l_ floor lever, l^/lv/l>/l< wall lever facing north/south/east/west (it hangs on the block behind it), t| floor torch, t^/tv/t>/t< wall torch facing that way (hangs on the opposite side), r>/c> repeater/comparator with input on the arrow side, .. air, !! two blocks on one coordinate, __ empty coordinate that some component needs as support, P? fixed port without the required block.`)
  const emptyLayers: number[] = []
  for (let y = 0; y < layout.bounds.y; y += 1) {
    const layerBlocks = layout.blocks.filter((block) => block.position.y === y)
    const layerHasMarks = [...missingSupports.keys(), ...ports.keys()].some((key) => Number(key.split(',')[1]) === y)
    if (layerBlocks.length === 0 && !layerHasMarks) {
      emptyLayers.push(y)
      continue
    }
    const rows: string[] = [`y=${y}  x: ${Array.from({ length: layout.bounds.x }, (_, x) => String(x).padStart(2)).join(' ')}`]
    for (let z = 0; z < layout.bounds.z; z += 1) {
      const cells: string[] = []
      for (let x = 0; x < layout.bounds.x; x += 1) {
        const key = positionKey({ x, y, z })
        const here = byPosition.get(key) ?? []
        if (here.length > 1) cells.push('!!')
        else if (here.length === 1) cells.push(symbol(here[0]))
        else if (missingSupports.has(key)) cells.push('__')
        else if (ports.has(key)) cells.push('P?')
        else cells.push('..')
      }
      rows.push(`   z=${String(z).padStart(2)}  ${cells.join(' ')}`)
    }
    const ids = layerBlocks
      .sort((a, b) => a.position.z - b.position.z || a.position.x - b.position.x)
      .map((block) => `${block.id}@${block.position.x},${block.position.z}`)
    if (ids.length > 0) rows.push(`   ids: ${ids.join('  ')}`)
    lines.push(rows.join('\n'))
  }
  if (emptyLayers.length > 0) lines.push(`Layers with no blocks: y=${emptyLayers.join(', ')}`)
  const outside = layout.blocks.filter((block) =>
    block.position.x < 0 || block.position.y < 0 || block.position.z < 0
    || block.position.x >= layout.bounds.x || block.position.y >= layout.bounds.y || block.position.z >= layout.bounds.z)
  if (outside.length > 0) lines.push(`Outside bounds (not drawn): ${outside.map((block) => `${block.id}@${positionKey(block.position)}`).join(', ')}`)
  const missing = [...missingSupports.entries()].map(([key, ids]) => `${key} (needed by ${ids.join(', ')})`)
  if (missing.length > 0) lines.push(`Empty support coordinates (__): ${missing.join('; ')}`)
  const unfilledPorts = [...ports.entries()].filter(([key]) => !byPosition.has(key)).map(([key, label]) => `${label} at ${key}`)
  if (unfilledPorts.length > 0) lines.push(`Fixed ports without a block (P?): ${unfilledPorts.join('; ')}`)
  return lines.join('\n')
}
