import { describe, expect, it } from 'vitest'
import {
  logicDesignSchema,
  physicalLayoutSchema,
  taskSpecSchema,
  type PhysicalLayout,
} from '@domain/domain'
import { blockCapability } from '@domain/block-capabilities'
import { compareLayoutValidations, DeterministicLayoutValidator, issueCounts } from './layout-validator'

const task = taskSpecSchema.parse({
  id: 'task-support',
  version: 1,
  title: 'Support capability test',
  description: 'Validate a floor lever with an explicit support block.',
  inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 2, z: 1 }, facing: 'north' } }],
  outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 2, y: 1, z: 1 }, facing: 'east' } }],
  truthTable: [
    { inputs: { A: 0 }, outputs: { Y: 0 } },
    { inputs: { A: 1 }, outputs: { Y: 1 } },
  ],
  workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 4, z: 3 } },
  allowedBlocks: [
    'minecraft:polished_andesite',
    'minecraft:redstone_wire',
    'minecraft:lever',
    'minecraft:redstone_lamp',
  ],
  maxBlocks: 8,
  acceptance: { requireAllCases: true, stableReads: 2 },
})

const design = logicDesignSchema.parse({
  id: 'logic-support',
  version: 1,
  taskSpecRef: { id: task.id, version: task.version },
  nodes: [
    { id: 'A', kind: 'input', label: 'A' },
    { id: 'Y', kind: 'output', label: 'Y' },
  ],
  edges: [{ id: 'e1', from: 'A', to: 'Y', signal: 'A' }],
  equations: { Y: 'A' },
  explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
})

function layout(support: 'minecraft:polished_andesite' | 'minecraft:redstone_wire' | undefined): PhysicalLayout {
  return physicalLayoutSchema.parse({
    id: 'layout-support',
    version: 1,
    logicDesignRef: { id: design.id, version: design.version },
    bounds: { x: 4, y: 4, z: 3 },
    blocks: [
      {
        id: 'support-base',
        block: 'minecraft:polished_andesite',
        position: { x: 1, y: 0, z: 1 },
        properties: {},
        implements: ['e1'],
      },
      ...(support ? [{
        id: 'lever-support',
        block: support,
        position: { x: 1, y: 1, z: 1 },
        properties: {},
        implements: ['e1'],
      }] : []),
      {
        id: 'lever-A',
        block: 'minecraft:lever',
        position: { x: 1, y: 2, z: 1 },
        properties: { face: 'floor', facing: 'north' },
        implements: ['A', 'e1'],
      },
      {
        id: 'lamp-Y',
        block: 'minecraft:redstone_lamp',
        position: { x: 2, y: 1, z: 1 },
        properties: {},
        implements: ['Y'],
      },
    ],
    explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
  })
}

describe('DeterministicLayoutValidator support capabilities', () => {
  it('rejects TaskSpec block names that have no shared capability definition', () => {
    const result = taskSpecSchema.safeParse({
      ...task,
      allowedBlocks: [...task.allowedBlocks, 'minecraft:dirt'],
    })

    expect(result.success).toBe(false)
  })

  it('accepts polished andesite as a solid support block', async () => {
    expect(blockCapability('minecraft:polished_andesite')).toMatchObject({ solidSupport: true })

    const result = await new DeterministicLayoutValidator().validate(
      task,
      design,
      layout('minecraft:polished_andesite'),
    )

    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('accepts the generated grassland at y=-1 as support for a floor component at y=0', async () => {
    const groundTask = taskSpecSchema.parse({
      ...task,
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 0, z: 1 }, facing: 'north' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 3, y: 0, z: 1 }, facing: 'east' } }],
    })
    const groundLayout = physicalLayoutSchema.parse({
      id: 'layout-ground',
      version: 1,
      logicDesignRef: { id: design.id, version: design.version },
      bounds: { x: 4, y: 4, z: 3 },
      blocks: [
        {
          id: 'lever-A',
          block: 'minecraft:lever',
          position: { x: 1, y: 0, z: 1 },
          properties: { face: 'floor', facing: 'north' },
          implements: ['A', 'e1'],
        },
        {
          id: 'wire-Y',
          block: 'minecraft:redstone_wire',
          position: { x: 2, y: 0, z: 1 },
          properties: {},
          implements: ['e1'],
        },
        {
          id: 'lamp-Y',
          block: 'minecraft:redstone_lamp',
          position: { x: 3, y: 0, z: 1 },
          properties: {},
          implements: ['Y'],
        },
      ],
      explanation: { overview: 'ground support', criticalOrientations: [], routingNotes: [] },
    })

    const result = await new DeterministicLayoutValidator().validate(groundTask, design, groundLayout)

    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.simulation).toMatchObject({ evaluated: true, passedCases: 2, totalCases: 2 })
  })

  it('rejects a structurally clean layout whose wire cannot light the lamp above it', async () => {
    const groundTask = taskSpecSchema.parse({
      ...task,
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 0, z: 1 }, facing: 'north' } }],
    })
    const groundLayout = physicalLayoutSchema.parse({
      id: 'layout-ground-broken',
      version: 1,
      logicDesignRef: { id: design.id, version: design.version },
      bounds: { x: 4, y: 4, z: 3 },
      blocks: [
        { id: 'lever-A', block: 'minecraft:lever', position: { x: 1, y: 0, z: 1 }, properties: { face: 'floor', facing: 'north' }, implements: ['A', 'e1'] },
        { id: 'lamp-Y', block: 'minecraft:redstone_lamp', position: { x: 2, y: 1, z: 1 }, properties: {}, implements: ['Y'] },
        { id: 'wire-Y', block: 'minecraft:redstone_wire', position: { x: 2, y: 0, z: 1 }, properties: {}, implements: ['e1'] },
      ],
      explanation: { overview: 'wire under lamp', criticalOrientations: [], routingNotes: [] },
    })

    const result = await new DeterministicLayoutValidator().validate(groundTask, design, groundLayout)

    expect(result.passed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(['SIMULATED_CASE_MISMATCH'])
    expect(result.issues[0].message).toContain('row 1 (A=1) would give Y=0')
    expect(result.issues[0].message).toContain('never powers the block above')
    expect(result.simulation).toMatchObject({ evaluated: true, passedCases: 1, totalCases: 2 })
    expect(result.simulation?.cases[1].states.join('\n')).toContain('wire-Y=15')
    expect(result.simulation?.cases[1].mismatches?.join('\n')).toContain('never powers the block above')
  })

  it('does not simulate while blocks would float or collide, and says so', async () => {
    const result = await new DeterministicLayoutValidator().validate(task, design, layout(undefined))

    expect(result.issues.some((issue) => issue.code === 'MISSING_SUPPORT')).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'SIMULATED_CASE_MISMATCH')).toBe(false)
    expect(result.simulation).toMatchObject({ evaluated: false })
    expect(result.simulation?.reason).toContain('MISSING_SUPPORT')
  })

  it('explains wall-mount facing when the intended wall sits on the opposite side', async () => {
    const notTask = taskSpecSchema.parse({
      ...task,
      id: 'task-facing-hint',
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 1, z: 0 }, facing: 'east' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 4, y: 1, z: 0 }, facing: 'west' } }],
      truthTable: [
        { inputs: { A: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 1 }, outputs: { Y: 0 } },
      ],
      workspace: { ...task.workspace, size: { x: 5, y: 4, z: 3 } },
      allowedBlocks: [...task.allowedBlocks, 'minecraft:redstone_wall_torch'],
    })
    const notDesign = logicDesignSchema.parse({
      id: 'logic-facing-hint',
      version: 1,
      taskSpecRef: { id: notTask.id, version: notTask.version },
      nodes: [
        { id: 'A', kind: 'input', label: 'A' },
        { id: 'NOT_A', kind: 'not', label: 'NOT A' },
        { id: 'Y', kind: 'output', label: 'Y' },
      ],
      edges: [
        { id: 'e-in', from: 'A', to: 'NOT_A', signal: 'A' },
        { id: 'e-out', from: 'NOT_A', to: 'Y', signal: 'NOT A' },
      ],
      equations: { Y: 'NOT A' },
      explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
    })
    // The agent placed the wall at x=1 and wrote facing=west, believing that
    // "faces west" means "hangs on the west block"; the torch actually hangs on x=3.
    const mirrored = physicalLayoutSchema.parse({
      id: 'layout-facing-hint',
      version: 1,
      logicDesignRef: { id: notDesign.id, version: notDesign.version },
      bounds: { x: 5, y: 4, z: 3 },
      blocks: [
        { id: 'lever-base', block: 'minecraft:polished_andesite', position: { x: 0, y: 0, z: 0 }, properties: {}, implements: ['A'] },
        { id: 'lever-A', block: 'minecraft:lever', position: { x: 0, y: 1, z: 0 }, properties: { face: 'floor', facing: 'east' }, implements: ['A', 'e-in'] },
        { id: 'wall', block: 'minecraft:polished_andesite', position: { x: 1, y: 1, z: 0 }, properties: {}, implements: ['e-in'] },
        { id: 'torch-NOT-A', block: 'minecraft:redstone_wall_torch', position: { x: 2, y: 1, z: 0 }, properties: { facing: 'west' }, implements: ['NOT_A', 'e-out'] },
        { id: 'lamp-base', block: 'minecraft:polished_andesite', position: { x: 4, y: 0, z: 0 }, properties: {}, implements: ['Y'] },
        { id: 'lamp-Y', block: 'minecraft:redstone_lamp', position: { x: 4, y: 1, z: 0 }, properties: {}, implements: ['Y'] },
      ],
      explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
    })

    const result = await new DeterministicLayoutValidator().validate(notTask, notDesign, mirrored)
    const issue = result.issues.find((candidate) => candidate.blockId === 'torch-NOT-A' && candidate.code === 'MISSING_SUPPORT')

    expect(issue?.message).toContain('facing=west means this component faces west and hangs on the block on its east (x+1) side')
    expect(issue?.message).toContain('wall at 1,1,0 is on the opposite side')
    expect(issue?.message).toContain('use facing=east')
  })

  it('reports MISSING_SUPPORT when the target coordinate has no block', async () => {
    const result = await new DeterministicLayoutValidator().validate(task, design, layout(undefined))
    const issue = result.issues.find((candidate) => candidate.blockId === 'lever-A')

    expect(issue).toMatchObject({
      code: 'MISSING_SUPPORT',
      position: { x: 1, y: 1, z: 1 },
      actualBlock: 'minecraft:air',
    })
    expect(issue?.allowedSupportBlocks).toContain('minecraft:polished_andesite')
    expect(issue?.message).toContain('1,1,1')
    expect(issue?.message).toContain('minecraft:air')
    expect(issue?.message).toContain('minecraft:polished_andesite')
  })

  it('reports INVALID_SUPPORT_BLOCK when a present block cannot provide support', async () => {
    const result = await new DeterministicLayoutValidator().validate(
      task,
      design,
      layout('minecraft:redstone_wire'),
    )
    const issue = result.issues.find((candidate) => candidate.blockId === 'lever-A')

    expect(issue).toMatchObject({
      code: 'INVALID_SUPPORT_BLOCK',
      position: { x: 1, y: 1, z: 1 },
      actualBlock: 'minecraft:redstone_wire',
    })
    expect(issue?.allowedSupportBlocks).toContain('minecraft:polished_andesite')
    expect(issue?.message).toContain('1,1,1')
    expect(issue?.message).toContain('minecraft:redstone_wire')
    expect(issue?.message).toContain('minecraft:polished_andesite')
    expect(result.issues.some((candidate) => candidate.code === 'MISSING_SUPPORT')).toBe(false)
  })

  it('reports an explicit fixed-port exclusivity error in addition to a generic collision', async () => {
    const candidate = layout('minecraft:polished_andesite')
    candidate.blocks.push({
      id: 'wire-on-output-port',
      block: 'minecraft:redstone_wire',
      position: { ...task.outputs[0].port.position },
      properties: {},
      implements: ['e1'],
    })

    const result = await new DeterministicLayoutValidator().validate(task, design, candidate)

    expect(result.issues.some((issue) => issue.code === 'DUPLICATE_POSITION')).toBe(true)
    expect(result.issues.find((issue) => issue.code === 'OUTPUT_PORT_NOT_EXCLUSIVE')?.message)
      .toContain('wire-on-output-port')
  })

  it('rejects a NOT torch whose attachment block does not carry the incoming edge', async () => {
    const notTask = taskSpecSchema.parse({
      ...task,
      id: 'task-not-disconnected',
      description: 'NOT gate semantic validation',
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 1, z: 1 }, facing: 'north' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 4, y: 1, z: 1 }, facing: 'east' } }],
      truthTable: [
        { inputs: { A: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 1 }, outputs: { Y: 0 } },
      ],
      workspace: { ...task.workspace, size: { x: 6, y: 4, z: 3 } },
      allowedBlocks: [...task.allowedBlocks, 'minecraft:redstone_torch'],
      maxBlocks: 12,
    })
    const notDesign = logicDesignSchema.parse({
      id: 'logic-not-disconnected',
      version: 1,
      taskSpecRef: { id: notTask.id, version: notTask.version },
      nodes: [
        { id: 'A', kind: 'input', label: 'A' },
        { id: 'NOT_A', kind: 'not', label: 'NOT A' },
        { id: 'Y', kind: 'output', label: 'Y' },
      ],
      edges: [
        { id: 'e-in', from: 'A', to: 'NOT_A', signal: 'A' },
        { id: 'e-out', from: 'NOT_A', to: 'Y', signal: 'NOT A' },
      ],
      equations: { Y: 'NOT A' },
      explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
    })
    const notLayout = physicalLayoutSchema.parse({
      id: 'layout-not-disconnected',
      version: 1,
      logicDesignRef: { id: notDesign.id, version: notDesign.version },
      bounds: { x: 6, y: 4, z: 3 },
      blocks: [
        { id: 'input-support', block: 'minecraft:polished_andesite', position: { x: 1, y: 0, z: 1 }, properties: {}, implements: ['A', 'e-in'] },
        { id: 'lever-A', block: 'minecraft:lever', position: { x: 1, y: 1, z: 1 }, properties: { face: 'floor' }, implements: ['A'] },
        { id: 'torch-support', block: 'minecraft:polished_andesite', position: { x: 2, y: 0, z: 1 }, properties: {}, implements: ['NOT_A'] },
        { id: 'torch-NOT-A', block: 'minecraft:redstone_torch', position: { x: 2, y: 1, z: 1 }, properties: {}, implements: ['NOT_A', 'e-out'] },
        { id: 'wire-support', block: 'minecraft:polished_andesite', position: { x: 3, y: 0, z: 1 }, properties: {}, implements: ['e-out'] },
        { id: 'wire-Y', block: 'minecraft:redstone_wire', position: { x: 3, y: 1, z: 1 }, properties: {}, implements: ['e-out'] },
        { id: 'lamp-Y', block: 'minecraft:redstone_lamp', position: { x: 4, y: 1, z: 1 }, properties: {}, implements: ['Y'] },
      ],
      explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
    })

    const result = await new DeterministicLayoutValidator().validate(notTask, notDesign, notLayout)

    expect(result.issues.find((issue) => issue.code === 'INVERTER_INPUT_DISCONNECTED')).toMatchObject({
      blockId: 'torch-NOT-A',
      position: { x: 2, y: 0, z: 1 },
    })
    // The torch base is never powered, so the torch stays lit and A=1 still
    // lights the lamp. The simulation names the row and the constant torch.
    const mismatch = result.issues.find((issue) => issue.code === 'SIMULATED_CASE_MISMATCH')
    expect(mismatch?.message).toContain('row 1 (A=1) would give Y=1')
    expect(mismatch?.message).toContain('torch-NOT-A stays LIT in every case')
    expect(result.simulation).toMatchObject({ evaluated: true, passedCases: 1, totalCases: 2 })

    const diagonalOutput = structuredClone(notLayout)
    diagonalOutput.blocks.find((block) => block.id === 'torch-support')!.position = { x: 2, y: 1, z: 1 }
    diagonalOutput.blocks.find((block) => block.id === 'torch-support')!.implements = ['e-in', 'NOT_A']
    diagonalOutput.blocks.find((block) => block.id === 'torch-NOT-A')!.position = { x: 2, y: 2, z: 1 }
    const diagonalResult = await new DeterministicLayoutValidator().validate(notTask, notDesign, diagonalOutput)

    // The raised torch is diagonal to the output wire, so nothing ever lights Y.
    const diagonalMismatch = diagonalResult.issues.find((issue) => issue.code === 'SIMULATED_CASE_MISMATCH')
    expect(diagonalMismatch?.message).toContain('row 0 (A=0) would give Y=0')
    expect(diagonalMismatch?.message).toContain('torch-NOT-A output reaches nothing')
    expect(diagonalResult.issues.some((issue) => issue.code === 'INVERTER_INPUT_NOT_DIRECTLY_POWERED')).toBe(false)
    expect(diagonalResult.issues.some((issue) => issue.code === 'INVERTER_OUTPUT_DISCONNECTED')).toBe(false)
  })

  it('lets a simulation-verified circuit through even when a positional heuristic disagrees', async () => {
    // NAND built as (NOT A) OR (NOT B): the merge wire is already the answer and
    // lights the lamp through the weakly powered block beneath it. The agent
    // tagged that block with the input edges, not the output edge, so the
    // OUTPUT_SIGNAL_DISCONNECTED heuristic fires although Minecraft agrees with
    // the simulation that the circuit is correct.
    const nandTask = taskSpecSchema.parse({
      ...task,
      id: 'task-nand-verified',
      inputs: [
        { id: 'A', label: 'A', port: { position: { x: 1, y: 1, z: 1 }, facing: 'north' } },
        { id: 'B', label: 'B', port: { position: { x: 4, y: 1, z: 1 }, facing: 'north' } },
      ],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 3, y: 0, z: 5 }, facing: 'up' } }],
      truthTable: [
        { inputs: { A: 0, B: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 0, B: 1 }, outputs: { Y: 1 } },
        { inputs: { A: 1, B: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 1, B: 1 }, outputs: { Y: 0 } },
      ],
      workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 7, y: 4, z: 7 } },
      allowedBlocks: ['minecraft:stone', 'minecraft:lever', 'minecraft:redstone_wall_torch', 'minecraft:redstone_wire', 'minecraft:redstone_lamp'],
      maxBlocks: 30,
    })
    const nandDesign = logicDesignSchema.parse({
      id: 'logic-nand-verified',
      version: 1,
      taskSpecRef: { id: nandTask.id, version: 1 },
      nodes: [
        { id: 'A', kind: 'input', label: 'A' },
        { id: 'B', kind: 'input', label: 'B' },
        { id: 'nand1', kind: 'nand', label: 'NAND' },
        { id: 'Y', kind: 'output', label: 'Y' },
      ],
      edges: [
        { id: 'e1', from: 'A', to: 'nand1', signal: 'A' },
        { id: 'e2', from: 'B', to: 'nand1', signal: 'B' },
        { id: 'e3', from: 'nand1', to: 'Y', signal: 'NAND' },
      ],
      equations: { Y: 'NOT (A AND B)' },
      explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
    })
    const blocks = [
      ['leverA', 'minecraft:lever', [1, 1, 1], { face: 'wall', facing: 'north' }, ['A']],
      ['leverB', 'minecraft:lever', [4, 1, 1], { face: 'wall', facing: 'north' }, ['B']],
      ['supportA', 'minecraft:stone', [1, 1, 2], {}, ['A', 'e1']],
      ['supportB', 'minecraft:stone', [4, 1, 2], {}, ['B', 'e2']],
      ['torchA', 'minecraft:redstone_wall_torch', [1, 1, 3], { facing: 'south' }, ['e1', 'nand1']],
      ['torchB', 'minecraft:redstone_wall_torch', [4, 1, 3], { facing: 'south' }, ['e2', 'nand1']],
      ['wireA', 'minecraft:redstone_wire', [1, 1, 4], {}, ['e1']],
      ['wireB', 'minecraft:redstone_wire', [4, 1, 4], {}, ['e2']],
      ['wireMerge1', 'minecraft:redstone_wire', [2, 1, 4], {}, ['e1', 'e2']],
      ['wireMerge2', 'minecraft:redstone_wire', [3, 1, 4], {}, ['e1', 'e2']],
      ['lampY', 'minecraft:redstone_lamp', [3, 0, 5], {}, ['Y']],
      ['supportWireA', 'minecraft:stone', [1, 0, 4], {}, ['e1']],
      ['supportWireB', 'minecraft:stone', [4, 0, 4], {}, ['e2']],
      ['supportWireMerge1', 'minecraft:stone', [2, 0, 4], {}, ['e1', 'e2']],
      ['supportWireMerge2', 'minecraft:stone', [3, 0, 4], {}, ['e1', 'e2', 'e3']],
    ] as const
    const nandLayout = physicalLayoutSchema.parse({
      id: 'layout-nand-verified',
      version: 1,
      logicDesignRef: { id: nandDesign.id, version: 1 },
      bounds: { x: 7, y: 4, z: 7 },
      blocks: blocks.map(([id, block, [x, y, z], properties, logicIds]) => ({ id, block, position: { x, y, z }, properties, implements: [...logicIds] })),
      explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
    })

    const tagged = await new DeterministicLayoutValidator().validate(nandTask, nandDesign, nandLayout)
    expect(tagged.passed).toBe(true)
    expect(tagged.simulation).toMatchObject({ evaluated: true, passedCases: 4, totalCases: 4 })

    const mistagged = structuredClone(nandLayout)
    mistagged.blocks.find((block) => block.id === 'supportWireMerge2')!.implements = ['e1', 'e2']
    mistagged.blocks.find((block) => block.id === 'lampY')!.implements = ['Y', 'e3']
    const result = await new DeterministicLayoutValidator().validate(nandTask, nandDesign, mistagged)
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])

    const structuralOnly = await new DeterministicLayoutValidator({ simulate: false }).validate(nandTask, nandDesign, mistagged)
    expect(structuralOnly.issues.map((issue) => issue.code)).toEqual(['OUTPUT_SIGNAL_DISCONNECTED'])
  })

  it('tells the agent how a wire is shaped and which net it belongs to', async () => {
    const orTask = taskSpecSchema.parse({
      ...task,
      id: 'task-or-shape',
      inputs: [
        { id: 'A', label: 'A', port: { position: { x: 0, y: 0, z: 1 }, facing: 'north' } },
        { id: 'B', label: 'B', port: { position: { x: 0, y: 0, z: 5 }, facing: 'north' } },
      ],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 5, y: 0, z: 3 }, facing: 'up' } }],
      truthTable: [
        { inputs: { A: 0, B: 0 }, outputs: { Y: 0 } },
        { inputs: { A: 0, B: 1 }, outputs: { Y: 1 } },
        { inputs: { A: 1, B: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 1, B: 1 }, outputs: { Y: 1 } },
      ],
      workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 7, y: 4, z: 7 } },
      maxBlocks: 30,
    })
    const orDesign = logicDesignSchema.parse({
      id: 'logic-or-shape',
      version: 1,
      taskSpecRef: { id: orTask.id, version: 1 },
      nodes: [
        { id: 'A', kind: 'input', label: 'A' },
        { id: 'B', kind: 'input', label: 'B' },
        { id: 'OR1', kind: 'or', label: 'OR' },
        { id: 'Y', kind: 'output', label: 'Y' },
      ],
      edges: [
        { id: 'eA', from: 'A', to: 'OR1', signal: 'A' },
        { id: 'eB', from: 'B', to: 'OR1', signal: 'B' },
        { id: 'eY', from: 'OR1', to: 'Y', signal: 'A OR B' },
      ],
      equations: { Y: 'A OR B' },
      explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
    })
    const wire = (id: string, x: number, z: number, implementsIds: string[]) => ({
      id, block: 'minecraft:redstone_wire', position: { x, y: 0, z }, properties: {}, implements: implementsIds,
    })
    // Both branches meet in a north-south line at x=4 that runs past the lamp.
    const sideways = physicalLayoutSchema.parse({
      id: 'layout-or-sideways',
      version: 1,
      logicDesignRef: { id: orDesign.id, version: 1 },
      bounds: { x: 7, y: 4, z: 7 },
      blocks: [
        { id: 'leverA', block: 'minecraft:lever', position: { x: 0, y: 0, z: 1 }, properties: { face: 'floor' }, implements: ['A'] },
        { id: 'leverB', block: 'minecraft:lever', position: { x: 0, y: 0, z: 5 }, properties: { face: 'floor' }, implements: ['B'] },
        wire('a1', 1, 1, ['eA']), wire('a2', 2, 1, ['eA']), wire('a3', 3, 1, ['eA']), wire('a4', 4, 1, ['eA']),
        wire('m2', 4, 2, ['OR1']), wire('m3', 4, 3, ['OR1', 'eY']), wire('m4', 4, 4, ['OR1']),
        wire('b1', 1, 5, ['eB']), wire('b2', 2, 5, ['eB']), wire('b3', 3, 5, ['eB']), wire('b4', 4, 5, ['eB']),
        { id: 'lampY', block: 'minecraft:redstone_lamp', position: { x: 5, y: 0, z: 3 }, properties: {}, implements: ['Y'] },
      ],
      explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
    })
    const sidewaysResult = await new DeterministicLayoutValidator().validate(orTask, orDesign, sideways)
    const sidewaysMessage = sidewaysResult.issues.find((issue) => issue.code === 'SIMULATED_CASE_MISMATCH')?.message ?? ''
    expect(sidewaysMessage).toContain('m3@4,0,3 runs alongside')
    expect(sidewaysMessage).toContain('attaches to north (m2@4,0,2) and south (m4@4,0,4)')
    expect(sidewaysMessage).toContain('straight line pointing north/south')
    expect(sidewaysMessage).toContain('would point east only if it had no north or south attachments')

    // The merge points into the lamp, but branch A stops one block short of it.
    const disconnected = physicalLayoutSchema.parse({
      ...sideways,
      id: 'layout-or-disconnected',
      blocks: [
        ...sideways.blocks.filter((block) => !['a4', 'm2', 'm4'].includes(block.id)),
        wire('m1', 3, 3, ['OR1']),
        wire('mb', 3, 4, ['eB']),
      ],
    })
    const disconnectedResult = await new DeterministicLayoutValidator().validate(orTask, orDesign, disconnected)
    const disconnectedMessage = disconnectedResult.issues.find((issue) => issue.code === 'SIMULATED_CASE_MISMATCH')?.message ?? ''
    expect(disconnectedMessage).toContain('row 2 (A=1,B=0)')
    expect(disconnectedMessage).toContain('m3@4,0,3 points in but has power 0')
    expect(disconnectedMessage).toContain('its net {m3, m1, mb, b3')
    expect(disconnectedMessage).toContain('powered wires in this row (a1=15, a2=14, a3=13) are not joined to this net')
  })

  it('accepts a wire-driven inverter base that the old positional heuristic rejected', async () => {
    const notTask = taskSpecSchema.parse({
      ...task,
      id: 'task-not-wire-driven',
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 0, z: 0 }, facing: 'north' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 5, y: 0, z: 0 }, facing: 'east' } }],
      truthTable: [
        { inputs: { A: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 1 }, outputs: { Y: 0 } },
      ],
      workspace: { ...task.workspace, size: { x: 6, y: 4, z: 3 } },
      allowedBlocks: [...task.allowedBlocks, 'minecraft:redstone_torch'],
      maxBlocks: 12,
    })
    const notDesign = logicDesignSchema.parse({
      id: 'logic-not-wire-driven',
      version: 1,
      taskSpecRef: { id: notTask.id, version: notTask.version },
      nodes: [
        { id: 'A', kind: 'input', label: 'A' },
        { id: 'NOT_A', kind: 'not', label: 'NOT A' },
        { id: 'Y', kind: 'output', label: 'Y' },
      ],
      edges: [
        { id: 'e-in', from: 'A', to: 'NOT_A', signal: 'A' },
        { id: 'e-out', from: 'NOT_A', to: 'Y', signal: 'NOT A' },
      ],
      equations: { Y: 'NOT A' },
      explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
    })
    // lever -> wire -> wire pointing into the torch base -> floor torch -> wire -> lamp
    const wireDriven = physicalLayoutSchema.parse({
      id: 'layout-not-wire-driven',
      version: 1,
      logicDesignRef: { id: notDesign.id, version: notDesign.version },
      bounds: { x: 6, y: 4, z: 3 },
      blocks: [
        { id: 'lever-A', block: 'minecraft:lever', position: { x: 0, y: 0, z: 0 }, properties: { face: 'floor', facing: 'north' }, implements: ['A'] },
        { id: 'wire-in-1', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 0 }, properties: {}, implements: ['e-in'] },
        { id: 'wire-in-2', block: 'minecraft:redstone_wire', position: { x: 2, y: 0, z: 0 }, properties: {}, implements: ['e-in'] },
        { id: 'torch-base', block: 'minecraft:polished_andesite', position: { x: 3, y: 0, z: 0 }, properties: {}, implements: ['e-in', 'NOT_A'] },
        { id: 'torch-NOT-A', block: 'minecraft:redstone_torch', position: { x: 3, y: 1, z: 0 }, properties: {}, implements: ['NOT_A', 'e-out'] },
        { id: 'out-base', block: 'minecraft:polished_andesite', position: { x: 4, y: 0, z: 0 }, properties: {}, implements: ['e-out'] },
        { id: 'wire-out', block: 'minecraft:redstone_wire', position: { x: 4, y: 1, z: 0 }, properties: {}, implements: ['e-out'] },
        { id: 'lamp-Y', block: 'minecraft:redstone_lamp', position: { x: 5, y: 0, z: 0 }, properties: {}, implements: ['Y'] },
        { id: 'wire-lamp', block: 'minecraft:redstone_wire', position: { x: 5, y: 1, z: 0 }, properties: {}, implements: ['e-out'] },
      ],
      explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
    })

    const result = await new DeterministicLayoutValidator().validate(notTask, notDesign, wireDriven)

    expect(result.issues).toEqual([])
    expect(result.simulation).toMatchObject({ evaluated: true, passedCases: 2, totalCases: 2 })
  })

  it('rejects direct input power beside an output that must sometimes be low', async () => {
    const notTask = taskSpecSchema.parse({
      ...task,
      id: 'task-not-bypass',
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 0, z: 1 }, facing: 'north' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 2, y: 0, z: 1 }, facing: 'east' } }],
      truthTable: [
        { inputs: { A: 0 }, outputs: { Y: 1 } },
        { inputs: { A: 1 }, outputs: { Y: 0 } },
      ],
      allowedBlocks: [...task.allowedBlocks, 'minecraft:redstone_torch'],
    })
    const notDesign = logicDesignSchema.parse({
      id: 'logic-not-bypass',
      version: 1,
      taskSpecRef: { id: notTask.id, version: notTask.version },
      nodes: [
        { id: 'A', kind: 'input', label: 'A' },
        { id: 'NOT_A', kind: 'not', label: 'NOT A' },
        { id: 'Y', kind: 'output', label: 'Y' },
      ],
      edges: [
        { id: 'e-in', from: 'A', to: 'NOT_A', signal: 'A' },
        { id: 'e-out', from: 'NOT_A', to: 'Y', signal: 'NOT A' },
      ],
      equations: { Y: 'NOT A' },
      explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
    })
    const bypassLayout = physicalLayoutSchema.parse({
      id: 'layout-not-bypass',
      version: 1,
      logicDesignRef: { id: notDesign.id, version: notDesign.version },
      bounds: { x: 4, y: 3, z: 3 },
      blocks: [
        { id: 'lever-A', block: 'minecraft:lever', position: { x: 1, y: 0, z: 1 }, properties: { face: 'floor' }, implements: ['A', 'e-in'] },
        { id: 'lamp-Y', block: 'minecraft:redstone_lamp', position: { x: 2, y: 0, z: 1 }, properties: {}, implements: ['Y'] },
        { id: 'torch-NOT-A', block: 'minecraft:redstone_torch', position: { x: 3, y: 0, z: 1 }, properties: {}, implements: ['NOT_A', 'e-out'] },
      ],
      explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
    })

    const result = await new DeterministicLayoutValidator().validate(notTask, notDesign, bypassLayout)

    expect(result.issues.find((issue) => issue.code === 'INPUT_BYPASSES_LOGIC')).toMatchObject({
      blockId: 'lever-A',
      position: { x: 1, y: 0, z: 1 },
    })
  })

  it('ranks multi-output candidates by incorrect output bits before failed-row count', () => {
    const issues = [
      { code: 'SIMULATED_CASE_MISMATCH', message: 'row 0' },
      { code: 'SIMULATED_CASE_MISMATCH', message: 'row 1' },
    ]
    const partiallyImproved = {
      issues,
      simulation: {
        evaluated: true,
        passedCases: 0,
        totalCases: 2,
        observations: [],
        cases: [
          { index: 0, inputs: { A: 0 as const }, expected: { X: 0 as const, Y: 0 as const }, actual: { X: 1 as const, Y: 0 as const }, passed: false, states: [] },
          { index: 1, inputs: { A: 1 as const }, expected: { X: 1 as const, Y: 1 as const }, actual: { X: 1 as const, Y: 0 as const }, passed: false, states: [] },
        ],
      },
    }
    const bothOutputsWrong = {
      issues,
      simulation: {
        evaluated: true,
        passedCases: 0,
        totalCases: 2,
        observations: [],
        cases: [
          { index: 0, inputs: { A: 0 as const }, expected: { X: 0 as const, Y: 0 as const }, actual: { X: 1 as const, Y: 1 as const }, passed: false, states: [] },
          { index: 1, inputs: { A: 1 as const }, expected: { X: 1 as const, Y: 1 as const }, actual: { X: 0 as const, Y: 0 as const }, passed: false, states: [] },
        ],
      },
    }

    expect(issueCounts(partiallyImproved)).toMatchObject({ functional: 2, outputMismatches: 2 })
    expect(issueCounts(bothOutputsWrong)).toMatchObject({ functional: 2, outputMismatches: 4 })
    expect(compareLayoutValidations(partiallyImproved, bothOutputsWrong)).toBeLessThan(0)
  })
})
