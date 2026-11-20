import {
  normalizeBlockName,
  positionKey,
  type Binary,
  type OutputValue,
  type PhysicalLayout,
  type Position,
  type TaskSpec,
} from '@domain/domain'
import { orderBlocksForBuild } from '@domain/layout-physics'
import { GRASSLAND } from '@domain/world-environment'
import {
  DIRECTIONS,
  HORIZONTAL,
  OPPOSITE,
  CLOCKWISE,
  shift,
  SUPPORTED_BLOCKS,
  AIR,
  GRASS,
  DIRT,
  toCell,
  isSignalSource,
  canWireSurviveOn,
  leverConnectedDirection,
  attachment,
  type Dir,
  type HorizontalDir,
  type CellKind,
  type Cell,
} from './redstone-primitives'

/**
 * Deterministic steady-state model of Minecraft Java 1.20 redstone for the
 * block catalog used by mc-ic. It follows the vanilla signal rules
 * (Level.getSignal / getDirectSignal, RedStoneWireBlock connection and
 * strength rules, torch, lever, repeater, comparator and lamp behaviour) so a
 * PhysicalLayout can be checked against the full truth table before anything
 * is written to the real world. Minecraft remains the final authority; this
 * only reports which rows would fail and why.
 */

type SimulationState = {
  leverOn: Map<string, boolean>
  torchLit: Map<string, boolean>
  wirePower: Map<string, number>
  repeaterPowered: Map<string, boolean>
  repeaterLocked: Set<string>
  comparatorOutput: Map<string, number>
  /** Torches that toggled themselves so often that vanilla burns them out; they stay OFF. */
  burnedOut: Set<string>
  torchToggles: Map<string, number>
}

// Vanilla burns a redstone torch out after more than 8 toggles within 60 game
// ticks; a self-feeding loop toggles every couple of ticks, so this is reached
// long before the settle window ends.
const BURNOUT_TOGGLES = 8

export type SimulatedCase = {
  index: number
  inputs: Record<string, Binary>
  expected: Record<string, Binary>
  actual: Record<string, OutputValue>
  passed: boolean
  converged: boolean
  /** One compact line per active component describing its steady state. */
  states: string[]
  /** Local explanation for every output whose simulated value is wrong. */
  mismatches: string[]
}

export type SimulationReport = {
  evaluated: boolean
  reason?: string
  cases: SimulatedCase[]
  passedCases: number
  totalCases: number
  passed: boolean
  /** Case-independent facts about the circuit that explain systematic failures. */
  observations: string[]
}

const MAX_SETTLE_PASSES = 64
const MAX_TICKS = 64

class RedstoneWorld {
  private readonly cells = new Map<string, Cell>()
  readonly components: Array<{ position: Position; cell: Cell }> = []

  constructor(layout: PhysicalLayout) {
    // Later /setblock writes overwrite earlier ones, so a duplicated coordinate
    // ends up holding whichever block the builder places last.
    for (const block of orderBlocksForBuild(layout.blocks)) {
      this.cells.set(positionKey(block.position), toCell(block))
    }
    for (const [key, cell] of this.cells) {
      const [x, y, z] = key.split(',').map(Number)
      this.components.push({ position: { x, y, z }, cell })
    }
  }

  at(position: Position): Cell {
    const cell = this.cells.get(positionKey(position))
    if (cell) return cell
    if (position.y === GRASSLAND.surfaceY) return GRASS
    if (position.y < GRASSLAND.surfaceY && position.y >= GRASSLAND.surfaceY - GRASSLAND.subsurfaceDepth) return DIRT
    return AIR
  }

  label(position: Position): string {
    const cell = this.at(position)
    const name = cell.name.replace('minecraft:', '')
    return cell.block ? `${cell.block.id}@${positionKey(position)}` : `${name}@${positionKey(position)}`
  }

  ofKind(...kinds: CellKind[]): Array<{ position: Position; cell: Cell }> {
    return this.components.filter((item) => kinds.includes(item.cell.kind))
  }
}

class CaseSimulation {
  readonly state: SimulationState

  constructor(
    private readonly world: RedstoneWorld,
    leverOn: Map<string, boolean>,
  ) {
    this.state = {
      leverOn,
      torchLit: new Map(this.world.ofKind('torch', 'wall_torch').map((item) => [positionKey(item.position), true])),
      wirePower: new Map(this.world.ofKind('wire').map((item) => [positionKey(item.position), 0])),
      repeaterPowered: new Map(this.world.ofKind('repeater').map((item) => [positionKey(item.position), false])),
      repeaterLocked: new Set(),
      comparatorOutput: new Map(this.world.ofKind('comparator').map((item) => [positionKey(item.position), 0])),
      burnedOut: new Set(),
      torchToggles: new Map(),
    }
  }

  private wirePowerAt(position: Position): number {
    return this.world.at(position).kind === 'wire' ? this.state.wirePower.get(positionKey(position)) ?? 0 : 0
  }

  torchLit(position: Position): boolean {
    return this.state.torchLit.get(positionKey(position)) ?? false
  }

  /** Signal a block emits toward a neighbour; `direction` points from that neighbour to the block. */
  ownSignal(position: Position, cell: Cell, direction: Dir, wiresActive: boolean): number {
    switch (cell.kind) {
      case 'redstone_block':
        return 15
      case 'lever':
        return this.state.leverOn.get(positionKey(position)) ? 15 : 0
      case 'torch':
        return this.torchLit(position) && direction !== 'up' ? 15 : 0
      case 'wall_torch':
        return this.torchLit(position) && direction !== cell.facing ? 15 : 0
      case 'wire': {
        if (!wiresActive || direction === 'down') return 0
        const power = this.state.wirePower.get(positionKey(position)) ?? 0
        if (power === 0) return 0
        if (direction === 'up') return power
        return this.wireShape(position, cell)[OPPOSITE[direction] as HorizontalDir] ? power : 0
      }
      case 'repeater':
        return this.state.repeaterPowered.get(positionKey(position)) && cell.facing === direction ? 15 : 0
      case 'comparator': {
        const output = this.state.comparatorOutput.get(positionKey(position)) ?? 0
        return output > 0 && cell.facing === direction ? output : 0
      }
      default:
        return 0
    }
  }

  /** Strong ("direct") signal a block feeds into a neighbouring solid block. */
  directSignal(position: Position, cell: Cell, direction: Dir, wiresActive: boolean): number {
    switch (cell.kind) {
      case 'lever':
        return this.state.leverOn.get(positionKey(position)) && leverConnectedDirection(cell) === direction ? 15 : 0
      case 'torch':
      case 'wall_torch':
        return direction === 'down' ? this.ownSignal(position, cell, direction, wiresActive) : 0
      case 'wire':
        return wiresActive ? this.ownSignal(position, cell, direction, wiresActive) : 0
      case 'repeater':
      case 'comparator':
        return this.ownSignal(position, cell, direction, wiresActive)
      default:
        return 0
    }
  }

  directSignalTo(position: Position, wiresActive: boolean): number {
    let best = 0
    for (const direction of DIRECTIONS) {
      const neighbour = shift(position, direction)
      best = Math.max(best, this.directSignal(neighbour, this.world.at(neighbour), direction, wiresActive))
    }
    return best
  }

  /** Level.getSignal: what the block at `position` offers to the asker on its `direction` side. */
  signal(position: Position, direction: Dir, wiresActive: boolean): number {
    const cell = this.world.at(position)
    const own = this.ownSignal(position, cell, direction, wiresActive)
    return cell.kind === 'conductor' ? Math.max(own, this.directSignalTo(position, wiresActive)) : own
  }

  bestNeighbourSignal(position: Position, wiresActive: boolean): number {
    let best = 0
    for (const direction of DIRECTIONS) {
      best = Math.max(best, this.signal(shift(position, direction), direction, wiresActive))
    }
    return best
  }

  private shouldConnectTo(cell: Cell, direction: Dir | null): boolean {
    if (cell.kind === 'wire') return true
    if (cell.kind === 'repeater') return direction !== null && (cell.facing === direction || OPPOSITE[cell.facing] === direction)
    return isSignalSource(cell) && direction !== null
  }

  private connectingSide(position: Position, direction: HorizontalDir): boolean {
    const neighbourPosition = shift(position, direction)
    const neighbour = this.world.at(neighbourPosition)
    const nonConductorAbove = this.world.at(shift(position, 'up')).kind !== 'conductor'
    if (nonConductorAbove && canWireSurviveOn(neighbour) && this.shouldConnectTo(this.world.at(shift(neighbourPosition, 'up')), null)) {
      return true
    }
    if (this.shouldConnectTo(neighbour, direction)) return true
    return neighbour.kind !== 'conductor' && this.shouldConnectTo(this.world.at(shift(neighbourPosition, 'down')), null)
  }

  /** RedStoneWireBlock.getConnectionState: the sides this wire visibly points to. */
  wireShape(position: Position, cell: Cell): Record<HorizontalDir, boolean> {
    const shape = {
      north: this.connectingSide(position, 'north'),
      south: this.connectingSide(position, 'south'),
      east: this.connectingSide(position, 'east'),
      west: this.connectingSide(position, 'west'),
    }
    if (!shape.north && !shape.south && !shape.east && !shape.west) {
      const cross = !cell.wireDot
      return { north: cross, south: cross, east: cross, west: cross }
    }
    const noEastWest = !shape.east && !shape.west
    const noNorthSouth = !shape.north && !shape.south
    if (!shape.west && noNorthSouth) shape.west = true
    if (!shape.east && noNorthSouth) shape.east = true
    if (!shape.north && noEastWest) shape.north = true
    if (!shape.south && noEastWest) shape.south = true
    return shape
  }

  /** Neighbouring wires this wire exchanges power with, following the vanilla step rules. */
  wireNeighbours(position: Position): Array<{ position: Position; via: 'level' | 'step_up' | 'step_down'; over?: Position }> {
    const result: Array<{ position: Position; via: 'level' | 'step_up' | 'step_down'; over?: Position }> = []
    const aboveIsConductor = this.world.at(shift(position, 'up')).kind === 'conductor'
    for (const direction of HORIZONTAL) {
      const side = shift(position, direction)
      const sideCell = this.world.at(side)
      if (sideCell.kind === 'wire') result.push({ position: side, via: 'level' })
      if (sideCell.kind === 'conductor' && !aboveIsConductor) {
        const upper = shift(side, 'up')
        if (this.world.at(upper).kind === 'wire') result.push({ position: upper, via: 'step_up', over: side })
      } else if (sideCell.kind !== 'conductor') {
        const lower = shift(side, 'down')
        if (this.world.at(lower).kind === 'wire') result.push({ position: lower, via: 'step_down', over: side })
      }
    }
    return result
  }

  private targetStrength(position: Position): number {
    const external = this.bestNeighbourSignal(position, false)
    let neighbourWire = 0
    for (const neighbour of this.wireNeighbours(position)) {
      neighbourWire = Math.max(neighbourWire, this.wirePowerAt(neighbour.position))
    }
    return Math.max(external, neighbourWire - 1)
  }

  // Wire has no memory: its power is the least fixed point of the strength
  // rule given the current component states, so restart from zero and grow.
  private settleWires(): void {
    const wires = this.world.ofKind('wire')
    for (const wire of wires) this.state.wirePower.set(positionKey(wire.position), 0)
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
      let changed = false
      for (const wire of wires) {
        const key = positionKey(wire.position)
        const target = this.targetStrength(wire.position)
        if (target !== this.state.wirePower.get(key)) {
          this.state.wirePower.set(key, target)
          changed = true
        }
      }
      if (!changed) return
    }
  }

  diodeInput(position: Position, cell: Cell): number {
    const rear = shift(position, cell.facing)
    let input = this.signal(rear, cell.facing, true)
    if (input < 15 && this.world.at(rear).kind === 'wire') input = Math.max(input, this.wirePowerAt(rear))
    return input
  }

  private controlInput(position: Position, direction: HorizontalDir, diodesOnly: boolean): number {
    const cell = this.world.at(position)
    if (diodesOnly) {
      return cell.kind === 'repeater' || cell.kind === 'comparator' ? this.directSignal(position, cell, direction, true) : 0
    }
    if (cell.kind === 'redstone_block') return 15
    if (cell.kind === 'wire') return this.wirePowerAt(position)
    return isSignalSource(cell) ? this.directSignal(position, cell, direction, true) : 0
  }

  private alternateSignal(position: Position, cell: Cell, diodesOnly: boolean): number {
    const left = CLOCKWISE[cell.facing]
    const right = OPPOSITE[left] as HorizontalDir
    return Math.max(
      this.controlInput(shift(position, left), left, diodesOnly),
      this.controlInput(shift(position, right), right, diodesOnly),
    )
  }

  attachmentPowered(position: Position, cell: Cell): boolean {
    const target = attachment(position, cell)
    if (!target) return false
    return this.signal(target.position, target.direction, true) > 0
  }

  private stepComponents(): boolean {
    const nextTorch = new Map<string, boolean>()
    for (const torch of this.world.ofKind('torch', 'wall_torch')) {
      const key = positionKey(torch.position)
      nextTorch.set(key, this.state.burnedOut.has(key) ? false : !this.attachmentPowered(torch.position, torch.cell))
    }
    const nextRepeater = new Map<string, boolean>()
    const nextLocked = new Set<string>()
    for (const repeater of this.world.ofKind('repeater')) {
      const key = positionKey(repeater.position)
      const locked = this.alternateSignal(repeater.position, repeater.cell, true) > 0
      if (locked) nextLocked.add(key)
      nextRepeater.set(key, locked
        ? this.state.repeaterPowered.get(key) ?? false
        : this.diodeInput(repeater.position, repeater.cell) > 0)
    }
    const nextComparator = new Map<string, number>()
    for (const comparator of this.world.ofKind('comparator')) {
      const rear = this.diodeInput(comparator.position, comparator.cell)
      const sides = this.alternateSignal(comparator.position, comparator.cell, false)
      nextComparator.set(
        positionKey(comparator.position),
        comparator.cell.subtract ? Math.max(0, rear - sides) : rear >= sides ? rear : 0,
      )
    }

    let changed = false
    for (const [key, value] of nextTorch) {
      if (this.state.torchLit.get(key) !== value) {
        changed = true
        this.state.torchToggles.set(key, (this.state.torchToggles.get(key) ?? 0) + 1)
      }
      this.state.torchLit.set(key, value)
    }
    for (const [key, value] of nextRepeater) {
      if (this.state.repeaterPowered.get(key) !== value) changed = true
      this.state.repeaterPowered.set(key, value)
    }
    for (const [key, value] of nextComparator) {
      if (this.state.comparatorOutput.get(key) !== value) changed = true
      this.state.comparatorOutput.set(key, value)
    }
    this.state.repeaterLocked = nextLocked
    return changed
  }

  /**
   * Alternate wire settling and delayed components until the world stops
   * changing. A torch that keeps toggling itself is burned out the way vanilla
   * does it and the remaining circuit is settled again; only a loop that still
   * oscillates without any burnable torch is reported as unstable.
   */
  run(): boolean {
    const torches = this.world.ofKind('torch', 'wall_torch')
    for (let round = 0; round <= torches.length; round += 1) {
      this.state.torchToggles.clear()
      for (let tick = 0; tick < MAX_TICKS; tick += 1) {
        this.settleWires()
        if (!this.stepComponents()) return true
      }
      const burning = [...this.state.torchToggles.entries()]
        .filter(([key, toggles]) => toggles > BURNOUT_TOGGLES && !this.state.burnedOut.has(key))
        .map(([key]) => key)
      if (burning.length === 0) break
      for (const key of burning) {
        this.state.burnedOut.add(key)
        this.state.torchLit.set(key, false)
      }
    }
    this.settleWires()
    return false
  }

  isBurnedOut(position: Position): boolean {
    return this.state.burnedOut.has(positionKey(position))
  }

  /** Where a torch's own output re-enters its attachment block, for burnout explanations. */
  describeFeedback(position: Position, cell: Cell): string {
    const target = attachment(position, cell)
    if (!target) return ''
    const receivers = DIRECTIONS
      .filter((direction) => direction !== target.direction)
      .map((direction) => shift(position, direction))
      .filter((neighbour) => this.world.at(neighbour).kind === 'wire')
    for (const receiver of receivers) {
      const net = this.wireNet(receiver)
      const touching = net.find((wire) => {
        const above = shift(target.position, 'up')
        if (positionKey(wire) === positionKey(above)) return true
        return HORIZONTAL.some((side) => positionKey(shift(target.position, side)) === positionKey(wire)
          && this.wireShape(wire, this.world.at(wire))[OPPOSITE[side] as HorizontalDir])
      })
      if (touching) {
        return `its output powers ${this.world.label(receiver)}, whose net reaches ${this.world.label(touching)} which powers the torch's own attachment block ${this.world.label(target.position)}`
      }
    }
    return 'its output feeds back into its own attachment block'
  }

  lampLit(position: Position): boolean {
    return this.bestNeighbourSignal(position, true) > 0
  }

  /** Every wire electrically joined to the wire at `position` (including itself). */
  wireNet(position: Position): Position[] {
    const seen = new Map<string, Position>([[positionKey(position), position]])
    const queue = [position]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const neighbour of this.wireNeighbours(current)) {
        const key = positionKey(neighbour.position)
        if (seen.has(key)) continue
        seen.set(key, neighbour.position)
        queue.push(neighbour.position)
      }
    }
    return [...seen.values()]
  }

  /** Describes what a wire is connected to and why it does or does not point at `target`. */
  describeWireShape(position: Position, cell: Cell, target: Position): string {
    const shape = this.wireShape(position, cell)
    const connected = HORIZONTAL.filter((side) => shape[side])
    const toward = HORIZONTAL.find((side) => positionKey(shift(position, side)) === positionKey(target))
    const partners = HORIZONTAL
      .filter((side) => this.connectingSide(position, side))
      .map((side) => `${side} (${this.world.label(shift(position, side))})`)
    const shapeName = connected.length === 4 ? 'cross' : connected.length === 3 ? 'T' : connected.length === 2
      ? ((connected.includes('north') && connected.includes('south')) || (connected.includes('east') && connected.includes('west')) ? 'straight line' : 'corner')
      : connected.length === 1 ? 'stub' : 'dot'
    const attached = partners.length > 0 ? `it attaches to ${partners.join(' and ')}, so it is a ${shapeName} pointing ${connected.join('/')}` : 'it attaches to nothing, so it is a dot'
    if (!toward) return attached
    const axis = toward === 'north' || toward === 'south' ? 'north-south' : 'east-west'
    const otherAxis = axis === 'north-south' ? 'east or west' : 'north or south'
    return `${attached}. It would point ${toward} only if it had no ${otherAxis} attachments (making it ${axis === 'east-west' ? 'an' : 'a'} ${axis} line) or if the block to its ${toward} were itself a wire or component`
  }

  /** Explains why a wire carries no power in this row by looking at its whole net. */
  describeUnpoweredNet(position: Position): string {
    const net = this.wireNet(position)
    const netIds = net.map((item) => this.world.label(item).split('@')[0])
    const netKeys = new Set(net.map(positionKey))
    const poweredElsewhere = this.world.ofKind('wire')
      .filter((wire) => !netKeys.has(positionKey(wire.position)) && this.wirePowerAt(wire.position) > 0)
      .map((wire) => `${wire.cell.block!.id}=${this.wirePowerAt(wire.position)}`)
    const netText = net.length === 1 ? 'it is not joined to any other wire' : `its net {${netIds.join(', ')}} receives no power`
    if (poweredElsewhere.length === 0) return `${netText}; no wire in the layout is powered in this row`
    return `${netText}; the powered wires in this row (${poweredElsewhere.join(', ')}) are not joined to this net (wires join only side by side or by a one-block step)`
  }

  /** Neighbours currently delivering power into a solid block or lamp, with the mechanism. */
  describeSources(position: Position, mode: 'solid' | 'lamp'): string[] {
    const sources: string[] = []
    for (const direction of DIRECTIONS) {
      const neighbour = shift(position, direction)
      const cell = this.world.at(neighbour)
      const value = mode === 'lamp'
        ? this.signal(neighbour, direction, true)
        : this.directSignal(neighbour, cell, direction, true)
      if (value <= 0) continue
      sources.push(`${this.world.label(neighbour)} [${this.describeDelivery(cell, direction)}]`)
    }
    return sources
  }

  private describeDelivery(cell: Cell, direction: Dir): string {
    switch (cell.kind) {
      case 'lever': return 'lever'
      case 'torch':
      case 'wall_torch': return direction === 'down' ? 'lit torch below' : 'lit torch beside'
      case 'wire': return direction === 'up' ? 'powered wire on top' : 'powered wire pointing in'
      case 'repeater': return 'repeater output'
      case 'comparator': return 'comparator output'
      case 'redstone_block': return 'redstone block'
      case 'conductor': return 'powered solid block'
      default: return cell.name.replace('minecraft:', '')
    }
  }

  /** Why nothing reaches a solid block or lamp: what each non-air neighbour is doing right now. */
  describeSilentNeighbours(position: Position): string[] {
    const notes: string[] = []
    for (const direction of DIRECTIONS) {
      const neighbour = shift(position, direction)
      const cell = this.world.at(neighbour)
      if (cell.kind === 'air') continue
      if (cell.kind === 'conductor' && !cell.block) continue
      const label = this.world.label(neighbour)
      if (cell.kind === 'wire') {
        const power = this.wirePowerAt(neighbour)
        if (direction === 'down') notes.push(`${label} is below it, and a wire never powers the block above itself`)
        else if (direction === 'up') notes.push(`${label} on top has power ${power}${power === 0 ? ` (${this.describeUnpoweredNet(neighbour)})` : ''}`)
        else if (!this.wireShape(neighbour, cell)[OPPOSITE[direction] as HorizontalDir]) notes.push(`${label} runs alongside (power ${power}) but its line does not point into this block: ${this.describeWireShape(neighbour, cell, position)}`)
        else notes.push(`${label} points in but has power ${power}${power === 0 ? ` (${this.describeUnpoweredNet(neighbour)})` : ''}`)
      } else if (cell.kind === 'torch' || cell.kind === 'wall_torch') {
        const target = attachment(neighbour, cell)
        if (target && positionKey(target.position) === positionKey(position)) notes.push(`${label} hangs on this block, and a torch never powers its own attachment block`)
        else notes.push(`${label} is ${this.torchLit(neighbour) ? 'LIT' : 'OFF'}`)
      } else if (cell.kind === 'conductor') {
        const powered = this.directSignalTo(neighbour, true) > 0
        notes.push(`${label} is ${powered ? 'a powered' : 'an unpowered'} solid block${powered ? '' : '; solid blocks never pass power to other solid blocks'}`)
      } else if (cell.kind === 'repeater' || cell.kind === 'comparator') {
        notes.push(`${label} ${cell.facing === direction ? 'outputs into this block' : 'does not output toward this block'}`)
      } else if (cell.kind === 'lever') {
        notes.push(`${label} is ${this.state.leverOn.get(positionKey(neighbour)) ? 'ON' : 'OFF'}`)
      } else {
        notes.push(`${label} (${cell.name.replace('minecraft:', '')})`)
      }
    }
    return notes
  }
}

function inputsLabel(inputs: Record<string, Binary>): string {
  return Object.entries(inputs).map(([id, value]) => `${id}=${value}`).join(',')
}

export function simulateTruthTable(task: TaskSpec, layout: PhysicalLayout): SimulationReport {
  const unsupported = [...new Set(layout.blocks
    .map((block) => normalizeBlockName(block.block))
    .filter((name) => !SUPPORTED_BLOCKS.has(name)))]
  if (unsupported.length > 0) {
    return {
      evaluated: false,
      reason: `Simulation skipped: no steady-state model for ${unsupported.join(', ')}`,
      cases: [],
      passedCases: 0,
      totalCases: task.truthTable.length,
      passed: false,
      observations: [],
    }
  }

  const world = new RedstoneWorld(layout)
  const levers = world.ofKind('lever')
  const outputLamps = task.outputs.map((output) => ({
    output,
    position: output.port.position,
    hasLamp: world.at(output.port.position).isLamp,
  }))

  const cases: SimulatedCase[] = []
  const simulations: CaseSimulation[] = []
  for (const [index, row] of task.truthTable.entries()) {
    const leverOn = new Map<string, boolean>()
    for (const lever of levers) {
      const inputId = lever.cell.block?.implements.find((id) => id in row.inputs)
      leverOn.set(positionKey(lever.position), inputId !== undefined && row.inputs[inputId] === 1)
    }
    const simulation = new CaseSimulation(world, leverOn)
    const converged = simulation.run()
    simulations.push(simulation)

    const actual: Record<string, OutputValue> = {}
    const mismatches: string[] = []
    for (const { output, position, hasLamp } of outputLamps) {
      if (!hasLamp) {
        actual[output.id] = 'unreadable'
        mismatches.push(`${output.id}: no redstone lamp at fixed port ${positionKey(position)}`)
        continue
      }
      const lit = simulation.lampLit(position)
      actual[output.id] = converged ? (lit ? 1 : 0) : 'unstable'
      const expected = row.outputs[output.id]
      if (!converged) {
        mismatches.push(`${output.id}: the circuit never settles (a torch or repeater feeds back into itself); combinational layouts must not loop`)
      } else if (expected !== undefined && (lit ? 1 : 0) !== expected) {
        const label = world.label(position)
        if (lit) {
          mismatches.push(`${output.id} is LIT because ${label} receives power from ${simulation.describeSources(position, 'lamp').join(' and ')}`)
        } else {
          const notes = simulation.describeSilentNeighbours(position)
          mismatches.push(`${output.id} is OFF because nothing face-adjacent delivers power to ${label}${notes.length > 0 ? `: ${notes.join('; ')}` : ''}`)
        }
      }
    }
    const passed = converged && outputLamps.every(({ output }) => actual[output.id] === row.outputs[output.id])
    if (!passed) {
      for (const torch of world.ofKind('torch', 'wall_torch').filter((item) => simulation.isBurnedOut(item.position))) {
        mismatches.push(`${torch.cell.block!.id} oscillated and burned out in this row (${simulation.describeFeedback(torch.position, torch.cell)}); Minecraft leaves a burned-out torch OFF. Break the loop so the torch's output never reaches its own attachment block.`)
      }
    }
    cases.push({
      index,
      inputs: row.inputs,
      expected: row.outputs,
      actual,
      passed,
      converged,
      states: describeStates(world, simulation),
      mismatches,
    })
  }

  const passedCases = cases.filter((item) => item.passed).length
  return {
    evaluated: true,
    cases,
    passedCases,
    totalCases: cases.length,
    passed: passedCases === cases.length && cases.length > 0,
    observations: circuitObservations(world, simulations, task, outputLamps.map((item) => item.position)),
  }
}

function describeStates(world: RedstoneWorld, simulation: CaseSimulation): string[] {
  const states: string[] = []
  for (const lever of world.ofKind('lever')) {
    states.push(`${lever.cell.block!.id}=${simulation.state.leverOn.get(positionKey(lever.position)) ? 'ON' : 'OFF'}`)
  }
  for (const torch of world.ofKind('torch', 'wall_torch')) {
    const target = attachment(torch.position, torch.cell)!
    if (simulation.isBurnedOut(torch.position)) {
      states.push(`${torch.cell.block!.id}=BURNED OUT (kept toggling itself: ${simulation.describeFeedback(torch.position, torch.cell)})`)
      continue
    }
    const powered = simulation.attachmentPowered(torch.position, torch.cell)
    const sources = powered ? simulation.describeSources(target.position, 'solid') : []
    states.push(`${torch.cell.block!.id}=${simulation.torchLit(torch.position) ? 'LIT' : 'OFF'} (hangs on ${world.label(target.position)}, ${powered ? `powered by ${sources.join(' and ')}` : 'unpowered'})`)
  }
  for (const repeater of world.ofKind('repeater')) {
    const key = positionKey(repeater.position)
    states.push(`${repeater.cell.block!.id}=${simulation.state.repeaterPowered.get(key) ? 'ON' : 'OFF'} (input ${simulation.diodeInput(repeater.position, repeater.cell)} from ${world.label(shift(repeater.position, repeater.cell.facing))}${simulation.state.repeaterLocked.has(key) ? ', LOCKED by a side diode' : ''})`)
  }
  for (const comparator of world.ofKind('comparator')) {
    states.push(`${comparator.cell.block!.id}=output ${simulation.state.comparatorOutput.get(positionKey(comparator.position)) ?? 0}`)
  }
  const wires = world.ofKind('wire').map((wire) => `${wire.cell.block!.id}=${simulation.state.wirePower.get(positionKey(wire.position)) ?? 0}`)
  if (wires.length > 0) states.push(`wire power: ${wires.join(', ')}`)
  for (const lamp of world.components.filter((item) => item.cell.isLamp)) {
    const lit = simulation.lampLit(lamp.position)
    states.push(`${lamp.cell.block!.id}=${lit ? 'LIT' : 'OFF'}${lit ? ` (powered by ${simulation.describeSources(lamp.position, 'lamp').join(' and ')})` : ''}`)
  }
  return states
}

function circuitObservations(
  world: RedstoneWorld,
  simulations: CaseSimulation[],
  task: TaskSpec,
  lampPositions: Position[],
): string[] {
  const notes: string[] = []
  if (simulations.length === 0) return notes
  const lampKeys = new Set(lampPositions.map(positionKey))
  // Neighbour descriptions need one concrete case; use the row where the most
  // inputs are ON so wires that could carry power show their real level.
  const referenceIndex = task.truthTable
    .map((row, index) => ({ index, on: Object.values(row.inputs).filter((value) => value === 1).length }))
    .sort((left, right) => right.on - left.on)[0]?.index ?? 0
  const reference = simulations[referenceIndex]
  const referenceLabel = inputsLabel(task.truthTable[referenceIndex].inputs)

  for (const torch of world.ofKind('torch', 'wall_torch')) {
    const id = torch.cell.block!.id
    const target = attachment(torch.position, torch.cell)!
    const burnRows = task.truthTable
      .map((row, index) => ({ row, index }))
      .filter(({ index }) => simulations[index].isBurnedOut(torch.position))
    if (burnRows.length > 0) {
      notes.push(`${id} oscillates and burns out in row${burnRows.length > 1 ? 's' : ''} ${burnRows.map(({ row }) => `(${inputsLabel(row.inputs)})`).join(', ')}: ${simulations[burnRows[0].index].describeFeedback(torch.position, torch.cell)}. A burned-out torch stays OFF; remove that feedback path.`)
    }
    const poweredCases = simulations.filter((simulation) => simulation.attachmentPowered(torch.position, torch.cell)).length
    if (poweredCases === 0) {
      const silent = reference.describeSilentNeighbours(target.position)
      notes.push(`${id} stays LIT in every case: its attachment block ${world.label(target.position)} is never powered${silent.length > 0 ? ` (with ${referenceLabel}: ${silent.join('; ')})` : ''}. Only a lever attached to that block, a lit torch directly below it, a repeater/comparator output facing it, a powered wire on top of it, or a powered wire whose line points into it can power it.`)
    } else if (poweredCases === simulations.length) {
      notes.push(`${id} stays OFF in every case: its attachment block ${world.label(target.position)} is powered in every input combination.`)
    }

    if (simulations.some((simulation) => simulation.torchLit(torch.position))) {
      const receivers = DIRECTIONS.filter((direction) => {
        if (direction === target.direction) return false
        const neighbour = shift(torch.position, direction)
        const cell = world.at(neighbour)
        if (cell.kind === 'wire' || cell.isLamp) return true
        if (cell.kind === 'repeater' || cell.kind === 'comparator') return cell.facing === OPPOSITE[direction]
        return direction === 'up' && cell.kind === 'conductor'
      })
      if (receivers.length === 0) {
        notes.push(`${id} output reaches nothing: no wire, lamp, repeater input or comparator is face-adjacent to it and no solid block sits directly above it (a torch never powers diagonal blocks or the block it hangs on).`)
      }
    }
  }

  for (const lamp of world.components.filter((item) => item.cell.isLamp && lampKeys.has(positionKey(item.position)))) {
    const id = lamp.cell.block!.id
    const litCases = simulations.filter((simulation) => simulation.lampLit(lamp.position)).length
    if (litCases === 0) notes.push(`${id} is OFF in every case; no neighbour ever delivers power to it.`)
    if (litCases === simulations.length && simulations.length > 1) notes.push(`${id} is LIT in every case; some neighbour powers it regardless of the inputs.`)
    for (const direction of DIRECTIONS) {
      const neighbour = shift(lamp.position, direction)
      const cell = world.at(neighbour)
      if (cell.kind !== 'conductor' || !cell.block) continue
      for (const mounted of world.ofKind('torch', 'wall_torch', 'lever')) {
        const mount = attachment(mounted.position, mounted.cell)
        if (!mount || positionKey(mount.position) !== positionKey(neighbour)) continue
        notes.push(mounted.cell.kind === 'lever'
          ? `${id} is face-adjacent to ${world.label(neighbour)}, the attachment block of ${mounted.cell.block!.id}; the lamp lights whenever that lever is ON.`
          : `${id} is face-adjacent to ${world.label(neighbour)}, the attachment block of ${mounted.cell.block!.id}; whenever that block is powered the lamp lights directly, bypassing the torch.`)
      }
    }
  }

  const seenPairs = new Set<string>()
  const deadWires: string[] = []
  for (const wire of world.ofKind('wire')) {
    const wireBlock = wire.cell.block!
    for (const neighbour of reference.wireNeighbours(wire.position)) {
      const other = world.at(neighbour.position).block
      if (!other) continue
      const pair = [wireBlock.id, other.id].sort().join('|')
      if (seenPairs.has(pair)) continue
      seenPairs.add(pair)
      if (other.implements.some((id) => wireBlock.implements.includes(id))) continue
      const via = neighbour.via === 'level' ? 'side by side' : `by a step over ${world.label(neighbour.over!)}`
      notes.push(`${wireBlock.id} (${wireBlock.implements.join(',')}) and ${other.id} (${other.implements.join(',')}) are electrically joined ${via}; their signals merge into one net.`)
    }
    if (simulations.every((simulation) => (simulation.state.wirePower.get(positionKey(wire.position)) ?? 0) === 0)) {
      deadWires.push(wireBlock.id)
    }
  }
  if (deadWires.length > 0) {
    notes.push(`${deadWires.join(', ')} never carr${deadWires.length === 1 ? 'ies' : 'y'} power in any case; no source reaches ${deadWires.length === 1 ? 'it' : 'them'}.`)
  }

  return notes
}
