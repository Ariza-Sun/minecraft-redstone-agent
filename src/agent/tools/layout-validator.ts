import {
  normalizeBlockName,
  positionKey,
  type LayoutBlock,
  type LayoutSimulationSummary,
  type LayoutValidationIssue,
  type LayoutValidationResult,
  type LogicDesign,
  type PhysicalLayout,
  type Position,
  type TaskSpec,
} from '@domain/domain'
import { acceptsBlockProperty, blockCapability } from '@domain/block-capabilities'
import { attachmentSupportPosition } from '@domain/layout-physics'
import { isGrasslandSurface } from '@domain/world-environment'
import { simulateTruthTable } from './redstone-simulator'

function manhattan(left: Position, right: Position): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.z - right.z)
}

/**
 * Issue codes produced by the truth-table simulation rather than by structural
 * checks. A candidate that is structurally clean but functionally wrong must
 * still rank above one with unresolved structural issues.
 */
export const FUNCTIONAL_ISSUE_CODES: ReadonlySet<string> = new Set(['SIMULATED_CASE_MISMATCH'])

/**
 * Structural issues that make the layout physically ambiguous (blocks that
 * would pop off, collide, or fail to place). The simulation waits for these to
 * be fixed because its result would not describe what Minecraft builds.
 */
const SIMULATION_BLOCKING_CODES = new Set([
  'DUPLICATE_BLOCK_ID',
  'DUPLICATE_POSITION',
  'MISSING_SUPPORT',
  'INVALID_SUPPORT_BLOCK',
  'INVALID_BLOCKSTATE',
  'UNKNOWN_BLOCKSTATE',
  'INVALID_INPUT_PORT',
  'INVALID_OUTPUT_PORT',
  'INPUT_PORT_NOT_EXCLUSIVE',
  'OUTPUT_PORT_NOT_EXCLUSIVE',
])

/**
 * Positional approximations of redstone physics. They are useful hints while
 * structural problems still prevent the simulation from running, but once the
 * exact truth-table simulation passes they are by definition wrong about the
 * physics and must not block a working circuit.
 */
const PHYSICS_HEURISTIC_CODES = new Set([
  'OUTPUT_SIGNAL_DISCONNECTED',
  'INVERTER_INPUT_DISCONNECTED',
  'INPUT_BYPASSES_LOGIC',
])

type RankableLayoutValidation = Pick<LayoutValidationResult, 'issues'>
  & Partial<Pick<LayoutValidationResult, 'simulation'>>

export function issueCounts(result: RankableLayoutValidation): {
  structural: number
  functional: number
  outputMismatches: number
} {
  let functional = 0
  for (const issue of result.issues) if (FUNCTIONAL_ISSUE_CODES.has(issue.code)) functional += 1
  const outputMismatches = result.simulation?.evaluated
    ? result.simulation.cases.reduce((total, item) => total + Object.entries(item.expected)
        .filter(([outputId, expected]) => item.actual[outputId] !== expected).length, 0)
    : functional
  return { structural: result.issues.length - functional, functional, outputMismatches }
}

/**
 * Orders two validation results: fewer structural issues first, then fewer
 * incorrect output bits, then fewer failing truth-table rows. Output-bit
 * granularity lets a multi-output repair improve one output without being
 * discarded merely because the number of wholly passing rows stayed flat.
 * Negative means `left` is better.
 */
export function compareLayoutValidations(
  left: RankableLayoutValidation,
  right: RankableLayoutValidation,
): number {
  const a = issueCounts(left)
  const b = issueCounts(right)
  return a.structural - b.structural
    || a.outputMismatches - b.outputMismatches
    || a.functional - b.functional
}

const SIDE_OF_FACING: Record<string, string> = {
  north: 'south (z+1)',
  south: 'north (z-1)',
  east: 'west (x-1)',
  west: 'east (x+1)',
}

const OPPOSITE_FACING: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' }

const HORIZONTAL_NEIGHBOURS: Array<{ side: string; dx: number; dz: number; facingToHang: string }> = [
  { side: 'north', dx: 0, dz: -1, facingToHang: 'south' },
  { side: 'south', dx: 0, dz: 1, facingToHang: 'north' },
  { side: 'east', dx: 1, dz: 0, facingToHang: 'west' },
  { side: 'west', dx: -1, dz: 0, facingToHang: 'east' },
]

/**
 * Wall-mounted components hang on the horizontal neighbour *behind* them, so
 * `facing=west` means the attachment block lies to the east. Models routinely
 * assume the support is below or on the side they face, so spell out what each
 * horizontal neighbour currently holds and which facing would hang on it, plus
 * the floor-mounted alternative when they really want a block underneath.
 */
function facingHint(block: LayoutBlock, support: Position, byPosition: Map<string, LayoutBlock>, bounds: PhysicalLayout['bounds']): string {
  const name = normalizeBlockName(block.block)
  const wallMounted = name === 'minecraft:redstone_wall_torch'
    || (name === 'minecraft:lever' && String(block.properties.face ?? 'wall') === 'wall')
  if (!wallMounted) return ''
  const facing = String(block.properties.facing ?? 'north')
  const mirrored = {
    x: 2 * block.position.x - support.x,
    y: 2 * block.position.y - support.y,
    z: 2 * block.position.z - support.z,
  }
  const mirror = byPosition.get(positionKey(mirrored))
  let text = ` Note: facing=${facing} means this component faces ${facing} and hangs on the block on its ${SIDE_OF_FACING[facing] ?? 'opposite'} side; the block below it is irrelevant for a wall mount.`
  if (mirror && blockCapability(normalizeBlockName(mirror.block))?.solidSupport) {
    text += ` The solid block ${mirror.id} at ${positionKey(mirrored)} is on the opposite side; if that is the intended wall, use facing=${OPPOSITE_FACING[facing] ?? facing}.`
  }
  const options = HORIZONTAL_NEIGHBOURS.map(({ side, dx, dz, facingToHang }) => {
    const position = { x: block.position.x + dx, y: block.position.y, z: block.position.z + dz }
    const inside = position.x >= 0 && position.z >= 0 && position.x < bounds.x && position.z < bounds.z
    const occupant = byPosition.get(positionKey(position))
    const solid = occupant ? blockCapability(normalizeBlockName(occupant.block))?.solidSupport : false
    const content = !inside ? 'outside bounds' : occupant ? `${occupant.id} (${normalizeBlockName(occupant.block).replace('minecraft:', '')}${solid ? ', solid' : ', not solid'})` : 'air'
    return `${side} ${positionKey(position)} = ${content} -> facing=${facingToHang}`
  })
  text += ` Horizontal neighbours of ${block.id} and the facing that would hang on each: ${options.join('; ')}.`
  const floorAlternative = name === 'minecraft:lever'
    ? `use face=floor with a solid block directly below at ${positionKey({ ...block.position, y: block.position.y - 1 })}`
    : `use minecraft:redstone_torch (floor torch) standing on a solid block directly below at ${positionKey({ ...block.position, y: block.position.y - 1 })}`
  text += ` If you want it to stand on a block instead, ${floorAlternative}.`
  return text
}

export class DeterministicLayoutValidator {
  constructor(private readonly options: { simulate: boolean } = { simulate: true }) {}

  async validate(task: TaskSpec, design: LogicDesign, layout: PhysicalLayout): Promise<LayoutValidationResult> {
    const issues: LayoutValidationIssue[] = []
    const allowed = new Set(task.allowedBlocks.map(normalizeBlockName))
    const allowedSupportBlocks = [...allowed]
      .filter((name) => blockCapability(name)?.solidSupport)
      .sort()
    // Suggest a plain opaque block for missing supports, never a lamp or piston.
    const preferredSupport = ['minecraft:stone', 'minecraft:smooth_stone', 'minecraft:polished_andesite', 'minecraft:iron_block']
      .find((name) => allowed.has(name))
    const logicIds = new Set([...design.nodes.map((node) => node.id), ...design.edges.map((edge) => edge.id)])
    const mapped = new Set<string>()
    const occupied = new Map<string, string>()
    const blocksByPosition = new Map<string, PhysicalLayout['blocks']>()
    const blockIds = new Set<string>()

    if (layout.logicDesignRef.id !== design.id || layout.logicDesignRef.version !== design.version) {
      issues.push({ code: 'STALE_LOGIC_REF', message: 'PhysicalLayout does not reference the active LogicDesign version' })
    }
    if (layout.bounds.x > task.workspace.size.x || layout.bounds.y > task.workspace.size.y || layout.bounds.z > task.workspace.size.z) {
      issues.push({ code: 'BOUNDS_EXCEED_WORKSPACE', message: 'Layout bounds exceed the TaskSpec workspace' })
    }
    // The block budget is guidance, not a hard constraint: the model may pick
    // its own maxBlocks, and rejecting a functionally correct circuit for one
    // block over a self-chosen budget helps nobody. The model still sees the
    // budget in its prompt; exceeding it does not fail validation.

    for (const block of layout.blocks) {
      const name = normalizeBlockName(block.block)
      const key = positionKey(block.position)
      if (blockIds.has(block.id)) {
        issues.push({ code: 'DUPLICATE_BLOCK_ID', message: `Duplicate block id ${block.id}`, blockId: block.id })
      }
      blockIds.add(block.id)
      if (occupied.has(key)) {
        const portOwner = [...task.inputs, ...task.outputs].find((item) => positionKey(item.port.position) === key)
        const keep = portOwner
          ? `only the ${task.inputs.includes(portOwner) ? 'lever' : 'lamp'} for port ${portOwner.id} may stay here`
          : 'keep exactly one of them here'
        issues.push({
          code: 'DUPLICATE_POSITION',
          message: `${block.id} overlaps ${occupied.get(key)} at ${key}; ${keep} and move or remove the other block to a different coordinate (removeBlockIds or a new position in upsertBlocks)`,
          blockId: block.id,
          position: block.position,
        })
      }
      occupied.set(key, block.id)
      const colocated = blocksByPosition.get(key) ?? []
      colocated.push(block)
      blocksByPosition.set(key, colocated)

      if (
        block.position.x < 0 || block.position.x >= layout.bounds.x ||
        block.position.y < 0 || block.position.y >= layout.bounds.y ||
        block.position.z < 0 || block.position.z >= layout.bounds.z
      ) {
        issues.push({ code: 'OUT_OF_BOUNDS', message: `${block.id} is outside layout bounds`, blockId: block.id, position: block.position })
      }
      if (!allowed.has(name)) {
        issues.push({ code: 'BLOCK_NOT_ALLOWED', message: `${name} is not in TaskSpec.allowedBlocks`, blockId: block.id })
      }

      const rules = blockCapability(name)?.properties
      for (const [property, value] of Object.entries(block.properties)) {
        if (!rules?.[property]) {
          issues.push({ code: 'UNKNOWN_BLOCKSTATE', message: `${name} does not allow property ${property}`, blockId: block.id })
        } else if (!acceptsBlockProperty(rules[property], value)) {
          issues.push({ code: 'INVALID_BLOCKSTATE', message: `Invalid ${name}[${property}=${String(value)}]`, blockId: block.id })
        }
      }
      for (const implemented of block.implements) {
        if (!logicIds.has(implemented)) {
          issues.push({ code: 'UNKNOWN_LOGIC_MAPPING', message: `${block.id} implements unknown id ${implemented}`, blockId: block.id })
        } else {
          mapped.add(implemented)
        }
      }
    }

    for (const id of logicIds) {
      if (!mapped.has(id)) {
        const node = design.nodes.find((item) => item.id === id)
        const edge = design.edges.find((item) => item.id === id)
        const what = node
          ? node.kind === 'input' ? 'its lever' : node.kind === 'output' ? 'its lamp' : `the block(s) that physically realize the ${node.kind.toUpperCase()} gate (its torch, or the merge wire for an OR)`
          : edge ? `the wires and blocks that carry the signal from ${edge.from} to ${edge.to}` : 'the blocks that realize it'
        issues.push({
          code: 'UNMAPPED_LOGIC_ID',
          message: `Logic ${node ? 'node' : 'edge'} ${id} has no physical block mapping; add "${id}" to the implements array of ${what} (an existing block may implement several IDs)`,
        })
      }
    }

    const byPosition = new Map(layout.blocks.map((block) => [positionKey(block.position), block]))
    for (const input of task.inputs) {
      const key = positionKey(input.port.position)
      const portBlocks = blocksByPosition.get(key) ?? []
      const block = byPosition.get(key)
      if (portBlocks.length !== 1) {
        issues.push({
          code: 'INPUT_PORT_NOT_EXCLUSIVE',
          message: `Input ${input.id} fixed port ${key} is exclusive and must contain exactly one lever; found ${portBlocks.length} blocks: ${portBlocks.map((item) => item.id).join(', ') || '(none)'}`,
          position: input.port.position,
        })
      }
      if (!block || normalizeBlockName(block.block) !== 'minecraft:lever' || !block.implements.includes(input.id)) {
        issues.push({
          code: 'INVALID_INPUT_PORT',
          message: `Input ${input.id} must map to a lever at its fixed port`,
          position: input.port.position,
        })
      }
    }
    for (const output of task.outputs) {
      const key = positionKey(output.port.position)
      const portBlocks = blocksByPosition.get(key) ?? []
      const block = byPosition.get(key)
      if (portBlocks.length !== 1) {
        issues.push({
          code: 'OUTPUT_PORT_NOT_EXCLUSIVE',
          message: `Output ${output.id} fixed port ${key} is exclusive and must contain exactly one redstone lamp; found ${portBlocks.length} blocks: ${portBlocks.map((item) => item.id).join(', ') || '(none)'}`,
          position: output.port.position,
        })
      }
      if (!block || normalizeBlockName(block.block) !== 'minecraft:redstone_lamp' || !block.implements.includes(output.id)) {
        issues.push({
          code: 'INVALID_OUTPUT_PORT',
          message: `Output ${output.id} must map to a redstone lamp at its fixed port`,
          position: output.port.position,
        })
      }
    }

    // A fixed output must have a separate, adjacent block carrying the edge
    // that drives it. This catches layouts that map a lamp but never deliver a
    // signal to it, and makes the required correction explicit to the agent.
    for (const output of task.outputs) {
      const outputNode = design.nodes.find((node) => node.id === output.id)
      const incomingEdgeIds = design.edges
        .filter((edge) => edge.to === outputNode?.id)
        .map((edge) => edge.id)
      const lamp = (blocksByPosition.get(positionKey(output.port.position)) ?? [])
        .find((block) => normalizeBlockName(block.block) === 'minecraft:redstone_lamp' && block.implements.includes(output.id))
      if (!lamp || incomingEdgeIds.length === 0) continue
      const delivery = layout.blocks.find((block) =>
        block.id !== lamp.id
        && manhattan(block.position, lamp.position) === 1
        && block.implements.some((id) => incomingEdgeIds.includes(id)))
      if (!delivery) {
        issues.push({
          code: 'OUTPUT_SIGNAL_DISCONNECTED',
          message: `Output ${output.id} lamp at ${positionKey(lamp.position)} needs a distinct adjacent power-delivery block implementing one of [${incomingEdgeIds.join(', ')}]`,
          blockId: lamp.id,
          position: lamp.position,
        })
      }
    }

    // A floor or wall torch used as a NOT gate only inverts power applied to
    // its attachment block, so that block must carry the incoming edge in the
    // logic mapping. Whether the input really powers it is decided by the
    // truth-table simulation below, not by a positional heuristic.
    for (const inverter of design.nodes.filter((node) => node.kind === 'not')) {
      const incomingEdgeIds = design.edges.filter((edge) => edge.to === inverter.id).map((edge) => edge.id)
      const torches = layout.blocks.filter((block) =>
        block.implements.includes(inverter.id)
        && ['minecraft:redstone_torch', 'minecraft:redstone_wall_torch'].includes(normalizeBlockName(block.block)))
      for (const torch of torches) {
        const supportPosition = attachmentSupportPosition(torch)
        if (!supportPosition || incomingEdgeIds.length === 0) continue
        const support = byPosition.get(positionKey(supportPosition))
        if (support && !support.implements.some((id) => incomingEdgeIds.includes(id))) {
          issues.push({
            code: 'INVERTER_INPUT_DISCONNECTED',
            message: `NOT ${inverter.id} torch ${torch.id} only reacts to its attachment block ${support.id} at ${positionKey(supportPosition)}; that block must implement an incoming edge [${incomingEdgeIds.join(', ')}] and be driven by the input`,
            blockId: torch.id,
            position: supportPosition,
          })
        }
      }
    }

    // If any truth-table row requires input=1 and output=0, a lever (or the
    // block it directly powers) adjacent to the lamp is an unconditional
    // bypass around the intended logic and makes that row impossible.
    for (const input of task.inputs) {
      const lever = (blocksByPosition.get(positionKey(input.port.position)) ?? [])
        .find((block) => normalizeBlockName(block.block) === 'minecraft:lever' && block.implements.includes(input.id))
      if (!lever) continue
      const leverSupport = attachmentSupportPosition(lever)
      for (const output of task.outputs) {
        const hasRequiredLowCase = task.truthTable.some((row) => row.inputs[input.id] === 1 && row.outputs[output.id] === 0)
        if (!hasRequiredLowCase) continue
        const lamp = (blocksByPosition.get(positionKey(output.port.position)) ?? [])
          .find((block) => normalizeBlockName(block.block) === 'minecraft:redstone_lamp' && block.implements.includes(output.id))
        if (!lamp) continue
        const bypassPosition = [lever.position, leverSupport]
          .filter((candidate): candidate is Position => Boolean(candidate))
          .find((candidate) => manhattan(candidate, lamp.position) === 1)
        if (bypassPosition) {
          issues.push({
            code: 'INPUT_BYPASSES_LOGIC',
            message: `Input ${input.id}=1 must allow output ${output.id}=0, but its lever or directly powered attachment at ${positionKey(bypassPosition)} is adjacent to lamp ${lamp.id}; move the logic route away from the fixed output`,
            blockId: lever.id,
            position: bypassPosition,
          })
        }
      }
    }

    for (const block of layout.blocks) {
      const supportPosition = attachmentSupportPosition(block)
      if (!supportPosition) continue
      const support = byPosition.get(positionKey(supportPosition))
      if (!support && isGrasslandSurface(supportPosition)) continue
      const position = positionKey(supportPosition)
      const allowedDescription = allowedSupportBlocks.length > 0 ? allowedSupportBlocks.join(', ') : '(none)'
      const supportName = support ? normalizeBlockName(support.block) : 'minecraft:air'
      if (!support || supportName === 'minecraft:air') {
        const inside = supportPosition.x >= 0 && supportPosition.y >= 0 && supportPosition.z >= 0
          && supportPosition.x < layout.bounds.x && supportPosition.y < layout.bounds.y && supportPosition.z < layout.bounds.z
        const hint = facingHint(block, supportPosition, byPosition, layout.bounds)
        const fix = inside && preferredSupport && !hint.includes('opposite side')
          ? ` Simplest fix: upsert a new ${preferredSupport} block at ${position} (that coordinate is free), or move ${block.id} onto an existing solid block.`
          : !inside ? ` That coordinate is outside the layout bounds, so ${block.id} must move or face the other way.` : ''
        issues.push({
          code: 'MISSING_SUPPORT',
          message: `${block.id} requires a solid support block at ${position}; found minecraft:air (no block); allowed support blocks for this TaskSpec: ${allowedDescription}.${hint}${fix}`,
          blockId: block.id,
          position: supportPosition,
          actualBlock: 'minecraft:air',
          allowedSupportBlocks,
        })
        continue
      }
      if (!blockCapability(supportName)?.solidSupport) {
        issues.push({
          code: 'INVALID_SUPPORT_BLOCK',
          message: `${block.id} requires a solid support block at ${position}; found ${supportName}; allowed support blocks for this TaskSpec: ${allowedDescription}.${facingHint(block, supportPosition, byPosition, layout.bounds)}`,
          blockId: block.id,
          position: supportPosition,
          actualBlock: supportName,
          allowedSupportBlocks,
        })
      }
    }

    const simulation = this.options.simulate ? this.simulate(task, layout, issues) : undefined
    const functionallyVerified = simulation?.evaluated === true && simulation.passedCases === simulation.totalCases
    const finalIssues = functionallyVerified
      ? issues.filter((issue) => !PHYSICS_HEURISTIC_CODES.has(issue.code))
      : issues

    return {
      passed: finalIssues.length === 0,
      issues: finalIssues,
      stats: {
        blocks: layout.blocks.length,
        phases: new Set(layout.blocks.map((block) => block.phase ?? 0)).size,
        mappedLogicIds: mapped.size,
      },
      ...(simulation ? { simulation } : {}),
    }
  }

  /**
   * Runs the full truth table through the deterministic redstone model and
   * turns every failing row into one SIMULATED_CASE_MISMATCH issue with a local
   * explanation. Circuit-wide observations ride along on the first failing row
   * so the agent sees systematic causes (constant torches, dead wires, bypasses)
   * once instead of per case.
   */
  private simulate(task: TaskSpec, layout: PhysicalLayout, issues: LayoutValidationIssue[]): LayoutSimulationSummary {
    const blocking = [...new Set(issues.filter((issue) => SIMULATION_BLOCKING_CODES.has(issue.code)).map((issue) => issue.code))]
    if (blocking.length > 0) {
      return {
        evaluated: false,
        reason: `Truth-table simulation waits until these structural issues are fixed: ${blocking.join(', ')}`,
        passedCases: 0,
        totalCases: task.truthTable.length,
        cases: [],
        observations: [],
      }
    }
    const report = simulateTruthTable(task, layout)
    if (!report.evaluated) {
      return {
        evaluated: false,
        reason: report.reason,
        passedCases: 0,
        totalCases: task.truthTable.length,
        cases: [],
        observations: [],
      }
    }
    let observationsAttached = false
    for (const item of report.cases) {
      if (item.passed) continue
      const inputs = Object.entries(item.inputs).map(([id, value]) => `${id}=${value}`).join(',')
      const expected = Object.entries(item.expected).map(([id, value]) => `${id}=${value}`).join(',')
      const actual = Object.entries(item.actual).map(([id, value]) => `${id}=${value}`).join(',')
      const observations = !observationsAttached && report.observations.length > 0
        ? ` Circuit-wide observations: ${report.observations.join(' ')}`
        : ''
      observationsAttached = true
      issues.push({
        code: 'SIMULATED_CASE_MISMATCH',
        message: `Truth-table row ${item.index} (${inputs}) would give ${actual} in Minecraft but must give ${expected}. ${item.mismatches.join(' ')}${observations}`,
      })
    }
    return {
      evaluated: true,
      passedCases: report.passedCases,
      totalCases: report.totalCases,
      cases: report.cases.map(({ index, inputs, expected, actual, passed, states, mismatches }) => ({
        index,
        inputs,
        expected,
        actual,
        passed,
        states,
        mismatches,
      })),
      observations: report.observations,
    }
  }
}
