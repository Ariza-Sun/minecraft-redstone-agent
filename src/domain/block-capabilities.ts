export type BlockPropertyValue = string | boolean | number

type OneOfPropertyRule = {
  kind: 'one_of'
  values: readonly BlockPropertyValue[]
}

type IntegerPropertyRule = {
  kind: 'integer'
  min: number
  max: number
}

export type BlockPropertyRule = OneOfPropertyRule | IntegerPropertyRule

export type BlockCapability = {
  properties: Readonly<Record<string, BlockPropertyRule>>
  solidSupport: boolean
}

const oneOf = (...values: BlockPropertyValue[]): OneOfPropertyRule => ({ kind: 'one_of', values })
const integerBetween = (min: number, max: number): IntegerPropertyRule => ({ kind: 'integer', min, max })

const commonFacing = oneOf('north', 'south', 'east', 'west')
const allFacing = oneOf('north', 'south', 'east', 'west', 'up', 'down')
const booleanValue = oneOf(true, false, 'true', 'false')

/**
 * The single deterministic capability catalog used by TaskSpec validation and
 * PhysicalLayout validation. TaskSpec.allowedBlocks remains the per-task
 * whitelist; solidSupport is an independent physical capability.
 */
export const BLOCK_CAPABILITIES: Readonly<Record<string, BlockCapability>> = Object.freeze({
  'minecraft:air': { properties: {}, solidSupport: false },
  'minecraft:stone': { properties: {}, solidSupport: true },
  'minecraft:smooth_stone': { properties: {}, solidSupport: true },
  'minecraft:polished_andesite': { properties: {}, solidSupport: true },
  'minecraft:redstone_block': { properties: {}, solidSupport: true },
  'minecraft:lever': {
    properties: { face: oneOf('floor', 'wall', 'ceiling'), facing: commonFacing, powered: booleanValue },
    solidSupport: false,
  },
  'minecraft:redstone_torch': { properties: { lit: booleanValue }, solidSupport: false },
  'minecraft:redstone_wall_torch': {
    properties: { facing: commonFacing, lit: booleanValue },
    solidSupport: false,
  },
  'minecraft:redstone_wire': {
    properties: {
      power: integerBetween(0, 15),
      north: oneOf('none', 'side', 'up'),
      south: oneOf('none', 'side', 'up'),
      east: oneOf('none', 'side', 'up'),
      west: oneOf('none', 'side', 'up'),
    },
    solidSupport: false,
  },
  'minecraft:repeater': {
    properties: { facing: commonFacing, delay: integerBetween(1, 4), locked: booleanValue, powered: booleanValue },
    solidSupport: false,
  },
  'minecraft:comparator': {
    properties: { facing: commonFacing, mode: oneOf('compare', 'subtract'), powered: booleanValue },
    solidSupport: false,
  },
  'minecraft:redstone_lamp': { properties: { lit: booleanValue }, solidSupport: true },
  'minecraft:piston': { properties: { facing: allFacing, extended: booleanValue }, solidSupport: true },
  'minecraft:sticky_piston': { properties: { facing: allFacing, extended: booleanValue }, solidSupport: true },
  'minecraft:iron_block': { properties: {}, solidSupport: true },
  'minecraft:glass': { properties: {}, solidSupport: true },
})

export const REGISTERED_BLOCK_NAMES = Object.freeze(Object.keys(BLOCK_CAPABILITIES).sort())

export function normalizeBlockName(block: string): string {
  return block.startsWith('minecraft:') ? block : `minecraft:${block}`
}

export function blockCapability(block: string): BlockCapability | undefined {
  return BLOCK_CAPABILITIES[normalizeBlockName(block)]
}

export function isRegisteredBlock(block: string): boolean {
  return blockCapability(block) !== undefined
}

export function acceptsBlockProperty(rule: BlockPropertyRule, value: BlockPropertyValue): boolean {
  if (rule.kind === 'one_of') return rule.values.includes(value)
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= rule.min && numeric <= rule.max
}
