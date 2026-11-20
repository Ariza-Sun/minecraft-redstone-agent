import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@domain/domain'
import { sessionTokenUsage } from './session-token-usage'

function event(seq: number, type: string, payload: unknown): SessionEvent {
  return { sessionId: 'session-test', seq, at: new Date(seq * 1_000).toISOString(), type, payload }
}

describe('sessionTokenUsage', () => {
  it('adds all metered model responses, including attempts rejected later', () => {
    const received = event(1, 'model.output.received', {
      usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    })
    const usage = sessionTokenUsage([
      received,
      event(2, 'model.output.rejected', { reason: 'schema' }),
      event(3, 'model.output.received', {
        usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180 },
      }),
      event(4, 'model.call.completed', {
        usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180 },
      }),
      received,
    ])

    expect(usage).toEqual({
      promptTokens: 220,
      completionTokens: 100,
      totalTokens: 320,
      measuredResponses: 2,
    })
  })

  it('ignores timeouts without usage and derives a missing total', () => {
    expect(sessionTokenUsage([
      event(1, 'model.output.rejected', { category: 'timeout' }),
      event(2, 'model.output.received', { usage: { promptTokens: 9, completionTokens: 4 } }),
    ])).toEqual({
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
      measuredResponses: 1,
    })
  })
})
