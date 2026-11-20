import { z } from 'zod'
import { isRegisteredBlock } from './block-capabilities'

export { normalizeBlockName } from './block-capabilities'

export const binarySchema = z.union([z.literal(0), z.literal(1)])
export type Binary = z.infer<typeof binarySchema>

export const positionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
})
export type Position = z.infer<typeof positionSchema>

export const size3DSchema = z.object({
  x: z.number().int().positive(),
  y: z.number().int().positive(),
  z: z.number().int().positive(),
})
export type Size3D = z.infer<typeof size3DSchema>

export const facingSchema = z.enum(['north', 'south', 'east', 'west', 'up', 'down'])
export type Facing = z.infer<typeof facingSchema>

export const portPlacementSchema = z.object({
  position: positionSchema,
  facing: facingSchema,
})

export const versionRefSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
})
export type VersionRef = z.infer<typeof versionRefSchema>

export const changeSummarySchema = z.object({
  reason: z.string().min(1),
  changed: z.array(z.string()),
  impact: z.array(z.string()),
})
export type ChangeSummary = z.infer<typeof changeSummarySchema>

const ioSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  port: portPlacementSchema,
})

const truthTableCaseSchema = z.object({
  inputs: z.record(binarySchema),
  outputs: z.record(binarySchema),
})

const registeredBlockNameSchema = z.string()
  .regex(/^(minecraft:)?[a-z0-9_]+$/)
  .refine(isRegisteredBlock, 'Block has no registered deterministic capability definition')

export const taskSpecDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  inputs: z.array(ioSchema).min(1),
  outputs: z.array(ioSchema).min(1),
  truthTable: z.array(truthTableCaseSchema).min(1),
  workspace: z.object({
    origin: positionSchema,
    size: size3DSchema,
  }),
  allowedBlocks: z.array(registeredBlockNameSchema).min(1),
  maxBlocks: z.number().int().positive(),
  acceptance: z.object({
    requireAllCases: z.literal(true),
    stableReads: z.number().int().positive().max(10),
  }),
})
export type TaskSpecDraft = z.infer<typeof taskSpecDraftSchema>

export const taskSpecSchema = taskSpecDraftSchema.extend({
  id: z.string().min(1),
  version: z.number().int().positive(),
})
export type TaskSpec = z.infer<typeof taskSpecSchema>

export const logicNodeKindSchema = z.enum([
  'input',
  'output',
  'not',
  'and',
  'or',
  'xor',
  'nand',
  'nor',
  'xnor',
])
export type LogicNodeKind = z.infer<typeof logicNodeKindSchema>

const logicNodeSchema = z.object({
  id: z.string().min(1),
  kind: logicNodeKindSchema,
  label: z.string().min(1),
})

const logicEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  signal: z.string().min(1),
})

const logicExplanationSchema = z.object({
  overview: z.string().min(1),
  componentNotes: z.array(z.object({ nodeId: z.string().min(1), text: z.string().min(1) })),
  validationPlan: z.string().min(1),
})

export const logicDesignDraftSchema = z.object({
  nodes: z.array(logicNodeSchema).min(2),
  edges: z.array(logicEdgeSchema).min(1),
  equations: z.record(z.string()),
  explanation: logicExplanationSchema,
  changeSummary: changeSummarySchema.optional(),
})
export type LogicDesignDraft = z.infer<typeof logicDesignDraftSchema>

export const logicDesignSchema = logicDesignDraftSchema.extend({
  id: z.string().min(1),
  version: z.number().int().positive(),
  taskSpecRef: versionRefSchema,
})
export type LogicDesign = z.infer<typeof logicDesignSchema>

const blockPropertySchema = z.union([z.string(), z.boolean(), z.number()])
export const layoutBlockSchema = z.object({
  id: z.string().min(1),
  block: z.string().regex(/^(minecraft:)?[a-z0-9_]+$/),
  position: positionSchema,
  properties: z.record(blockPropertySchema).default({}),
  implements: z.array(z.string().min(1)).min(1),
  phase: z.number().int().nonnegative().optional(),
})
export type LayoutBlock = z.infer<typeof layoutBlockSchema>

export const layoutExplanationSchema = z.object({
  overview: z.string().min(1),
  criticalOrientations: z.array(z.object({ blockId: z.string().min(1), text: z.string().min(1) })),
  routingNotes: z.array(z.string()),
})

export const physicalLayoutDraftSchema = z.object({
  bounds: size3DSchema,
  blocks: z.array(layoutBlockSchema).min(1),
  explanation: layoutExplanationSchema,
  changeSummary: changeSummarySchema.optional(),
})
export type PhysicalLayoutDraft = z.infer<typeof physicalLayoutDraftSchema>

export const physicalLayoutSchema = physicalLayoutDraftSchema.extend({
  id: z.string().min(1),
  version: z.number().int().positive(),
  logicDesignRef: versionRefSchema,
})
export type PhysicalLayout = z.infer<typeof physicalLayoutSchema>

export const runErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  recoverable: z.boolean().default(false),
})
export type RunError = z.infer<typeof runErrorSchema>

export const minecraftEnvironmentSchema = z.object({
  adapter: z.enum(['live', 'mock']),
  authoritative: z.boolean(),
  host: z.string(),
  port: z.number().int(),
  version: z.string(),
  worldOrigin: positionSchema,
  viewerUrl: z.string().optional(),
})
export type MinecraftEnvironment = z.infer<typeof minecraftEnvironmentSchema>

export const buildRunSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  sessionId: z.string().min(1),
  layoutRef: versionRefSchema,
  environment: minecraftEnvironmentSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  placed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  errors: z.array(runErrorSchema),
})
export type BuildRun = z.infer<typeof buildRunSchema>

export const evidenceRefSchema = z.object({
  type: z.enum(['minecraft-block-read', 'mock-reading']),
  source: z.string(),
  at: z.string(),
  position: positionSchema.optional(),
  block: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
})
export type EvidenceRef = z.infer<typeof evidenceRefSchema>

export const outputValueSchema = z.union([
  binarySchema,
  z.literal('unstable'),
  z.literal('unreadable'),
])
export type OutputValue = z.infer<typeof outputValueSchema>

export const verificationCaseSchema = z.object({
  index: z.number().int().nonnegative(),
  inputs: z.record(binarySchema),
  expected: z.record(binarySchema),
  actual: z.record(outputValueSchema),
  passed: z.boolean(),
  evidence: z.array(evidenceRefSchema),
})
export type VerificationCase = z.infer<typeof verificationCaseSchema>

export const worldCaseStateSchema = verificationCaseSchema.extend({
  purpose: z.enum(['display', 'retest']).optional(),
  authoritative: z.boolean(),
  appliedAt: z.string(),
})
export type WorldCaseState = z.infer<typeof worldCaseStateSchema>

export const verificationReportSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  taskSpecRef: versionRefSchema,
  buildRunRef: versionRefSchema,
  cases: z.array(verificationCaseSchema),
  passedCases: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  passed: z.boolean(),
  authoritative: z.boolean(),
  environmentErrors: z.array(runErrorSchema),
  startedAt: z.string(),
  finishedAt: z.string(),
})
export type VerificationReport = z.infer<typeof verificationReportSchema>

export const worldBlockObservationSchema = z.object({
  position: positionSchema,
  worldPosition: positionSchema,
  expected: z.array(z.object({
    blockId: z.string().min(1),
    block: z.string().min(1),
    relation: z.enum(['layout', 'attachment_support']),
  })),
  actualBlock: z.string().optional(),
  properties: z.record(z.unknown()),
  matchedExpected: z.boolean(),
})
export type WorldBlockObservation = z.infer<typeof worldBlockObservationSchema>

export const worldInspectionCaseSchema = z.object({
  caseIndex: z.number().int().nonnegative(),
  inputs: z.record(binarySchema),
  expectedOutputs: z.record(binarySchema),
  observedOutputs: z.record(outputValueSchema),
  observations: z.array(worldBlockObservationSchema),
  errors: z.array(runErrorSchema),
  inspectedAt: z.string(),
})
export type WorldInspectionCase = z.infer<typeof worldInspectionCaseSchema>

export const worldInspectionReportSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  taskSpecRef: versionRefSchema,
  layoutRef: versionRefSchema,
  buildRunRef: versionRefSchema,
  verificationReportRef: versionRefSchema,
  authoritative: z.boolean(),
  failedCases: z.array(worldInspectionCaseSchema),
  startedAt: z.string(),
  finishedAt: z.string(),
})
export type WorldInspectionReport = z.infer<typeof worldInspectionReportSchema>

export const sessionStateSchema = z.enum([
  'CREATED',
  'COLLECTING_REQUIREMENTS',
  'DESIGNING_LOGIC',
  'CHECKING_LOGIC',
  'AWAITING_DESIGN_REVIEW',
  'PLANNING_LAYOUT',
  'VALIDATING_LAYOUT',
  'READY_TO_BUILD',
  'BUILDING',
  'VERIFYING',
  'INSPECTING_WORLD',
  'AWAITING_LAYOUT_REPAIR', // Historical snapshots only; the post-verification repair loop is retired.
  'REVISING',
  'SUCCEEDED',
  'COMPLETED_NON_AUTHORITATIVE',
  'PAUSED',
  'FAILED',
  'CANCELLED',
])
export type SessionState = z.infer<typeof sessionStateSchema>

export const sessionEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().positive(),
  at: z.string(),
  type: z.string(),
  payload: z.unknown(),
  refs: z.array(versionRefSchema).optional(),
})
export type SessionEvent = z.infer<typeof sessionEventSchema>

export type LogicCheckIssue = {
  code: string
  message: string
  nodeId?: string
  caseIndex?: number
}

export type LogicCheckResult = {
  passed: boolean
  issues: LogicCheckIssue[]
  evaluatedCases: Array<{
    index: number
    expected: Record<string, Binary>
    actual: Record<string, Binary | 'unresolved'>
    passed: boolean
  }>
}

export type LayoutValidationIssue = {
  code: string
  message: string
  blockId?: string
  position?: Position
  actualBlock?: string
  allowedSupportBlocks?: string[]
}

export type LayoutSimulationCase = {
  index: number
  inputs: Record<string, Binary>
  expected: Record<string, Binary>
  actual: Record<string, OutputValue>
  passed: boolean
  states: string[]
  mismatches?: string[]
}

/**
 * Result of the deterministic pre-build redstone simulation. It never replaces
 * Minecraft verification; it only tells the agent which truth-table rows the
 * proposed layout would fail before the expensive world round trip.
 */
export type LayoutSimulationSummary = {
  evaluated: boolean
  reason?: string
  passedCases: number
  totalCases: number
  cases: LayoutSimulationCase[]
  observations: string[]
}

export type LayoutValidationResult = {
  passed: boolean
  issues: LayoutValidationIssue[]
  stats: { blocks: number; phases: number; mappedLogicIds: number }
  simulation?: LayoutSimulationSummary
}

export type BuildProgress = {
  runId: string
  placed: number
  total: number
  block: LayoutBlock
  worldPosition: Position
}

export type OutputReading = {
  value: OutputValue
  evidence: EvidenceRef[]
}

export type ArtifactBundle = {
  task?: TaskSpec
  logicDesign?: LogicDesign
  physicalLayout?: PhysicalLayout
  buildRun?: BuildRun
  verificationReport?: VerificationReport
  worldInspectionReport?: WorldInspectionReport
}

export type RunPolicy = {
  maxTaskVersions: number
  maxLogicVersions: number
  maxLayoutVersions: number
  /**
   * Run the deterministic redstone truth-table simulation inside layout
   * validation (default true). Only switch it off to diagnose a suspected
   * disagreement between the model and the real Minecraft server.
   */
  simulateLayouts?: boolean
}

export type ModelMode = 'openrouter' | 'fixture'

export type SessionSnapshot = {
  id: string
  state: SessionState
  mode: 'interactive' | 'benchmark'
  createdAt: string
  updatedAt: string
  request: string
  model: string
  modelMode: ModelMode
  minecraftMode: 'live' | 'mock'
  authoritative: boolean
  runPolicy: RunPolicy
  activity: string
  error?: RunError
  artifacts: ArtifactBundle
  latestSeq: number
  logicCheck?: LogicCheckResult
  layoutValidation?: LayoutValidationResult
  worldWorkspace?: { origin: Position; size: Size3D }
  worldView?: { available: boolean; origin?: Position; viewerUrl?: string; reason?: string }
  /**
   * Set when the build used a layout that failed simulation (failure-case
   * analysis). Such runs are not benchmark results, whatever Minecraft reports.
   */
  experimentalBuild?: {
    requestedAt: string
    layoutRef: { id: string; version: number }
    unresolvedIssueCodes: string[]
    simulatedPassedCases: number
    simulatedTotalCases: number
  }
}

/** One row of the session list. A full snapshot carries every artifact and runs to hundreds of KB. */
export type SessionSummary = Pick<
  SessionSnapshot,
  'id' | 'state' | 'mode' | 'createdAt' | 'updatedAt' | 'model' | 'modelMode'
> & {
  title: string
  /** The build used a layout that failed simulation (see SessionSnapshot.experimentalBuild). */
  experimentalBuild?: boolean
}

// The message on artifact actions is only a one-line chat summary; models
// sometimes omit it, and that must not cost a whole session.
const optionalActionMessage = z.string().default('')

export const proposeTaskSpecActionSchema = z.object({
  type: z.literal('propose_task_spec'),
  taskSpec: taskSpecDraftSchema,
  message: optionalActionMessage,
})

export const proposeLogicDesignActionSchema = z.object({
  type: z.literal('propose_logic_design'),
  design: logicDesignDraftSchema,
  message: optionalActionMessage,
})

export const proposeLayoutActionSchema = z.object({
  type: z.literal('propose_layout'),
  layout: physicalLayoutDraftSchema,
  message: optionalActionMessage,
})

export const layoutRepairPatchSchema = z.object({
  baseVersion: z.number().int().positive(),
  bounds: size3DSchema.optional(),
  upsertBlocks: z.array(layoutBlockSchema),
  removeBlockIds: z.array(z.string().min(1)),
  explanation: layoutExplanationSchema,
  changeSummary: changeSummarySchema,
}).superRefine((patch, context) => {
  const upsertIds = patch.upsertBlocks.map((block) => block.id)
  const duplicateUpsertIds = upsertIds.filter((id, index) => upsertIds.indexOf(id) !== index)
  for (const id of new Set(duplicateUpsertIds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['upsertBlocks'], message: `Duplicate upsert block id ${id}` })
  }
  const duplicateRemoveIds = patch.removeBlockIds.filter((id, index) => patch.removeBlockIds.indexOf(id) !== index)
  for (const id of new Set(duplicateRemoveIds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['removeBlockIds'], message: `Duplicate remove block id ${id}` })
  }
  const removed = new Set(patch.removeBlockIds)
  for (const id of upsertIds) {
    if (removed.has(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['upsertBlocks'], message: `Block ${id} cannot be removed and upserted in one patch` })
    }
  }
})
export type LayoutRepairPatch = z.infer<typeof layoutRepairPatchSchema>

export const repairLayoutActionSchema = z.object({
  type: z.literal('repair_layout'),
  patch: layoutRepairPatchSchema,
  message: optionalActionMessage,
})

export const replyActionSchema = z.object({
  type: z.literal('reply'),
  message: z.string(),
  refs: z.array(versionRefSchema).optional(),
})

export const reportBlockerActionSchema = z.object({
  type: z.literal('report_blocker'),
  code: z.string(),
  message: z.string(),
})

export const agentActionSchema = z.discriminatedUnion('type', [
  proposeTaskSpecActionSchema,
  proposeLogicDesignActionSchema,
  proposeLayoutActionSchema,
  repairLayoutActionSchema,
  replyActionSchema,
  reportBlockerActionSchema,
])
export type AgentAction = z.infer<typeof agentActionSchema>

export function versionRef(artifact: { id: string; version: number }): VersionRef {
  return { id: artifact.id, version: artifact.version }
}

export function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}
