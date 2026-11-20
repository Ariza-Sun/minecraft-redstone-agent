import { describe, expect, it } from 'vitest'
import type { ArtifactBundle } from '@domain/domain'
import { canRestartLayout, canReviseLayout, phaseIndex } from './phase'

const artifacts = { task: {} as never, logicDesign: {} as never, physicalLayout: {} as never }
const error = { code: 'LAYOUT_VALIDATION_FAILED', message: 'budget exhausted', recoverable: true }

describe('layout correction and phase display', () => {
  it('keeps early model failures at the stage whose artifact is missing', () => {
    const modelError = { code: 'MODEL_HTTP_ERROR', message: 'Forbidden', recoverable: false }
    expect(phaseIndex('FAILED', {}, modelError)).toBe(0)
    expect(phaseIndex('FAILED', { task: artifacts.task }, modelError)).toBe(1)
    expect(phaseIndex('FAILED', { task: artifacts.task, logicDesign: artifacts.logicDesign }, modelError)).toBe(2)
    expect(canRestartLayout('FAILED', modelError, {}, false)).toBe(false)
  })

  it('distinguishes layout revision from logic revision', () => {
    expect(phaseIndex('REVISING', {})).toBe(1)
    expect(phaseIndex('REVISING', artifacts)).toBe(2)
  })

  it('offers guidance before building for failed and passed layouts', () => {
    expect(canReviseLayout('FAILED', artifacts, error, true)).toBe(true)
    expect(canReviseLayout('READY_TO_BUILD', artifacts, undefined, true)).toBe(true)
    expect(canReviseLayout('PLANNING_LAYOUT', artifacts, undefined, true)).toBe(false)
    expect(canReviseLayout('READY_TO_BUILD', artifacts, undefined, false)).toBe(false)
    expect(canRestartLayout('FAILED', error, artifacts, true)).toBe(true)
    expect(phaseIndex('FAILED', artifacts, error)).toBe(2)
    expect(phaseIndex('READY_TO_BUILD', artifacts)).toBe(2)
  })

  it('shows failed acceptance on step five with no correction controls, including old sessions', () => {
    const world: ArtifactBundle = { ...artifacts, buildRun: {} as never, verificationReport: { passed: false } as never }
    for (const state of ['FAILED', 'AWAITING_LAYOUT_REPAIR', 'INSPECTING_WORLD'] as const) {
      expect(phaseIndex(state, world, { ...error, code: 'MINECRAFT_VERIFICATION_FAILED' })).toBe(4)
      expect(canReviseLayout(state, world, error, true)).toBe(false)
      expect(canRestartLayout(state, error, world, true)).toBe(false)
    }
  })
})
