import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionEvent, SessionState } from '@domain/domain'

type Props = {
  events: SessionEvent[]
  state: SessionState
  maxCandidates: number
}

type EventPayload = Record<string, unknown> & {
  stage?: string
  call?: number
  attempt?: number
  maxAttempts?: number
  model?: string
  output?: string
  truncated?: boolean
  elapsedMs?: number
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  experiment?: { reasoningEffort: string; timeoutMs: number; reasoningTokens?: number }
  request?: Record<string, unknown>
  rawResponse?: Record<string, unknown>
  timingRecord?: Record<string, unknown>
  reason?: string
  retrying?: boolean
  category?: string
  actionType?: string
  passed?: boolean
  issues?: Array<{ code?: string; message?: string; blockId?: string }>
  kind?: string
  artifact?: { version?: number; blocks?: unknown[] }
  bestLayoutRef?: { version?: number }
  candidateLayoutRef?: { version?: number }
  issueCount?: number
  candidateIssueCount?: number
  bestIssueCount?: number
  errors?: string[]
}

const modelEventTypes = new Set([
  'model.attempt.started',
  'model.output.received',
  'model.output.rejected',
  'model.output.accepted',
])

function payloadOf(event: SessionEvent): EventPayload {
  return (event.payload ?? {}) as EventPayload
}

function duration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`
}

function eventTime(event: SessionEvent): string {
  return new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })
}

export function LayoutProcessStream({ events, state, maxCandidates }: Props) {
  const [clock, setClock] = useState(Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)
  const processEvents = useMemo(() => events.filter((event) => {
    const payload = payloadOf(event)
    if (modelEventTypes.has(event.type)) return payload.stage === 'layout'
    if (event.type === 'artifact.created') return payload.kind === 'PhysicalLayout'
    return event.type === 'layout.validation.completed'
      || event.type === 'layout.best_candidate.updated'
      || event.type === 'layout.patch.reverted'
      || event.type === 'layout.patch.rejected'
  }), [events])

  const activeAttempt = useMemo(() => {
    for (let index = processEvents.length - 1; index >= 0; index -= 1) {
      const event = processEvents[index]
      if (event.type !== 'model.attempt.started') continue
      const payload = payloadOf(event)
      const settled = processEvents.slice(index + 1).some((candidate) => {
        const candidatePayload = payloadOf(candidate)
        return candidatePayload.call === payload.call
          && candidatePayload.attempt === payload.attempt
          && (candidate.type === 'model.output.received' || candidate.type === 'model.output.rejected')
      })
      if (!settled) return event
      break
    }
    return undefined
  }, [processEvents])

  useEffect(() => {
    if (!activeAttempt) return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [activeAttempt])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [processEvents.length])

  const isLive = Boolean(activeAttempt) || state === 'VALIDATING_LAYOUT'

  return (
    <section className="layout-process" aria-label="空间布局生成与校验过程">
      <div className="layout-process-heading">
        <div>
          <strong>生成与校验过程</strong>
          <span>每轮最多 {maxCandidates} 次布局尝试；重新运行会开启新一轮</span>
        </div>
        <span className={isLive ? 'process-live active' : 'process-live'}><i />{isLive ? '实时更新' : '过程记录'}</span>
      </div>
      <div className="layout-process-list" ref={scrollRef} aria-live="polite">
        {processEvents.map((event) => {
          const payload = payloadOf(event)
          const isActive = activeAttempt?.seq === event.seq
          if (event.type === 'model.attempt.started') {
            return <div className={`process-entry request ${isActive ? 'active' : ''}`} key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>布局调用 {payload.call} · 请求尝试 {payload.attempt}/{payload.maxAttempts}</strong><time>{eventTime(event)}</time></div>
                <p>{isActive
                  ? `模型输出中 · 已等待 ${duration(clock - new Date(event.at).getTime())}`
                  : `${payload.model ?? '模型'} 本次请求已结束`}</p>
              </div>
            </div>
          }
          if (event.type === 'model.output.received') {
            return <div className="process-entry response" key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>收到模型输出</strong><time>{duration(Number(payload.elapsedMs ?? 0))}</time></div>
                <p>布局调用 {payload.call} · 请求尝试 {payload.attempt} · {payload.usage?.totalTokens?.toLocaleString() ?? '—'} tokens</p>
                {payload.experiment && <p>独立计时实验 · 思考强度 {payload.experiment.reasoningEffort} · 单次上限 {duration(payload.experiment.timeoutMs)} · 推理 {payload.experiment.reasoningTokens?.toLocaleString() ?? '—'} tokens</p>}
                <pre className="model-output-preview">{payload.output}{payload.truncated ? '\n… 输出过长，已截断显示' : ''}</pre>
                {payload.request && <details><summary>查看完整请求</summary><pre className="model-output-preview">{JSON.stringify(payload.request, null, 2)}</pre></details>}
                {payload.rawResponse && <details><summary>查看原始响应</summary><pre className="model-output-preview">{JSON.stringify(payload.rawResponse, null, 2)}</pre></details>}
                {payload.timingRecord && <details><summary>查看计时记录</summary><pre className="model-output-preview">{JSON.stringify(payload.timingRecord, null, 2)}</pre></details>}
              </div>
            </div>
          }
          if (event.type === 'model.output.rejected') {
            return <div className="process-entry rejected" key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>{payload.category === 'timeout' ? '模型请求超时' : payload.category === 'transport' ? '模型请求中断' : payload.category === 'upstream' ? '上游服务返回错误' : '结构化输出未通过'}</strong><time>{eventTime(event)}</time></div>
                <p>{payload.reason ?? '模型输出无法用于下一步。'}</p>
                <span className="process-disposition">{payload.retrying ? '自动进入下一次模型尝试' : '本次模型调用不再重试'}</span>
              </div>
            </div>
          }
          if (event.type === 'model.output.accepted') {
            return <div className="process-entry accepted" key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>JSON 结构检查通过</strong><time>{eventTime(event)}</time></div>
                <p>{payload.actionType ?? 'propose_layout'} 可以进入确定性布局校验</p>
              </div>
            </div>
          }
          if (event.type === 'artifact.created') {
            return <div className="process-entry artifact" key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>PhysicalLayout v{payload.artifact?.version ?? '?'} 已固化</strong><time>{eventTime(event)}</time></div>
                <p>{payload.artifact?.blocks?.length ?? 0} 个方块，开始检查坐标、端口、支撑与逻辑映射</p>
              </div>
            </div>
          }
          if (event.type === 'layout.best_candidate.updated') {
            return <div className="process-entry accepted" key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>更新最佳候选 · v{payload.bestLayoutRef?.version ?? '?'}</strong><time>{eventTime(event)}</time></div>
                <p>当前最低为 {payload.issueCount ?? '?'} 个确定性问题；下一次尝试从这一版本继续修补。</p>
              </div>
            </div>
          }
          if (event.type === 'layout.patch.reverted') {
            return <div className="process-entry rejected" key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>Patch 未改善，已回滚</strong><time>{eventTime(event)}</time></div>
                <p>候选 v{payload.candidateLayoutRef?.version ?? '?'} 有 {payload.candidateIssueCount ?? '?'} 个问题；继续保留 v{payload.bestLayoutRef?.version ?? '?'} 的 {payload.bestIssueCount ?? '?'} 个问题。</p>
              </div>
            </div>
          }
          if (event.type === 'layout.patch.rejected') {
            return <div className="process-entry rejected" key={event.seq}>
              <i className="process-node" />
              <div>
                <div className="process-title"><strong>Patch 无法应用</strong><time>{eventTime(event)}</time></div>
                <p>{payload.errors?.join('；') ?? 'Patch 与当前最佳布局版本不一致。'}</p>
              </div>
            </div>
          }
          const issues = payload.issues ?? []
          return <div className={`process-entry validation ${payload.passed ? 'accepted' : 'rejected'}`} key={event.seq}>
            <i className="process-node" />
            <div>
              <div className="process-title"><strong>{payload.passed ? '确定性布局校验通过' : `布局校验拒绝 · ${issues.length} 个问题`}</strong><time>{eventTime(event)}</time></div>
              {payload.passed
                ? <p>当前候选已满足布局契约，可以进入 Minecraft 搭建。</p>
                : <ul>{issues.map((issue, index) => <li key={`${issue.code}-${issue.blockId}-${index}`}><b>{issue.code ?? 'VALIDATION'}</b>{issue.blockId ? ` · ${issue.blockId}` : ''} — {issue.message}</li>)}</ul>}
              {!payload.passed && <span className="process-disposition">Agent 将携带这些问题修补当前最佳布局</span>}
            </div>
          </div>
        })}
      </div>
    </section>
  )
}
