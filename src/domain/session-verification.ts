import { worldCaseStateSchema, type SessionEvent, type SessionSnapshot, type VerificationCase, type VersionRef } from './domain'

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value)
}

// Keep the original acceptance report intact and present subsequent readbacks
// only when they belong to the same task, layout and Minecraft build.
export function sessionVerification(session: SessionSnapshot | undefined, events: SessionEvent[]) {
  const original = session?.artifacts.verificationReport
  const layout = session?.artifacts.physicalLayout
  if (!session || !original || !layout) return { report: original, retestedCases: [], recovered: false, state: session?.state }
  const latest = new Map<number, VerificationCase>()
  const expectedRefs: VersionRef[] = [original.taskSpecRef, original.buildRunRef, { id: layout.id, version: layout.version }]
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.sessionId !== session.id || event.type !== 'minecraft.case.applied' || event.at < original.finishedAt) continue
    if (!expectedRefs.every((ref) => event.refs?.some((item) => item.id === ref.id && item.version === ref.version))) continue
    const parsed = worldCaseStateSchema.safeParse(event.payload)
    if (!parsed.success || parsed.data.authoritative !== original.authoritative) continue
    const result = parsed.data
    if (result.purpose === 'display') continue
    const row = original.cases.find((item) => item.index === result.index)
    if (!row || !sameValues(result.inputs, row.inputs) || !sameValues(result.expected, row.expected) || !result.evidence.length) continue
    const passed = Object.entries(row.expected).every(([id, value]) => result.actual[id] === value)
    if (passed !== result.passed) continue
    latest.set(result.index, result)
  }
  if (!latest.size) return { report: original, retestedCases: [], recovered: false, state: session.state }
  const cases = original.cases.map((row) => latest.get(row.index) ?? row)
  const environmentErrors = original.environmentErrors.filter((error) => {
    const index = (error.details as { index?: number } | undefined)?.index
    return error.code !== 'VERIFICATION_CASE_ERROR' || index === undefined || !latest.get(index)?.passed
  })
  const passedCases = cases.filter((row) => row.passed).length
  const report = { ...original, cases, environmentErrors, passedCases,
    passed: passedCases === original.totalCases && cases.length === original.totalCases && !environmentErrors.length }
  const recovered = session.state === 'FAILED' && session.error?.code === 'MINECRAFT_VERIFICATION_FAILED'
    && session.authoritative && report.authoritative && report.passed
  const state = recovered ? 'SUCCEEDED' as const
    : session.state === 'SUCCEEDED' && !report.passed ? 'FAILED' as const : session.state
  return { report, retestedCases: [...latest.keys()], recovered, state }
}
