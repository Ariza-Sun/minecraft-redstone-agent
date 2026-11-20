import { describe, expect, it } from 'vitest'
import { sessionFailure } from './session-failure'

describe('model failure guidance', () => {
  it('distinguishes exhausted credits from a forbidden request', () => {
    const error = { code: 'MODEL_HTTP_ERROR', message: 'upstream error', recoverable: false }
    expect(sessionFailure({ ...error, details: { status: 402 } })).toMatchObject({
      helpUrl: 'https://openrouter.ai/settings/credits',
    })
    expect(sessionFailure({ ...error, details: { status: 403 } })).toMatchObject({
      helpUrl: 'https://openrouter.ai/support',
    })
    expect(sessionFailure({ ...error, details: { status: 403 } })?.message).not.toContain('免费模型')
  })

  it('reads model errors nested in a layout pipeline failure', () => {
    expect(sessionFailure({ code: 'LAYOUT_PIPELINE_FAILED', message: 'wrapped', recoverable: true,
      details: { cause: { code: 'MODEL_HTTP_ERROR', message: 'credits', details: { status: 402 }, recoverable: false } },
    })?.helpUrl).toBe('https://openrouter.ai/settings/credits')
  })

  it('preserves other errors and handles no error', () => {
    expect(sessionFailure({ code: 'BUILD_FAILED', message: 'Minecraft disconnected', recoverable: false }))
      .toEqual({ message: 'Minecraft disconnected' })
    expect(sessionFailure()).toBeUndefined()
  })
})
