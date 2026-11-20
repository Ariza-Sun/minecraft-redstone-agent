import { useState, type MouseEvent } from 'react'
import type { SessionSummary } from '@domain/domain'
import type { ModelOption } from '@domain/model-catalog'
import { sessionStateLabel } from '../app-view'
import { sessionHref } from '../session-url'

type Props = {
  sessions: SessionSummary[]
  models: ModelOption[]
  onOpen: (sessionId: string) => void
}

// Below this many rows the whole list is visible at a glance and a filter is noise.
const FILTER_THRESHOLD = 6

function updatedAt(session: SessionSummary): string {
  return new Date(session.updatedAt).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SessionList({ sessions, models, onOpen }: Props) {
  const [query, setQuery] = useState('')
  if (sessions.length === 0) return null

  const rows = sessions.map((session) => {
    const model = session.modelMode === 'fixture'
      ? 'Fixture'
      : models.find((option) => option.id === session.model)?.name ?? session.model
    return { session, model, state: sessionStateLabel(session.state, session.experimentalBuild) }
  })
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? rows.filter(({ session, model, state }) => (
      [session.title, session.id, session.model, model, state, session.mode].some((field) => field.toLowerCase().includes(needle))
    ))
    : rows

  return (
    <nav className="session-list" aria-label="已有会话">
      <div className="session-list-heading">
        <strong>继续已有会话</strong>
        <span>{needle ? `匹配 ${visible.length} / ${sessions.length}` : `runs/ 中的 ${sessions.length} 个会话`}</span>
      </div>
      {sessions.length > FILTER_THRESHOLD && <input
        type="search"
        aria-label="筛选会话"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="按标题、模型、状态或 ID 筛选；benchmark / interactive 区分来源"
      />}
      <ul>
        {visible.map(({ session, model, state }) => {
          // A real link, so a session can also be opened in a new tab; a plain click stays in-page.
          const open = (event: MouseEvent<HTMLAnchorElement>) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            onOpen(session.id)
          }
          return (
            <li key={session.id}>
              <a href={sessionHref(window.location, session.id)} onClick={open}>
                <strong>{session.title}</strong>
                <em className={session.state.toLowerCase()}>{state}</em>
                <small><code>{session.id.split('-').slice(-1)[0]}</code>{model} · {updatedAt(session)}{session.mode === 'benchmark' ? ' · benchmark' : ''}</small>
              </a>
            </li>
          )
        })}
        {visible.length === 0 && <li className="session-list-empty">没有匹配的会话</li>}
      </ul>
    </nav>
  )
}
