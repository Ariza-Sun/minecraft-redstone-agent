import { issueCounts } from '@agent/tools/layout-validator'
import type { LayoutValidationIssue, LayoutValidationResult } from '@domain/domain'

export const LAYOUT_REPAIR_DIRECTIVE = 'Return a repair_layout patch against artifacts.physicalLayout. Preserve every unmentioned block. Candidates are ranked by structural issue count first (supports, collisions, bounds, ports, blockstates, mappings), then by the number of incorrect output bits across the full truth table, then by failing-row count; the truth-table simulation only runs once no structural issue remains. Use simulation.outputMismatchesByOutput to target the worst output net first. Strictly improve that ranking without reintroducing historical errors, and use the simulation states and observations in the feedback to trace every failing output bit to the exact block that blocks or leaks the signal.'

export function compactLayoutIssues(issues: LayoutValidationIssue[]) {
  const grouped = new Map<string, LayoutValidationIssue[]>()
  for (const issue of issues) {
    const group = grouped.get(issue.code) ?? []
    group.push(issue)
    grouped.set(issue.code, group)
  }
  return [...grouped.entries()].map(([code, group]) => ({
    code,
    count: group.length,
    examples: group.slice(0, 3).map((issue) => ({
      // Simulation observations are carried once in the simulation section;
      // do not repeat the whole circuit-wide diagnosis in the first mismatch.
      message: (code === 'SIMULATED_CASE_MISMATCH'
        ? issue.message.split(' Circuit-wide observations:')[0]
        : issue.message).slice(0, 2_500),
      ...(issue.blockId ? { blockId: issue.blockId } : {}),
      ...(issue.position ? { position: issue.position } : {}),
    })),
  }))
}

export function compactValidationHistory<T extends {
  layoutVersion: number
  issueGroups: Array<{ code: string; count: number; examples?: unknown[] }>
}>(history: T[]) {
  // The current best and last candidate already carry detailed diagnostics.
  // History is only a regression ledger, so codes/counts are sufficient.
  return history.slice(-6).map((entry) => ({
    layoutVersion: entry.layoutVersion,
    issueGroups: entry.issueGroups.map(({ code, count }) => ({ code, count, examples: [] })),
  }))
}

function compactDiagnostic(text: string): string {
  return text.length <= 1_800 ? text : `${text.slice(0, 1_797)}...`
}

function compactSimulationStates(states: string[]): string[] {
  // The single wire-power line repeats every wire in the entire layout. Local
  // mismatch messages and circuit observations already name the relevant net.
  return states.filter((state) => !state.startsWith('wire power:')).slice(0, 32)
}

export function compactLayoutValidation(result: LayoutValidationResult) {
  const counts = issueCounts(result)
  const simulation = result.simulation
  const outputMismatchesByOutput = simulation?.evaluated
    ? Object.fromEntries([...simulation.cases.reduce((totals, item) => {
        for (const [outputId, expected] of Object.entries(item.expected)) {
          if (item.actual[outputId] !== expected) totals.set(outputId, (totals.get(outputId) ?? 0) + 1)
        }
        return totals
      }, new Map<string, number>()).entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])))
    : undefined
  return {
    passed: result.passed,
    stats: result.stats,
    structuralIssues: counts.structural,
    functionalIssues: counts.functional,
    outputBitMismatches: counts.outputMismatches,
    issueGroups: compactLayoutIssues(result.issues),
    // The pre-build redstone simulation is the fastest evidence the agent gets:
    // per failing truth-table row, the settled state of every active component.
    ...(simulation
      ? {
          simulation: simulation.evaluated
            ? {
                evaluated: true,
                passedCases: simulation.passedCases,
                totalCases: simulation.totalCases,
                outputMismatchesByOutput,
                failedCases: simulation.cases
                  .filter((item) => !item.passed)
                  .map(({ index, inputs, expected, actual, states, mismatches }, failedIndex) => ({
                    index,
                    inputs,
                    expected,
                    actual,
                    mismatches: (mismatches ?? []).map(compactDiagnostic),
                    // Two representative rows retain component states; all
                    // later rows keep only compact I/O and local mismatches.
                    ...(failedIndex < 2 ? { states: compactSimulationStates(states) } : {}),
                  })),
                observations: simulation.observations.slice(0, 12).map(compactDiagnostic),
              }
            : { evaluated: false, reason: simulation.reason },
        }
      : {}),
  }
}
