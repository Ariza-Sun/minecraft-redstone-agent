import { describe, expect, it } from 'vitest'
import type { PhysicalLayout, SessionEvent, SessionSnapshot, WorldCaseState } from '@domain/domain'
import { sessionVerification } from './session-verification'

function snapshot(): SessionSnapshot {
  return {
    id: 'session-test', state: 'FAILED', mode: 'interactive', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:01:00Z',
    request: 'NOT', model: 'test', modelMode: 'fixture', minecraftMode: 'live', authoritative: true,
    runPolicy: { maxTaskVersions: 2, maxLogicVersions: 3, maxLayoutVersions: 5 }, activity: 'Initial verification failed', latestSeq: 10,
    error: { code: 'MINECRAFT_VERIFICATION_FAILED', message: 'Input did not switch', recoverable: false },
    artifacts: {
      physicalLayout: { id: 'layout', version: 1 } as PhysicalLayout,
      verificationReport: {
        id: 'report', version: 1, taskSpecRef: { id: 'task', version: 1 }, buildRunRef: { id: 'build', version: 1 },
        cases: [
          { index: 0, inputs: { A: 0 }, expected: { Y: 1 }, actual: { Y: 'unreadable' }, passed: false, evidence: [] },
          { index: 1, inputs: { A: 1 }, expected: { Y: 0 }, actual: { Y: 0 }, passed: true, evidence: [] },
        ],
        passedCases: 1, totalCases: 2, passed: false, authoritative: true,
        environmentErrors: [{ code: 'VERIFICATION_CASE_ERROR', message: 'Input did not switch', details: { index: 0 }, recoverable: true }],
        startedAt: '2026-10-07T00:00:00Z', finishedAt: '2026-10-07T00:01:00Z',
      },
    },
  }
}

function readback(seq = 11, index = 0, passed = true): SessionEvent {
  const inputs = { A: index === 0 ? 0 as const : 1 as const }
  const expected = { Y: index === 0 ? 1 as const : 0 as const }
  const payload: WorldCaseState = { index, inputs, expected, actual: { Y: passed ? expected.Y : expected.Y === 1 ? 0 : 1 }, passed,
    evidence: [{ type: 'minecraft-block-read', source: 'live', at: '2026-10-07T00:02:00Z' }], authoritative: true, appliedAt: '2026-10-07T00:02:00Z' }
  return { sessionId: 'session-test', seq, at: payload.appliedAt, type: 'minecraft.case.applied', payload,
    refs: [{ id: 'task', version: 1 }, { id: 'build', version: 1 }, { id: 'layout', version: 1 }] }
}

describe('latest Minecraft verification readbacks', () => {
  it('keeps acceptance unchanged when a case is selected for display', () => {
    const session = snapshot()
    const event = readback()
    ;(event.payload as WorldCaseState).purpose = 'display'
    const view = sessionVerification(session, [event])
    expect(view.report).toBe(session.artifacts.verificationReport)
    expect(view.state).toBe('FAILED')
    expect(view.retestedCases).toEqual([])
    // An existing, explicitly recovered result also survives a later display.
    const mismatch = readback(12, 0, false)
    ;(mismatch.payload as WorldCaseState).purpose = 'display'
    expect(sessionVerification(session, [readback(), mismatch]).state).toBe('SUCCEEDED')
  })

  it('recovers acceptance after a successful retest while preserving the original report and error', () => {
    const session = snapshot()
    const original = structuredClone(session)
    const view = sessionVerification(session, [readback()])
    expect(view).toMatchObject({ recovered: true, state: 'SUCCEEDED', retestedCases: [0],
      report: { passed: true, passedCases: 2, totalCases: 2, environmentErrors: [] } })
    expect(view.report?.cases[0].actual).toEqual({ Y: 1 })
    expect(session).toEqual(original)
  })

  it('keeps every retested row when another case is selected, using sequence order for newer failures', () => {
    const session = snapshot()
    expect(sessionVerification(session, [readback(12, 1), readback(11, 0)]).report?.passedCases).toBe(2)
    const view = sessionVerification(session, [readback(13, 0, false), readback(12, 1), readback(11, 0)])
    expect(view.recovered).toBe(false)
    expect(view.report?.passedCases).toBe(1)
    expect(view.report?.cases[0].passed).toBe(false)
  })

  it('ignores evidence from another session, build, layout, authority, or earlier acceptance', () => {
    const session = snapshot()
    const events = [
      { ...readback(), sessionId: 'another' },
      { ...readback(), refs: [{ id: 'build', version: 2 }, { id: 'task', version: 1 }, { id: 'layout', version: 1 }] },
      { ...readback(), refs: [{ id: 'build', version: 1 }, { id: 'task', version: 1 }, { id: 'layout', version: 2 }] },
      { ...readback(), payload: { ...(readback().payload as WorldCaseState), authoritative: false } },
      { ...readback(), at: '2026-10-07T00:00:00Z' },
    ]
    expect(sessionVerification(session, events).report).toBe(session.artifacts.verificationReport)
    expect(sessionVerification(session, events).recovered).toBe(false)
  })

  it('does not clear unrelated errors or grant a real success to mock readbacks', () => {
    const session = snapshot()
    session.error!.code = 'BUILD_FAILED'
    expect(sessionVerification(session, [readback()]).state).toBe('FAILED')
    session.error!.code = 'MINECRAFT_VERIFICATION_FAILED'
    session.authoritative = false
    session.artifacts.verificationReport!.authoritative = false
    const event = readback()
    ;(event.payload as WorldCaseState).authoritative = false
    expect(sessionVerification(session, [event]).recovered).toBe(false)
  })

  it('rejects unsupported success flags and keeps environment errors for other cases', () => {
    const session = snapshot()
    const invalid = readback(11, 0, false)
    ;(invalid.payload as WorldCaseState).passed = true
    expect(sessionVerification(session, [invalid]).recovered).toBe(false)
    session.artifacts.verificationReport!.environmentErrors.push({ code: 'CONNECTION_LOST', message: 'disconnected', recoverable: true })
    expect(sessionVerification(session, [readback()]).report?.passed).toBe(false)
  })
})
