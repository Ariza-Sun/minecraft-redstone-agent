import { describe, expect, it } from 'vitest'
import { logicDesignSchema, taskSpecSchema } from '@domain/domain'
import { DeterministicLogicChecker } from './logic-checker'

const task = taskSpecSchema.parse({
  id: 'task',
  version: 1,
  title: 'NOT',
  description: 'NOT gate',
  inputs: [{ id: 'A', label: 'A', port: { position: { x: 0, y: 1, z: 0 }, facing: 'north' } }],
  outputs: [{ id: 'Y', label: 'Y', port: { position: { x: 3, y: 1, z: 0 }, facing: 'east' } }],
  truthTable: [
    { inputs: { A: 0 }, outputs: { Y: 1 } },
    { inputs: { A: 1 }, outputs: { Y: 0 } },
  ],
  workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 5, y: 3, z: 3 } },
  allowedBlocks: ['minecraft:stone', 'minecraft:lever', 'minecraft:redstone_lamp'],
  maxBlocks: 10,
  acceptance: { requireAllCases: true, stableReads: 2 },
})

function design(kind: 'not' | 'output') {
  return logicDesignSchema.parse({
    id: 'logic',
    version: 1,
    taskSpecRef: { id: 'task', version: 1 },
    nodes: [
      { id: 'A', kind: 'input', label: 'A' },
      ...(kind === 'not' ? [{ id: 'N', kind: 'not' as const, label: 'NOT' }] : []),
      { id: 'Y', kind: 'output', label: 'Y' },
    ],
    edges: kind === 'not'
      ? [{ id: 'e1', from: 'A', to: 'N', signal: 'A' }, { id: 'e2', from: 'N', to: 'Y', signal: '!A' }]
      : [{ id: 'e1', from: 'A', to: 'Y', signal: 'A' }],
    equations: { Y: kind === 'not' ? 'Y = NOT A' : 'Y = A' },
    explanation: { overview: 'test', componentNotes: [], validationPlan: 'all rows' },
  })
}

describe('DeterministicLogicChecker', () => {
  it('evaluates the design graph against every TaskSpec row', async () => {
    const result = await new DeterministicLogicChecker().check(task, design('not'))
    expect(result.passed).toBe(true)
    expect(result.evaluatedCases.map((item) => item.actual.Y)).toEqual([1, 0])
  })

  it('reports objective mismatches instead of trusting the design explanation', async () => {
    const result = await new DeterministicLogicChecker().check(task, design('output'))
    expect(result.passed).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'TRUTH_TABLE_MISMATCH')).toBe(true)
  })
})
