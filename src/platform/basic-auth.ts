import { createHash, timingSafeEqual } from 'node:crypto'

// Optional HTTP Basic Auth gate. The prototype is normally reached over
// localhost or an SSH tunnel, but when it is published on a forwarded public
// port anyone who reaches it can spend the OpenRouter key and drive the live
// Minecraft server. Setting WEB_AUTH_USER and WEB_AUTH_PASS turns on a single
// shared credential in front of the whole app (UI, API and the viewer socket).
export type BasicAuthConfig = { user: string; pass: string }

export function loadBasicAuth(env: NodeJS.ProcessEnv = process.env): BasicAuthConfig | undefined {
  const user = env.WEB_AUTH_USER
  const pass = env.WEB_AUTH_PASS
  if (!user && !pass) return undefined
  if (!user || !pass) {
    throw new Error('WEB_AUTH_USER and WEB_AUTH_PASS must be set together, or both left empty.')
  }
  return { user, pass }
}

// Hash to a fixed 32-byte digest before comparing so the check is both
// timing-safe and independent of the credential length.
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

export function isAuthorized(authorizationHeader: string | undefined, config: BasicAuthConfig): boolean {
  if (!authorizationHeader || !authorizationHeader.startsWith('Basic ')) return false
  let decoded: string
  try {
    decoded = Buffer.from(authorizationHeader.slice('Basic '.length).trim(), 'base64').toString('utf8')
  } catch {
    return false
  }
  const separator = decoded.indexOf(':')
  if (separator < 0) return false
  const user = decoded.slice(0, separator)
  const pass = decoded.slice(separator + 1)
  // Evaluate both halves regardless of the first result to avoid short-circuit timing leaks.
  const userOk = constantTimeEquals(user, config.user)
  const passOk = constantTimeEquals(pass, config.pass)
  return userOk && passOk
}

export const WWW_AUTHENTICATE = 'Basic realm="mc-ic", charset="UTF-8"'
