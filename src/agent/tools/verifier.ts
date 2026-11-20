import type {
  BuildRun,
  PhysicalLayout,
  RunError,
  TaskSpec,
  VerificationCase,
  VerificationReport,
} from '@domain/domain'
import type { MinecraftAdapter } from '@minecraft/minecraft-adapter'

export class MinecraftTruthTableVerifier {
  constructor(private readonly adapter: MinecraftAdapter) {}

  async verify(
    reportId: string,
    task: TaskSpec,
    layout: PhysicalLayout,
    run: BuildRun,
    onCase: (result: VerificationCase) => Promise<void> | void,
  ): Promise<VerificationReport> {
    const startedAt = new Date().toISOString()
    const cases: VerificationCase[] = []
    const environmentErrors: RunError[] = []

    if (run.status !== 'completed') {
      environmentErrors.push({ code: 'BUILD_NOT_COMPLETED', message: 'Verification requires a completed BuildRun', recoverable: false })
    } else {
      for (let index = 0; index < task.truthTable.length; index += 1) {
        const row = task.truthTable[index]
        let result: VerificationCase
        try {
          await this.adapter.setInputs(task, row.inputs)
          // setblock-created redstone can remain stale until a real neighbor update.
          await this.adapter.triggerUpdate(task, layout)
          const readings = await this.adapter.readOutputs(task, task.acceptance.stableReads)
          const actual = Object.fromEntries(task.outputs.map((output) => [
            output.id,
            readings[output.id]?.value ?? 'unreadable',
          ]))
          const evidence = task.outputs.flatMap((output) => readings[output.id]?.evidence ?? [])
          const passed = task.outputs.every((output) => actual[output.id] === row.outputs[output.id])
          result = { index, inputs: row.inputs, expected: row.outputs, actual, passed, evidence }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          environmentErrors.push({ code: 'VERIFICATION_CASE_ERROR', message, details: { index }, recoverable: true })
          result = {
            index,
            inputs: row.inputs,
            expected: row.outputs,
            actual: Object.fromEntries(task.outputs.map((output) => [output.id, 'unreadable'])),
            passed: false,
            evidence: [],
          }
        }
        cases.push(result)
        await onCase(result)
      }
    }

    const passedCases = cases.filter((item) => item.passed).length
    return {
      id: reportId,
      version: 1,
      taskSpecRef: { id: task.id, version: task.version },
      buildRunRef: { id: run.id, version: run.version },
      cases,
      passedCases,
      totalCases: task.truthTable.length,
      passed: environmentErrors.length === 0 && passedCases === task.truthTable.length,
      authoritative: run.environment.authoritative,
      environmentErrors,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  }
}
