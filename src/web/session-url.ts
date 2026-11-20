// The open session lives in the address bar as `?session=<id>`, so a reload,
// a copied link or the back button lands on the same workbench.

const SESSION_PARAM = 'session'

type LocationParts = Pick<Location, 'pathname' | 'search' | 'hash'>

export function sessionIdFromSearch(search: string): string | undefined {
  return new URLSearchParams(search).get(SESSION_PARAM)?.trim() || undefined
}

/** The current address with the session swapped in, or removed when `sessionId` is omitted. */
export function sessionHref(location: LocationParts, sessionId?: string): string {
  const params = new URLSearchParams(location.search)
  if (sessionId) params.set(SESSION_PARAM, sessionId)
  else params.delete(SESSION_PARAM)
  const search = params.toString()
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`
}
