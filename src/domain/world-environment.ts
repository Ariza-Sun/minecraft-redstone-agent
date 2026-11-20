import type { Position } from './domain'

/**
 * Layout coordinates start one block above the generated grassland. The
 * terrain is environment state, so it is deliberately absent from
 * PhysicalLayout.blocks and does not count against a task's block budget.
 */
export const GRASSLAND = Object.freeze({
  surfaceY: -1,
  surfaceBlock: 'minecraft:grass_block',
  subsurfaceBlock: 'minecraft:dirt',
  subsurfaceDepth: 2,
  // Flat grass apron extended around the workspace on every horizontal side.
  horizontalMargin: 16,
  // Air is cleared this many blocks above the grass surface across the whole
  // apron, so any surrounding terrain or leftover from an earlier build is
  // shaved down to the grass level and the circuit sits in a seamless flat
  // field instead of a sunken pit.
  apronClearHeight: 12,
})

export function isGrasslandSurface(position: Position): boolean {
  return position.y === GRASSLAND.surfaceY
}
