import { describe, expect, it } from 'vitest'
import { taskSpecSchema } from '@domain/domain'
import { taskSemanticIssues } from './task-semantics'

const base = taskSpecSchema.parse({
  id: 'task',
  version: 1,
  title: 'NOT',
  description: 'NOT',
  inputs: [{ id: 'A', label: 'A', port: { position: { x: 1, y: 1, z: 2 }, facing: 'north' } }],
  outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 5, y: 0, z: 2 }, facing: 'up' } }],
  truthTable: [
    { inputs: { A: 0 }, outputs: { Y: 1 } },
    { inputs: { A: 1 }, outputs: { Y: 0 } },
  ],
  workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 7, y: 4, z: 5 } },
  allowedBlocks: ['minecraft:lever', 'minecraft:redstone_wall_torch', 'minecraft:redstone_wire', 'minecraft:redstone_lamp', 'minecraft:stone'],
  maxBlocks: 20,
  acceptance: { requireAllCases: true, stableReads: 3 },
})

describe('TaskSpec semantic checks', () => {
  it('requires a plain opaque solid block for attachment', () => {
    const issues = taskSemanticIssues(taskSpecSchema.parse({
      ...base,
      allowedBlocks: ['minecraft:lever', 'minecraft:redstone_wall_torch', 'minecraft:redstone_wire', 'minecraft:redstone_lamp', 'minecraft:glass'],
    }))
    expect(issues.join('\n')).toContain('plain opaque solid block')
  })

  it('rejects input and output ports that touch or share a coordinate', () => {
    const touching = taskSemanticIssues(taskSpecSchema.parse({
      ...base,
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 2, y: 0, z: 2 }, facing: 'up' } }],
    }))
    expect(touching.join('\n')).toContain('only 1 block(s) apart horizontally')

    const shared = taskSemanticIssues(taskSpecSchema.parse({
      ...base,
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 1, y: 1, z: 2 }, facing: 'up' } }],
    }))
    expect(shared.join('\n')).toContain('share the coordinate 1,1,2')
  })

  it('rejects a workspace too small for supports and routing', () => {
    const issues = taskSemanticIssues(taskSpecSchema.parse({
      ...base,
      inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 1, z: 0 }, facing: 'north' } }],
      outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 3, y: 0, z: 0 }, facing: 'up' } }],
      workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 2, z: 1 } },
    }))
    expect(issues.join('\n')).toContain('too small')
  })
})
