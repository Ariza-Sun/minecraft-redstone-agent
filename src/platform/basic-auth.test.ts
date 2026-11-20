import { describe, expect, it } from 'vitest'
import { isAuthorized, loadBasicAuth } from './basic-auth'

const encode = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

describe('loadBasicAuth', () => {
  it('is undefined when neither variable is set', () => {
    expect(loadBasicAuth({})).toBeUndefined()
  })

  it('returns the credential when both are set', () => {
    expect(loadBasicAuth({ WEB_AUTH_USER: 'teacher', WEB_AUTH_PASS: 'pw' } as NodeJS.ProcessEnv))
      .toEqual({ user: 'teacher', pass: 'pw' })
  })

  it('throws when only one half is set', () => {
    expect(() => loadBasicAuth({ WEB_AUTH_USER: 'teacher' } as NodeJS.ProcessEnv)).toThrow()
    expect(() => loadBasicAuth({ WEB_AUTH_PASS: 'pw' } as NodeJS.ProcessEnv)).toThrow()
  })
})

describe('isAuthorized', () => {
  const config = { user: 'teacher', pass: 's3cret' }

  it('accepts the exact credential', () => {
    expect(isAuthorized(encode('teacher', 's3cret'), config)).toBe(true)
  })

  it('rejects a wrong password, wrong user, or swapped fields', () => {
    expect(isAuthorized(encode('teacher', 'nope'), config)).toBe(false)
    expect(isAuthorized(encode('other', 's3cret'), config)).toBe(false)
    expect(isAuthorized(encode('s3cret', 'teacher'), config)).toBe(false)
  })

  it('rejects missing, malformed, or non-Basic headers', () => {
    expect(isAuthorized(undefined, config)).toBe(false)
    expect(isAuthorized('Bearer token', config)).toBe(false)
    expect(isAuthorized('Basic !!!not-base64!!!', config)).toBe(false)
    expect(isAuthorized(`Basic ${Buffer.from('no-colon').toString('base64')}`, config)).toBe(false)
  })

  it('accepts passwords that contain a colon', () => {
    const withColon = { user: 'teacher', pass: 'a:b:c' }
    expect(isAuthorized(encode('teacher', 'a:b:c'), withColon)).toBe(true)
  })
})
