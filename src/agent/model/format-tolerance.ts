import { normalizeBlockName, type AgentAction, type LayoutBlock } from '@domain/domain'
import type { ModelContext } from './model-adapter'

// Local-patch budget for repair_layout, enforced by layoutPreflightErrors and
// echoed in the repair-stage instruction (see openrouter-adapter stageInstruction).
export const MAX_LAYOUT_REPAIR_UPSERTS = 32
export const MAX_LAYOUT_REPAIR_REMOVALS = 48
export const MAX_LAYOUT_REPAIR_CHANGES = 64

type LooseBlock = { id?: unknown; position?: { x?: unknown; y?: unknown; z?: unknown }; implements?: unknown }

function looseKey(position: LooseBlock['position']): string | undefined {
  if (!position || typeof position !== 'object') return undefined
  const { x, y, z } = position
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? `${x},${y},${z}` : undefined
}

/**
 * Plain support blocks are often emitted with `implements: []`. The contract
 * wants every block tagged, so borrow the tags of the component it carries
 * (the block directly above) or, failing that, of any face-adjacent tagged
 * block. Blocks with no tagged neighbour stay empty and are rejected as before.
 */
function fillEmptyImplements(blocks: LooseBlock[], neighbours: LooseBlock[], notes: string[]): void {
  const tagged = new Map<string, unknown[]>()
  for (const block of [...neighbours, ...blocks]) {
    const key = looseKey(block.position)
    if (key && Array.isArray(block.implements) && block.implements.length > 0) tagged.set(key, block.implements)
  }
  const filled: string[] = []
  for (const block of blocks) {
    if (!Array.isArray(block.implements) || block.implements.length > 0) continue
    const position = block.position
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') continue
    const candidates = [
      { x: position.x, y: position.y + 1, z: position.z },
      { x: position.x + 1, y: position.y, z: position.z },
      { x: position.x - 1, y: position.y, z: position.z },
      { x: position.x, y: position.y, z: position.z + 1 },
      { x: position.x, y: position.y, z: position.z - 1 },
      { x: position.x, y: position.y - 1, z: position.z },
    ]
    const source = candidates.map((candidate) => tagged.get(`${candidate.x},${candidate.y},${candidate.z}`)).find(Boolean)
    if (!source) continue
    block.implements = [...source]
    if (typeof block.id === 'string') filled.push(block.id)
  }
  if (filled.length > 0) notes.push(`Filled empty implements from the adjacent component for: ${filled.join(', ')}`)
}

function normalizeTaskSpec(candidate: Record<string, unknown>, notes: string[]): void {
  const taskSpec = candidate.taskSpec
  if (!taskSpec || typeof taskSpec !== 'object') return
  const record = taskSpec as Record<string, unknown>
  for (const field of ['inputs', 'outputs'] as const) {
    if (!Array.isArray(record[field])) continue
    for (const item of record[field] as Array<{ id?: unknown }>) {
      if (item && typeof item === 'object' && typeof item.id === 'number') {
        item.id = String(item.id)
        notes.push(`Coerced numeric ${field} id ${item.id} to a string`)
      }
    }
  }
  if (Array.isArray(record.truthTable)) {
    let coerced = 0
    for (const row of record.truthTable as Array<Record<string, unknown>>) {
      if (!row || typeof row !== 'object') continue
      for (const side of ['inputs', 'outputs'] as const) {
        const values = row[side]
        if (!values || typeof values !== 'object') continue
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
          const bit = value === true || value === '1' || value === 'true' ? 1 : value === false || value === '0' || value === 'false' ? 0 : undefined
          if (bit !== undefined) {
            (values as Record<string, unknown>)[key] = bit
            coerced += 1
          }
        }
      }
    }
    if (coerced > 0) notes.push(`Coerced ${coerced} truth-table values from boolean/string to 0|1`)
  }
}

export function normalizeStringArrays(value: unknown, notes: string[], baseLayout?: { blocks: LooseBlock[] }): unknown {
  if (!value || typeof value !== 'object') return value
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'propose_task_spec') {
    normalizeTaskSpec(candidate, notes)
    return value
  }
  if (!['propose_layout', 'repair_layout', 'propose_logic_design'].includes(String(candidate.type))) return value
  const artifactKey = candidate.type === 'propose_layout'
    ? 'layout'
    : candidate.type === 'repair_layout'
      ? 'patch'
      : 'design'
  const artifact = candidate[artifactKey]
  if (!artifact || typeof artifact !== 'object') return value
  const record = artifact as Record<string, unknown>
  if (candidate.type === 'propose_layout' && Array.isArray(record.blocks)) {
    fillEmptyImplements(record.blocks as LooseBlock[], [], notes)
  }
  if (candidate.type === 'repair_layout' && Array.isArray(record.upsertBlocks)) {
    fillEmptyImplements(record.upsertBlocks as LooseBlock[], baseLayout?.blocks ?? [], notes)
  }
  // "Remove then re-add" is how models express a replacement; an upsert alone
  // already replaces the block, so keep the upsert and drop the redundant removal.
  if (candidate.type === 'repair_layout' && Array.isArray(record.upsertBlocks) && Array.isArray(record.removeBlockIds)) {
    const upsertIds = new Set(record.upsertBlocks
      .map((block) => (block && typeof block === 'object' ? (block as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string'))
    const redundant = record.removeBlockIds.filter((id) => typeof id === 'string' && upsertIds.has(id))
    if (redundant.length > 0) {
      record.removeBlockIds = record.removeBlockIds.filter((id) => !(typeof id === 'string' && upsertIds.has(id)))
      notes.push(`Dropped removeBlockIds also present in upsertBlocks (upsert already replaces them): ${redundant.join(', ')}`)
    }
  }
  const changeSummary = record.changeSummary
  if (!changeSummary || typeof changeSummary !== 'object') return value
  const summary = changeSummary as Record<string, unknown>
  for (const field of ['changed', 'impact'] as const) {
    if (typeof summary[field] === 'string') {
      summary[field] = [summary[field]]
      notes.push(`Normalized changeSummary.${field} from string to one-item array`)
    }
  }
  return value
}

/**
 * Reject coordinate collisions before they consume a controller layout
 * version. JSON Schema cannot express uniqueness across x/y/z, and repair
 * models commonly forget to remove the old occupant when inserting a new
 * component at its coordinate.
 */
export function layoutPreflightErrors(action: AgentAction, context: ModelContext): string[] {
  if (context.stage !== 'layout') return []
  if (action.type !== 'propose_layout' && action.type !== 'repair_layout') return []

  let blocks: LayoutBlock[]
  if (action.type === 'propose_layout') {
    blocks = action.layout.blocks
  } else {
    const base = context.artifacts.physicalLayout
    if (!base) return ['repair_layout requires artifacts.physicalLayout']
    if (action.patch.baseVersion !== base.version) {
      return [`patch.baseVersion ${action.patch.baseVersion} does not match current layout v${base.version}`]
    }
    const baseIds = new Set(base.blocks.map((block) => block.id))
    const unknownRemovals = action.patch.removeBlockIds.filter((id) => !baseIds.has(id))
    if (unknownRemovals.length > 0) {
      return [`removeBlockIds contains unknown block IDs: ${unknownRemovals.join(', ')}`]
    }
    if (
      action.patch.upsertBlocks.length > MAX_LAYOUT_REPAIR_UPSERTS
      || action.patch.removeBlockIds.length > MAX_LAYOUT_REPAIR_REMOVALS
      || action.patch.upsertBlocks.length + action.patch.removeBlockIds.length > MAX_LAYOUT_REPAIR_CHANGES
    ) {
      return [
        `repair patch is too large (${action.patch.upsertBlocks.length} upserts + ${action.patch.removeBlockIds.length} removals); limits are ${MAX_LAYOUT_REPAIR_UPSERTS}, ${MAX_LAYOUT_REPAIR_REMOVALS}, and ${MAX_LAYOUT_REPAIR_CHANGES} combined`,
      ]
    }
    const removed = new Set(action.patch.removeBlockIds)
    const upserts = new Map(action.patch.upsertBlocks.map((block) => [block.id, block]))
    blocks = base.blocks
      .filter((block) => !removed.has(block.id))
      .map((block) => upserts.get(block.id) ?? block)
    const materializedIds = new Set(blocks.map((block) => block.id))
    for (const block of action.patch.upsertBlocks) {
      if (!materializedIds.has(block.id)) {
        blocks.push(block)
        materializedIds.add(block.id)
      }
    }
  }

  const occupied = new Map<string, string>()
  const errors: string[] = []
  for (const block of blocks) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    const previous = occupied.get(key)
    if (previous) {
      errors.push(`${block.id} overlaps ${previous} at ${key}`)
    } else {
      occupied.set(key, block.id)
    }
  }
  return errors.slice(0, 12)
}

const MERGEABLE_COLOCATED_BLOCKS = new Set([
  'minecraft:redstone_wire',
  'minecraft:stone',
  'minecraft:smooth_stone',
  'minecraft:polished_andesite',
  'minecraft:iron_block',
])

const SIGNAL_COMPONENT_BLOCKS = new Set([
  'minecraft:lever',
  'minecraft:redstone_lamp',
  'minecraft:redstone_torch',
  'minecraft:redstone_wall_torch',
  'minecraft:repeater',
  'minecraft:comparator',
])

function isReplaceablePassive(block: LayoutBlock): boolean {
  return MERGEABLE_COLOCATED_BLOCKS.has(normalizeBlockName(block.block))
}

function isWire(block: LayoutBlock): boolean {
  return normalizeBlockName(block.block) === 'minecraft:redstone_wire'
}

function isSignalComponent(block: LayoutBlock): boolean {
  return SIGNAL_COMPONENT_BLOCKS.has(normalizeBlockName(block.block))
}

/**
 * A repair model often expresses "put this component where that routing wire
 * was" as a coordinate upsert and omits the wire ID from removeBlockIds. That
 * intent is unambiguous when the resident is an unchanged routing wire or
 * neutral support and the upsert is a signal component; a new neutral input
 * block replacing an old wire is likewise an ordinary coordinate replacement.
 * Structural validation still catches a support that should not have been
 * replaced. Component/component and passive-on-component collisions remain
 * strict.
 */
export function normalizeRepairWireReplacements(action: AgentAction, context: ModelContext): string[] {
  if (action.type !== 'repair_layout') return []
  const base = context.artifacts.physicalLayout
  if (!base) return []

  const notes: string[] = []
  const removed = new Set(action.patch.removeBlockIds)
  const upsertIds = new Set(action.patch.upsertBlocks.map((block) => block.id))
  const unchangedPassiveByCoordinate = new Map<string, LayoutBlock>()
  for (const block of base.blocks) {
    if (removed.has(block.id) || upsertIds.has(block.id)) continue
    if (!isReplaceablePassive(block)) continue
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    unchangedPassiveByCoordinate.set(key, block)
  }

  for (const block of action.patch.upsertBlocks) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    const resident = unchangedPassiveByCoordinate.get(key)
    if (!resident || removed.has(resident.id)) continue
    const incomingName = normalizeBlockName(block.block)
    const residentName = normalizeBlockName(resident.block)
    const componentReplacement = isSignalComponent(block)
    const solidReplacingWire = residentName === 'minecraft:redstone_wire'
      && incomingName !== 'minecraft:redstone_wire'
      && isReplaceablePassive(block)
    if (!componentReplacement && !solidReplacingWire) continue
    removed.add(resident.id)
    block.implements = [...new Set([...resident.implements, ...block.implements])]
    notes.push(`Replaced resident passive block ${resident.id} with ${block.id} at ${key}`)
  }

  action.patch.removeBlockIds = [...removed]
  return notes
}

/** A model may describe a repeater/torch coordinate twice: as the physical
 * component and as a symbolic wire/support. When exactly one signal component
 * occupies the group, merge passive mappings into that component. During
 * repair the component must itself be upserted; an attempted new passive block
 * on top of an unchanged component remains an error. */
export function mergeComponentWireCollocations(action: AgentAction, context: ModelContext): string[] {
  if (action.type !== 'propose_layout' && action.type !== 'repair_layout') return []
  const notes: string[] = []

  if (action.type === 'propose_layout') {
    const groups = new Map<string, LayoutBlock[]>()
    for (const block of action.layout.blocks) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      groups.set(key, [...(groups.get(key) ?? []), block])
    }
    const mergedWireIds = new Set<string>()
    for (const [key, group] of groups) {
      const components = group.filter(isSignalComponent)
      const passives = group.filter(isReplaceablePassive)
      const neutralSolids = group.filter((block) => isReplaceablePassive(block) && !isWire(block))
      const wires = group.filter(isWire)
      const dominant = components.length === 1 && passives.length > 0 && components.length + passives.length === group.length
        ? components[0]
        : components.length === 0 && neutralSolids.length === 1 && wires.length > 0 && neutralSolids.length + wires.length === group.length
          ? neutralSolids[0]
          : undefined
      if (!dominant) continue
      const merged = group.filter((block) => block.id !== dominant.id)
      dominant.implements = [...new Set([...dominant.implements, ...merged.flatMap((block) => block.implements)])]
      for (const passive of merged) {
        mergedWireIds.add(passive.id)
        notes.push(`Merged symbolic passive block ${passive.id} into ${dominant.id} at ${key}`)
      }
    }
    action.layout.blocks = action.layout.blocks.filter((block) => !mergedWireIds.has(block.id))
    return notes
  }

  const base = context.artifacts.physicalLayout
  if (!base) return notes
  const removed = new Set(action.patch.removeBlockIds)
  const upserts = new Map(action.patch.upsertBlocks.map((block) => [block.id, block]))
  const materialized = base.blocks
    .filter((block) => !removed.has(block.id))
    .map((block) => upserts.get(block.id) ?? block)
  const materializedIds = new Set(materialized.map((block) => block.id))
  for (const block of action.patch.upsertBlocks) {
    if (!materializedIds.has(block.id)) materialized.push(block)
  }
  const groups = new Map<string, LayoutBlock[]>()
  for (const block of materialized) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    groups.set(key, [...(groups.get(key) ?? []), block])
  }
  for (const [key, group] of groups) {
    const components = group.filter(isSignalComponent)
    const passives = group.filter(isReplaceablePassive)
    const neutralSolids = group.filter((block) => isReplaceablePassive(block) && !isWire(block))
    const wires = group.filter(isWire)
    const dominant = components.length === 1 && passives.length > 0 && components.length + passives.length === group.length
      ? components[0]
      : components.length === 0 && neutralSolids.length === 1 && wires.length > 0 && neutralSolids.length + wires.length === group.length
        ? neutralSolids[0]
        : undefined
    if (!dominant || !upserts.has(dominant.id)) continue
    const component = { ...dominant, implements: [...dominant.implements] }
    const merged = group.filter((block) => block.id !== dominant.id)
    component.implements = [...new Set([...component.implements, ...merged.flatMap((block) => block.implements)])]
    for (const passive of merged) {
      upserts.delete(passive.id)
      if (base.blocks.some((block) => block.id === passive.id)) removed.add(passive.id)
      notes.push(`Merged symbolic passive block ${passive.id} into ${component.id} at ${key}`)
    }
    upserts.set(component.id, component)
  }
  action.patch.upsertBlocks = [...upserts.values()]
  action.patch.removeBlockIds = [...removed]
  return notes
}

function mergeableAtSameCoordinate(left: LayoutBlock, right: LayoutBlock): boolean {
  const name = normalizeBlockName(left.block)
  return normalizeBlockName(right.block) === name
    && MERGEABLE_COLOCATED_BLOCKS.has(name)
    && JSON.stringify(left.properties) === JSON.stringify(right.properties)
    && (left.phase ?? 0) === (right.phase ?? 0)
}

/** Two symbolic wire/support entries at one coordinate describe one physical
 * block. Merge their logic mappings instead of spending a regeneration merely
 * to discover what Minecraft's last-write-wins placement would mean. Active
 * components remain strict because merging two torches/repeaters is ambiguous. */
export function mergeCompatibleLayoutBlocks(action: AgentAction, context: ModelContext): string[] {
  if (action.type !== 'propose_layout' && action.type !== 'repair_layout') return []
  const notes: string[] = []

  if (action.type === 'propose_layout') {
    const blocks: LayoutBlock[] = []
    const occupied = new Map<string, LayoutBlock>()
    for (const block of action.layout.blocks) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      const previous = occupied.get(key)
      if (previous && mergeableAtSameCoordinate(previous, block)) {
        previous.implements = [...new Set([...previous.implements, ...block.implements])]
        notes.push(`Merged co-located ${normalizeBlockName(block.block)} ${block.id} into ${previous.id} at ${key}`)
        continue
      }
      blocks.push(block)
      if (!previous) occupied.set(key, block)
    }
    action.layout.blocks = blocks
    return notes
  }

  const base = context.artifacts.physicalLayout
  if (!base) return notes
  const baseById = new Map(base.blocks.map((block) => [block.id, block]))
  const removed = new Set(action.patch.removeBlockIds)
  const upserts = new Map(action.patch.upsertBlocks.map((block) => [block.id, block]))
  const materialized = base.blocks
    .filter((block) => !removed.has(block.id))
    .map((block) => upserts.get(block.id) ?? block)
  const materializedIds = new Set(materialized.map((block) => block.id))
  for (const block of action.patch.upsertBlocks) {
    if (!materializedIds.has(block.id)) materialized.push(block)
  }
  const groups = new Map<string, LayoutBlock[]>()
  for (const block of materialized) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    groups.set(key, [...(groups.get(key) ?? []), block])
  }
  for (const [key, group] of groups) {
    if (group.length < 2 || !group.every((block) => mergeableAtSameCoordinate(group[0], block))) continue
    // Prefer the block that already physically occupied this coordinate so a
    // new symbolic route does not needlessly rename a stable artifact block.
    const keeper = group.find((block) => {
      const previous = baseById.get(block.id)
      return previous
        && `${previous.position.x},${previous.position.y},${previous.position.z}` === key
    }) ?? group[0]
    const merged: LayoutBlock = {
      ...keeper,
      implements: [...new Set(group.flatMap((block) => block.implements))],
    }
    for (const block of group) {
      if (block.id === keeper.id) continue
      upserts.delete(block.id)
      if (baseById.has(block.id)) removed.add(block.id)
      notes.push(`Merged co-located ${normalizeBlockName(block.block)} ${block.id} into ${keeper.id} at ${key}`)
    }
    removed.delete(keeper.id)
    upserts.set(keeper.id, merged)
  }
  action.patch.upsertBlocks = [...upserts.values()]
  action.patch.removeBlockIds = [...removed]
  return notes
}
