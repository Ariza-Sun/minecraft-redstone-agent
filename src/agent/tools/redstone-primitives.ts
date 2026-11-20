import { normalizeBlockName, type LayoutBlock, type Position } from '@domain/domain'
import { GRASSLAND } from '@domain/world-environment'

// Direction geometry and the block -> Cell model beneath the steady-state
// engine: pure vanilla-1.20 facts (offsets, opposites, rotation, conductor
// catalog, attachment geometry) with no simulation state.

export const DIRECTIONS = ['north', 'south', 'east', 'west', 'up', 'down'] as const
export type Dir = typeof DIRECTIONS[number]
export type HorizontalDir = 'north' | 'south' | 'east' | 'west'
export const HORIZONTAL: HorizontalDir[] = ['north', 'south', 'east', 'west']

export const OFFSET: Record<Dir, Position> = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
}

export const OPPOSITE: Record<Dir, Dir> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  up: 'down',
  down: 'up',
}

export const CLOCKWISE: Record<HorizontalDir, HorizontalDir> = {
  north: 'east',
  east: 'south',
  south: 'west',
  west: 'north',
}

export function shift(position: Position, direction: Dir): Position {
  const offset = OFFSET[direction]
  return { x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z }
}

export function isHorizontal(direction: string): direction is HorizontalDir {
  return (HORIZONTAL as string[]).includes(direction)
}

export type CellKind =
  | 'air'
  | 'conductor'
  | 'solid_nonconductor'
  | 'redstone_block'
  | 'lever'
  | 'torch'
  | 'wall_torch'
  | 'wire'
  | 'repeater'
  | 'comparator'

export type Cell = {
  kind: CellKind
  name: string
  block?: LayoutBlock
  facing: HorizontalDir
  face: 'floor' | 'wall' | 'ceiling'
  subtract: boolean
  wireDot: boolean
  isLamp: boolean
}

export const CONDUCTORS = new Set([
  'minecraft:stone',
  'minecraft:smooth_stone',
  'minecraft:polished_andesite',
  'minecraft:iron_block',
  'minecraft:redstone_lamp',
  'minecraft:grass_block',
  'minecraft:dirt',
])

export const SOLID_NONCONDUCTORS = new Set(['minecraft:glass', 'minecraft:piston', 'minecraft:sticky_piston'])

export const SUPPORTED_BLOCKS = new Set([
  ...CONDUCTORS,
  'minecraft:glass',
  'minecraft:air',
  'minecraft:redstone_block',
  'minecraft:lever',
  'minecraft:redstone_torch',
  'minecraft:redstone_wall_torch',
  'minecraft:redstone_wire',
  'minecraft:repeater',
  'minecraft:comparator',
])

export function horizontalFacing(value: unknown): HorizontalDir {
  return isHorizontal(String(value)) ? (String(value) as HorizontalDir) : 'north'
}

export function environmentCell(name: string, kind: CellKind): Cell {
  return { kind, name, facing: 'north', face: 'wall', subtract: false, wireDot: true, isLamp: false }
}

export const AIR = environmentCell('minecraft:air', 'air')
export const GRASS = environmentCell(GRASSLAND.surfaceBlock, 'conductor')
export const DIRT = environmentCell(GRASSLAND.subsurfaceBlock, 'conductor')

export function toCell(block: LayoutBlock): Cell {
  const name = normalizeBlockName(block.block)
  const properties = block.properties
  const base: Cell = {
    kind: 'air',
    name,
    block,
    facing: horizontalFacing(properties.facing),
    face: ['floor', 'wall', 'ceiling'].includes(String(properties.face)) ? (String(properties.face) as Cell['face']) : 'wall',
    subtract: properties.mode === 'subtract',
    // A wire written by /setblock keeps the default "dot" shape unless it
    // connects to something or was given explicit side states.
    wireDot: !HORIZONTAL.some((side) => ['side', 'up'].includes(String(properties[side]))),
    isLamp: name === 'minecraft:redstone_lamp',
  }
  if (CONDUCTORS.has(name)) return { ...base, kind: 'conductor' }
  if (SOLID_NONCONDUCTORS.has(name)) return { ...base, kind: 'solid_nonconductor' }
  switch (name) {
    case 'minecraft:redstone_block': return { ...base, kind: 'redstone_block' }
    case 'minecraft:lever': return { ...base, kind: 'lever' }
    case 'minecraft:redstone_torch': return { ...base, kind: 'torch' }
    case 'minecraft:redstone_wall_torch': return { ...base, kind: 'wall_torch' }
    case 'minecraft:redstone_wire': return { ...base, kind: 'wire' }
    case 'minecraft:repeater': return { ...base, kind: 'repeater' }
    case 'minecraft:comparator': return { ...base, kind: 'comparator' }
    default: return base
  }
}

export function isSignalSource(cell: Cell): boolean {
  return ['lever', 'torch', 'wall_torch', 'wire', 'repeater', 'comparator', 'redstone_block'].includes(cell.kind)
}

export function canWireSurviveOn(cell: Cell): boolean {
  return cell.kind === 'conductor' || cell.kind === 'solid_nonconductor' || cell.kind === 'redstone_block'
}

export function leverConnectedDirection(cell: Cell): Dir {
  if (cell.face === 'floor') return 'up'
  if (cell.face === 'ceiling') return 'down'
  return cell.facing
}

/** Block a torch or lever is attached to, with the direction from the component to that block. */
export function attachment(position: Position, cell: Cell): { position: Position; direction: Dir } | undefined {
  if (cell.kind === 'torch') return { position: shift(position, 'down'), direction: 'down' }
  if (cell.kind === 'wall_torch') return { position: shift(position, OPPOSITE[cell.facing]), direction: OPPOSITE[cell.facing] }
  if (cell.kind === 'lever') {
    const direction = OPPOSITE[leverConnectedDirection(cell)]
    return { position: shift(position, direction), direction }
  }
  return undefined
}
