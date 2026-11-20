import type { LayoutValidationResult, SessionSnapshot } from './domain'

/**
 * Validation issues that still allow a failed layout to be built as an
 * experiment for failure-case analysis: wrong truth-table rows from the
 * simulator, plus the positional heuristics the simulator supersedes.
 * Everything else (missing supports, collisions, bounds, budgets, illegal
 * blocks or blockstates, broken logic mapping) means the build itself would
 * not describe the layout, so it stays blocked.
 */
export const EXPERIMENTAL_BUILD_TOLERATED_CODES: ReadonlySet<string> = new Set([
  'SIMULATED_CASE_MISMATCH',
  'OUTPUT_SIGNAL_DISCONNECTED',
  'INVERTER_INPUT_DISCONNECTED',
  'INPUT_BYPASSES_LOGIC',
])

export type ExperimentalBuildEligibility = {
  eligible: boolean
  /** Issue codes that keep the layout from being built, deduplicated. */
  blockingCodes: string[]
  simulatedPassedCases: number
  simulatedTotalCases: number
}

export function experimentalBuildEligibility(validation: LayoutValidationResult | undefined): ExperimentalBuildEligibility {
  const blockingCodes = [...new Set((validation?.issues ?? [])
    .map((issue) => issue.code)
    .filter((code) => !EXPERIMENTAL_BUILD_TOLERATED_CODES.has(code)))]
  const simulation = validation?.simulation
  return {
    eligible: Boolean(validation && !validation.passed && simulation?.evaluated && blockingCodes.length === 0),
    blockingCodes,
    simulatedPassedCases: simulation?.passedCases ?? 0,
    simulatedTotalCases: simulation?.totalCases ?? 0,
  }
}

/**
 * True when a session whose layout round ran out of attempts may still build
 * its best layout as an experiment. The controller enforces this; the web UI
 * uses the same rule to decide whether to offer the build button.
 */
export function canStartExperimentalBuild(
  session: Pick<SessionSnapshot, 'state' | 'error' | 'artifacts' | 'logicCheck' | 'layoutValidation'>,
): boolean {
  return session.state === 'FAILED'
    && session.error?.code === 'LAYOUT_VALIDATION_FAILED'
    && Boolean(session.artifacts.task && session.artifacts.logicDesign && session.artifacts.physicalLayout && session.logicCheck?.passed)
    && !session.artifacts.buildRun && !session.artifacts.verificationReport
    && experimentalBuildEligibility(session.layoutValidation).eligible
}
