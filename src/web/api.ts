import type { SessionEvent, SessionSnapshot, SessionSummary, WorldCaseState } from '@domain/domain'
import type { ModelOption } from '@domain/model-catalog'

type RuntimeConfig = {
  model: string
  models: ModelOption[]
  modelMode: 'openrouter' | 'fixture'
  minecraftMode: 'live' | 'mock'
  authoritative: boolean
  viewerUrl?: string
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new ApiError(body?.error?.message ?? `HTTP ${response.status}`, response.status)
  return body as T
}

export const api = {
  config: () => request<RuntimeConfig>('/api/config'),
  createSession: (taskRequest: string, model: string) => request<SessionSnapshot>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ request: taskRequest, mode: 'interactive', model }),
  }),
  listSessions: () => request<SessionSummary[]>('/api/sessions?view=summary'),
  getSession: (sessionId: string) => request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  getEvents: (sessionId: string, after = 0) => request<SessionEvent[]>(
    `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
  ),
  approveDesign: (sessionId: string) => request<{ accepted: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/commands/approve-design`,
    { method: 'POST', body: '{}' },
  ),
  startBuild: (sessionId: string) => request<{ accepted: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/commands/start-build`,
    { method: 'POST', body: '{}' },
  ),
  reviseLayout: (sessionId: string, instruction?: string) => request<{ accepted: true }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/commands/revise-layout`,
    {
      method: 'POST',
      body: JSON.stringify(instruction ? { instruction } : {}),
    },
  ),
  retryLayout: (sessionId: string, instruction?: string) => request<{ accepted: true }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/commands/retry-layout`,
    {
      method: 'POST',
      body: JSON.stringify(instruction ? { instruction } : {}),
    },
  ),
  showCase: (sessionId: string, caseIndex: number) => request<WorldCaseState>(
    `/api/sessions/${encodeURIComponent(sessionId)}/commands/show-case`,
    { method: 'POST', body: JSON.stringify({ caseIndex }) },
  ),
  sendMessage: (
    sessionId: string,
    message: string,
    focus?: { logicId?: string; caseIndex?: number },
  ) => request<{ accepted: boolean; reply: { message: string } }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    { method: 'POST', body: JSON.stringify({ message, focus }) },
  ),
}

export { ApiError }
export type { RuntimeConfig }
