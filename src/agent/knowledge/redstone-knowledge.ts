import { z } from 'zod'
import blockPhysics from './block-physics.json'
import circuitImplementations from './circuit-implementations.json'

const invalidPatternSchema = z.object({
  pattern: z.string().min(1),
  reason: z.string().min(1),
}).strict()

const verificationSchema = z.object({
  status: z.enum([
    'deterministic_registry_aligned',
    'vanilla_mechanics_reviewed',
    'world_truth_table_verified',
  ]),
  evidence: z.array(z.string().min(1)).min(1),
}).strict()

const blockPhysicsCardSchema = z.object({
  id: z.string().regex(/^physics\.[a-z0-9_.]+$/),
  category: z.enum(['block_physics', 'spatial_physics']),
  minecraftVersion: z.literal('1.20.4'),
  subject: z.string().min(1),
  appliesWhen: z.array(z.string().min(1)).min(1),
  facts: z.array(z.string().min(1)).min(1),
  relativeRules: z.array(z.object({
    when: z.string().min(1),
    conclusion: z.string().min(1),
  }).strict()).min(1),
  invariants: z.array(z.string().min(1)).min(1),
  invalidPatterns: z.array(invalidPatternSchema).min(1),
  verification: verificationSchema,
}).strict()

const circuitImplementationCardSchema = z.object({
  id: z.string().regex(/^implementation\.[a-z0-9_.]+$/),
  category: z.literal('physical_implementation'),
  minecraftVersion: z.literal('1.20.4'),
  logicalFunction: z.string().min(1),
  preconditions: z.array(z.string().min(1)).min(1),
  logicalIdentity: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  requiredConnections: z.array(z.string().min(1)).min(1),
  physicalInvariants: z.array(z.string().min(1)).min(1),
  invalidPatterns: z.array(invalidPatternSchema).min(1),
  verification: verificationSchema,
}).strict()

const knowledgeBaseSchema = z.object({
  schemaVersion: z.literal('mc-ic.redstone-knowledge.v1'),
  minecraftVersion: z.literal('1.20.4'),
  scope: z.literal('general_cross_task_knowledge'),
  blockPhysics: z.array(blockPhysicsCardSchema).min(1),
  circuitImplementations: z.array(circuitImplementationCardSchema).min(1),
}).strict().superRefine((knowledge, context) => {
  const ids = [...knowledge.blockPhysics, ...knowledge.circuitImplementations].map((card) => card.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Knowledge card IDs must be unique' })
  }
})

export const redstoneKnowledgeBase = knowledgeBaseSchema.parse({
  schemaVersion: 'mc-ic.redstone-knowledge.v1',
  minecraftVersion: '1.20.4',
  scope: 'general_cross_task_knowledge',
  blockPhysics,
  circuitImplementations,
})

// Keep provenance and verification metadata in the stored knowledge base, but
// omit fields that do not help the model solve a layout. The prompt projection
// remains general and identical across tasks while avoiding repeated per-card
// version/category text.
const redstonePromptKnowledge = {
  schemaVersion: redstoneKnowledgeBase.schemaVersion,
  minecraftVersion: redstoneKnowledgeBase.minecraftVersion,
  scope: redstoneKnowledgeBase.scope,
  blockPhysics: redstoneKnowledgeBase.blockPhysics.map((card) => ({
    id: card.id,
    subject: card.subject,
    facts: card.facts,
    relativeRules: card.relativeRules,
    invariants: card.invariants,
    invalidPatterns: card.invalidPatterns,
  })),
  circuitImplementations: redstoneKnowledgeBase.circuitImplementations.map((card) => ({
    id: card.id,
    logicalFunction: card.logicalFunction,
    preconditions: card.preconditions,
    logicalIdentity: card.logicalIdentity,
    roles: card.roles,
    requiredConnections: card.requiredConnections,
    physicalInvariants: card.physicalInvariants,
    invalidPatterns: card.invalidPatterns,
  })),
}

export const REDSTONE_KNOWLEDGE_PROMPT = `GENERAL MINECRAFT REDSTONE KNOWLEDGE BASE
This versioned knowledge is identical across tasks. It contains no current session IDs, artifact IDs, port coordinates, workspace dimensions, or validation feedback.
Apply the relevant general facts and physical implementation knowledge to the active TaskSpec and LogicDesign yourself. Physics facts and invariants are authoritative. Circuit implementation cards describe symbolic physical topology, never fixed coordinates. Do not copy symbolic role names into implements; implements entries must use only active LogicDesign node or edge IDs. If a card's preconditions cannot be satisfied with the active allowedBlocks and workspace, return a report_blocker instead of inventing unavailable blocks.
<redstone_knowledge_json>
${JSON.stringify(redstonePromptKnowledge)}
</redstone_knowledge_json>`

export type RedstoneKnowledgeBase = z.infer<typeof knowledgeBaseSchema>
