import { physicalLayoutSchema, versionRef, type LayoutRepairPatch, type LogicDesign, type PhysicalLayout } from '@domain/domain'

export function materializeLayoutRepair(
  base: PhysicalLayout,
  patch: LayoutRepairPatch,
  version: number,
  design: LogicDesign,
): { layout?: PhysicalLayout; errors: string[] } {
  const errors: string[] = []
  if (patch.baseVersion !== base.version) {
    errors.push(`Patch baseVersion ${patch.baseVersion} does not match current best layout v${base.version}`)
  }
  const baseIds = new Set(base.blocks.map((block) => block.id))
  const unknownRemovals = patch.removeBlockIds.filter((id) => !baseIds.has(id))
  if (unknownRemovals.length > 0) errors.push(`Cannot remove unknown block ids: ${unknownRemovals.join(', ')}`)
  if (errors.length > 0) return { errors }

  const removed = new Set(patch.removeBlockIds)
  const upserts = new Map(patch.upsertBlocks.map((block) => [block.id, block]))
  const blocks = base.blocks
    .filter((block) => !removed.has(block.id))
    .map((block) => upserts.get(block.id) ?? block)
  const existingIds = new Set(blocks.map((block) => block.id))
  for (const block of patch.upsertBlocks) {
    if (!existingIds.has(block.id)) {
      blocks.push(block)
      existingIds.add(block.id)
    }
  }

  const parsed = physicalLayoutSchema.safeParse({
    bounds: patch.bounds ?? base.bounds,
    blocks,
    explanation: patch.explanation,
    changeSummary: patch.changeSummary,
    id: base.id,
    version,
    logicDesignRef: versionRef(design),
  })
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }
  }
  return { layout: parsed.data, errors: [] }
}
