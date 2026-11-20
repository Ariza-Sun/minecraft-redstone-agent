import type { Position, TaskSpec } from '@domain/domain'
import { GRASSLAND } from '@domain/world-environment'

// Minecraft's default /fill limit (commandModificationBlockLimit gamerule).
const FILL_BLOCK_LIMIT = 32768
// Cap each fill's horizontal footprint so the vertical extent can always be
// grouped without crossing the block limit, whatever the workspace size.
const FILL_CHUNK = 32

/** Tile a box into /fill commands that each stay under the block limit. */
function fillBox(min: Position, max: Position, block: string): string[] {
  const commands: string[] = []
  for (let x = min.x; x <= max.x; x += FILL_CHUNK) {
    const x2 = Math.min(max.x, x + FILL_CHUNK - 1)
    for (let z = min.z; z <= max.z; z += FILL_CHUNK) {
      const z2 = Math.min(max.z, z + FILL_CHUNK - 1)
      const layerArea = (x2 - x + 1) * (z2 - z + 1)
      const layersPerFill = Math.max(1, Math.floor(FILL_BLOCK_LIMIT / layerArea))
      for (let y = min.y; y <= max.y; y += layersPerFill) {
        const y2 = Math.min(max.y, y + layersPerFill - 1)
        commands.push(`/fill ${x} ${y} ${z} ${x2} ${y2} ${z2} ${block}`)
      }
    }
  }
  return commands
}

export function grasslandResetCommands(task: TaskSpec, worldOrigin: Position): string[] {
  const minX = worldOrigin.x - GRASSLAND.horizontalMargin
  const maxX = worldOrigin.x + task.workspace.size.x - 1 + GRASSLAND.horizontalMargin
  const minZ = worldOrigin.z - GRASSLAND.horizontalMargin
  const maxZ = worldOrigin.z + task.workspace.size.z - 1 + GRASSLAND.horizontalMargin
  const surfaceY = worldOrigin.y + GRASSLAND.surfaceY
  const bottomY = surfaceY - GRASSLAND.subsurfaceDepth
  // Tall enough to both empty the workspace column and shave surrounding
  // terrain/leftover down to the grass surface across the whole apron.
  const clearTopY = Math.max(
    worldOrigin.y + task.workspace.size.y - 1,
    surfaceY + GRASSLAND.apronClearHeight,
  )

  return [
    ...fillBox({ x: minX, y: surfaceY + 1, z: minZ }, { x: maxX, y: clearTopY, z: maxZ }, 'minecraft:air'),
    ...fillBox({ x: minX, y: bottomY, z: minZ }, { x: maxX, y: surfaceY - 1, z: maxZ }, GRASSLAND.subsurfaceBlock),
    ...fillBox({ x: minX, y: surfaceY, z: minZ }, { x: maxX, y: surfaceY, z: maxZ }, GRASSLAND.surfaceBlock),
  ]
}
