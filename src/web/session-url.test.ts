import { describe, expect, it } from 'vitest'
import { sessionHref, sessionIdFromSearch } from './session-url'

function at(search: string, pathname = '/', hash = '') {
  return { pathname, search, hash }
}

describe('sessionIdFromSearch', () => {
  it('reads the session id from the query string', () => {
    expect(sessionIdFromSearch('?session=session-1787512975336-8b9c0599')).toBe('session-1787512975336-8b9c0599')
    expect(sessionIdFromSearch('?debug=1&session=session-a')).toBe('session-a')
  })

  it('treats a missing or blank id as no session', () => {
    expect(sessionIdFromSearch('')).toBeUndefined()
    expect(sessionIdFromSearch('?debug=1')).toBeUndefined()
    expect(sessionIdFromSearch('?session=')).toBeUndefined()
    expect(sessionIdFromSearch('?session=%20')).toBeUndefined()
  })
})

describe('sessionHref', () => {
  it('sets or replaces the session id and keeps the rest of the address', () => {
    expect(sessionHref(at(''), 'session-a')).toBe('/?session=session-a')
    expect(sessionHref(at('?session=session-a'), 'session-b')).toBe('/?session=session-b')
    expect(sessionHref(at('?debug=1', '/workbench/', '#timeline'), 'session-a'))
      .toBe('/workbench/?debug=1&session=session-a#timeline')
  })

  it('drops the session id when leaving a session', () => {
    expect(sessionHref(at('?session=session-a'))).toBe('/')
    expect(sessionHref(at('?debug=1&session=session-a', '/workbench/'))).toBe('/workbench/?debug=1')
    expect(sessionHref(at(''))).toBe('/')
  })

  it('round-trips through sessionIdFromSearch', () => {
    const href = sessionHref(at('?debug=1'), 'session-a')
    expect(sessionIdFromSearch(href.slice(href.indexOf('?')))).toBe('session-a')
  })
})
