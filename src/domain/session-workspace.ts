import type { Position, Size3D } from './domain'
import { GRASSLAND } from './world-environment'

export type SessionWorkspace = { origin: Position; size: Size3D }

// Reserve the clearing apron as well as the circuit footprint. Allocations
// are persisted before any /fill command and never reuse a student's region.
export function allocateSessionWorkspace(base: Position, size: Size3D, occupied: SessionWorkspace[]): SessionWorkspace {
  const gap = 2 * GRASSLAND.horizontalMargin + 192
  const x = occupied.reduce((next, region) => Math.max(next, region.origin.x + region.size.x + gap), base.x)
  if (!Number.isSafeInteger(x) || x + size.x + GRASSLAND.horizontalMargin >= 29_999_984) {
    throw new Error('No safe Minecraft workspace is available within the world boundary')
  }
  return { origin: { ...base, x }, size: { ...size } }
}

export function workspacesOverlap(a: SessionWorkspace, b: SessionWorkspace): boolean {
  const margin = GRASSLAND.horizontalMargin
  return a.origin.x - margin < b.origin.x + b.size.x + margin
    && b.origin.x - margin < a.origin.x + a.size.x + margin
    && a.origin.z - margin < b.origin.z + b.size.z + margin
    && b.origin.z - margin < a.origin.z + a.size.z + margin
}
