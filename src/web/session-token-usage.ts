import type { SessionEvent } from '@domain/domain'

export type SessionTokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  measuredResponses: number
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Sum every metered model response, including outputs later rejected by
 * local parsing or validation. Timeouts have no upstream usage payload and are
 * therefore intentionally absent from the measured total.
 */
export function sessionTokenUsage(events: SessionEvent[]): SessionTokenUsage {
  const result: SessionTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    measuredResponses: 0,
  }
  const seen = new Set<number>()

  for (const event of events) {
    if (event.type !== 'model.output.received' || seen.has(event.seq)) continue
    seen.add(event.seq)
    const usage = (event.payload as { usage?: Record<string, unknown> } | undefined)?.usage
    if (!usage) continue
    const promptTokens = tokenCount(usage.promptTokens)
    const completionTokens = tokenCount(usage.completionTokens)
    const totalTokens = tokenCount(usage.totalTokens) || promptTokens + completionTokens
    result.promptTokens += promptTokens
    result.completionTokens += completionTokens
    result.totalTokens += totalTokens
    result.measuredResponses += 1
  }

  return result
}
