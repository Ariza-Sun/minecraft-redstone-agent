import { describe, expect, it } from 'vitest'
import {
  physicalLayoutSchema,
  taskSpecSchema,
  type PhysicalLayout,
  type TaskSpec,
} from '@domain/domain'
import { simulateTruthTable } from './redstone-simulator'

function layout(blocks: Array<Partial<PhysicalLayout['blocks'][number]> & { id: string; block: string; position: { x: number; y: number; z: number } }>): PhysicalLayout {
  return physicalLayoutSchema.parse({
    id: 'layout',
    version: 1,
    logicDesignRef: { id: 'logic', version: 1 },
    bounds: { x: 8, y: 4, z: 8 },
    blocks: blocks.map((block) => ({ properties: {}, implements: ['e'], ...block })),
    explanation: { overview: 'test', criticalOrientations: [], routingNotes: [] },
  })
}

const notTask = taskSpecSchema.parse({
  id: 'task',
  version: 1,
  title: 'NOT',
  description: 'NOT',
  inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 1, z: 0 }, facing: 'north' } }],
  outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 4, y: 0, z: 0 }, facing: 'up' } }],
  truthTable: [
    { inputs: { A: 0 }, outputs: { Y: 1 } },
    { inputs: { A: 1 }, outputs: { Y: 0 } },
  ],
  workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 8, y: 4, z: 8 } },
  allowedBlocks: ['minecraft:stone', 'minecraft:lever', 'minecraft:redstone_wall_torch', 'minecraft:redstone_torch', 'minecraft:redstone_wire', 'minecraft:redstone_lamp', 'minecraft:repeater'],
  maxBlocks: 40,
  acceptance: { requireAllCases: true, stableReads: 3 },
})

describe('redstone steady-state simulator', () => {
  it('treats an isolated default wire as a dot that only powers the block beneath it', () => {
    const task = taskSpecSchema.parse({
      ...notTask,
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 0, z: 0 }, facing: 'north' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 2, y: 0, z: 0 }, facing: 'up' } }],
      truthTable: [{ inputs: { A: 0 }, outputs: { Y: 0 } }, { inputs: { A: 1 }, outputs: { Y: 1 } }],
    })
    const leverBeside = layout([
      { id: 'lever', block: 'minecraft:lever', position: { x: 0, y: 0, z: 0 }, properties: { face: 'floor' }, implements: ['A'] },
      { id: 'wire', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 0 } },
      { id: 'lamp', block: 'minecraft:redstone_lamp', position: { x: 2, y: 0, z: 0 }, implements: ['Y'] },
    ])
    // The lever is a connectable neighbour, so the wire becomes an east-west
    // line whose far end points into the lamp.
    expect(simulateTruthTable(task, leverBeside).cases.map((item) => item.actual.Y)).toEqual([0, 1])

    const poweredBlockBeside = layout([
      { id: 'lever', block: 'minecraft:lever', position: { x: 0, y: 1, z: 0 }, properties: { face: 'floor' }, implements: ['A'] },
      { id: 'base', block: 'minecraft:stone', position: { x: 0, y: 0, z: 0 } },
      { id: 'wire', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 0 } },
      { id: 'lamp', block: 'minecraft:redstone_lamp', position: { x: 2, y: 0, z: 0 }, implements: ['Y'] },
    ])
    const raisedTask = taskSpecSchema.parse({
      ...task,
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 1, z: 0 }, facing: 'north' } }],
    })
    // Solid blocks are not connectable neighbours: a /setblock wire touching only
    // the powered block and the lamp stays a dot, carries power 15, and still
    // powers nothing sideways.
    const dotReport = simulateTruthTable(raisedTask, poweredBlockBeside)
    expect(dotReport.cases.map((item) => item.actual.Y)).toEqual([0, 0])
    expect(dotReport.cases[1].states.join('\n')).toContain('wire=15')

    const lampAbove = layout([
      { id: 'lever', block: 'minecraft:lever', position: { x: 0, y: 1, z: 0 }, properties: { face: 'floor' }, implements: ['A'] },
      { id: 'base', block: 'minecraft:stone', position: { x: 0, y: 0, z: 0 } },
      { id: 'w1', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 0 } },
      { id: 'w2', block: 'minecraft:redstone_wire', position: { x: 2, y: 0, z: 0 } },
      { id: 'lamp', block: 'minecraft:redstone_lamp', position: { x: 2, y: 1, z: 0 }, implements: ['Y'] },
    ])
    const aboveTask = taskSpecSchema.parse({
      ...raisedTask,
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 2, y: 1, z: 0 }, facing: 'up' } }],
    })
    // A powered wire never powers the block above itself.
    const aboveReport = simulateTruthTable(aboveTask, lampAbove)
    expect(aboveReport.cases.map((item) => item.actual.Y)).toEqual([0, 0])
    expect(aboveReport.cases[1].states.join('\n')).toContain('w2=14')
  })

  it('explains a torch whose attachment block is only passed by a wire', () => {
    const passing = layout([
      { id: 'lever', block: 'minecraft:lever', position: { x: 0, y: 1, z: 0 }, properties: { face: 'floor' }, implements: ['A'] },
      { id: 'base', block: 'minecraft:stone', position: { x: 0, y: 0, z: 0 } },
      { id: 'w1', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 0 } },
      { id: 'w2', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 1 } },
      { id: 'w3', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 2 } },
      { id: 'torch_base', block: 'minecraft:stone', position: { x: 2, y: 0, z: 2 } },
      { id: 'torch', block: 'minecraft:redstone_torch', position: { x: 2, y: 1, z: 2 } },
      { id: 'out_base', block: 'minecraft:stone', position: { x: 3, y: 0, z: 2 } },
      { id: 'out_wire', block: 'minecraft:redstone_wire', position: { x: 3, y: 1, z: 2 } },
      { id: 'lamp', block: 'minecraft:redstone_lamp', position: { x: 4, y: 0, z: 2 }, implements: ['Y'] },
      { id: 'lamp_top_wire', block: 'minecraft:redstone_wire', position: { x: 4, y: 1, z: 2 } },
    ])
    const task = taskSpecSchema.parse({
      ...notTask,
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 4, y: 0, z: 2 }, facing: 'up' } }],
    })
    const report = simulateTruthTable(task, passing)
    expect(report.cases.map((item) => item.actual.Y)).toEqual([1, 1])
    expect(report.observations.join('\n')).toContain('torch stays LIT in every case')
    expect(report.observations.join('\n')).toContain('does not point into this block')
  })

  it('models repeater direction as facing toward the input side', () => {
    const blocks = (facing: 'east' | 'west') => layout([
      { id: 'lever', block: 'minecraft:lever', position: { x: 0, y: 1, z: 0 }, properties: { face: 'floor' }, implements: ['A'] },
      { id: 'base', block: 'minecraft:stone', position: { x: 0, y: 0, z: 0 } },
      { id: 'w1', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 0 } },
      { id: 'rep', block: 'minecraft:repeater', position: { x: 2, y: 0, z: 0 }, properties: { facing } },
      { id: 'w2', block: 'minecraft:redstone_wire', position: { x: 3, y: 0, z: 0 } },
      { id: 'lamp', block: 'minecraft:redstone_lamp', position: { x: 4, y: 0, z: 0 }, implements: ['Y'] },
    ])
    const task = taskSpecSchema.parse({
      ...notTask,
      truthTable: [{ inputs: { A: 0 }, outputs: { Y: 0 } }, { inputs: { A: 1 }, outputs: { Y: 1 } }],
    })
    expect(simulateTruthTable(task, blocks('west')).cases.map((item) => item.actual.Y)).toEqual([0, 1])
    expect(simulateTruthTable(task, blocks('east')).cases.map((item) => item.actual.Y)).toEqual([0, 0])
  })

  it('burns out a torch that feeds back into its own attachment block, as vanilla does', () => {
    const loop = layout([
      { id: 'lever', block: 'minecraft:lever', position: { x: 1, y: 1, z: 1 }, properties: { face: 'floor' }, implements: ['A'] },
      { id: 'base', block: 'minecraft:stone', position: { x: 1, y: 0, z: 1 } },
      { id: 'torch', block: 'minecraft:redstone_wall_torch', position: { x: 2, y: 0, z: 1 }, properties: { facing: 'east' } },
      { id: 'w1', block: 'minecraft:redstone_wire', position: { x: 3, y: 0, z: 1 } },
      { id: 'w2', block: 'minecraft:redstone_wire', position: { x: 3, y: 0, z: 2 } },
      { id: 'w3', block: 'minecraft:redstone_wire', position: { x: 3, y: 0, z: 3 } },
      { id: 'w4', block: 'minecraft:redstone_wire', position: { x: 2, y: 0, z: 3 } },
      { id: 'w5', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 3 } },
      { id: 'w6', block: 'minecraft:redstone_wire', position: { x: 1, y: 0, z: 2 } },
      { id: 'lamp', block: 'minecraft:redstone_lamp', position: { x: 4, y: 0, z: 0 }, implements: ['Y'] },
    ])
    const loopTask = taskSpecSchema.parse({
      ...notTask,
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 1, z: 1 }, facing: 'north' } }],
    })
    const report = simulateTruthTable(loopTask, loop)
    // With A=0 the torch powers a wire loop whose last segment is a north-south
    // line pointing into the torch's own attachment block, so the torch keeps
    // switching itself off and on until Minecraft burns it out; the lamp then
    // reads a stable 0, exactly as the live server did for such layouts.
    expect(report.cases[0].converged).toBe(true)
    expect(report.cases[0].actual.Y).toBe(0)
    expect(report.cases[0].states.join('\n')).toContain('torch=BURNED OUT')
    expect(report.cases[0].mismatches.join('\n')).toContain('oscillated and burned out')
    expect(report.cases[0].mismatches.join('\n')).toContain("powers the torch's own attachment block base@1,0,1")
    expect(report.observations.join('\n')).toContain('torch oscillates and burns out in row (A=0)')
    expect(report.cases[1].converged).toBe(true)
    expect(report.cases[1].actual.Y).toBe(0)
  })
})
