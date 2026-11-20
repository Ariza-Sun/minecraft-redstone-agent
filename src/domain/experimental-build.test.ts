import { describe, expect, it } from 'vitest'
import { FUNCTIONAL_ISSUE_CODES } from '@agent/tools/layout-validator'
import type { LayoutValidationResult } from './domain'
import { EXPERIMENTAL_BUILD_TOLERATED_CODES, experimentalBuildEligibility } from './experimental-build'

function validation(codes: string[], evaluated = true): LayoutValidationResult {
  return {
    passed: codes.length === 0,
    issues: codes.map((code) => ({ code, message: code })),
    stats: { blocks: 4, phases: 1, mappedLogicIds: 3 },
    simulation: { evaluated, passedCases: evaluated ? 1 : 0, totalCases: 2, cases: [], observations: [] },
  }
}

describe('experimental build eligibility', () => {
  it('tolerates every functional issue code the validator can emit', () => {
    for (const code of FUNCTIONAL_ISSUE_CODES) expect(EXPERIMENTAL_BUILD_TOLERATED_CODES.has(code)).toBe(true)
  })

  it('allows a layout whose only problems are simulated mismatches and superseded heuristics', () => {
    expect(experimentalBuildEligibility(validation(['SIMULATED_CASE_MISMATCH', 'OUTPUT_SIGNAL_DISCONNECTED']))).toEqual({
      eligible: true, blockingCodes: [], simulatedPassedCases: 1, simulatedTotalCases: 2,
    })
  })

  it('blocks structural problems, unsimulated layouts and layouts that already passed', () => {
    expect(experimentalBuildEligibility(validation(['SIMULATED_CASE_MISMATCH', 'OUT_OF_BOUNDS', 'OUT_OF_BOUNDS'])))
      .toMatchObject({ eligible: false, blockingCodes: ['OUT_OF_BOUNDS'] })
    expect(experimentalBuildEligibility(validation(['MISSING_SUPPORT'], false))).toMatchObject({ eligible: false })
    expect(experimentalBuildEligibility(validation(['SIMULATED_CASE_MISMATCH'], false)).eligible).toBe(false)
    expect(experimentalBuildEligibility(validation([])).eligible).toBe(false)
    expect(experimentalBuildEligibility(undefined).eligible).toBe(false)
  })
})
