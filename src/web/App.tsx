import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { SessionEvent, SessionSnapshot, SessionState, SessionSummary, WorldCaseState } from '@domain/domain'
import { ApiError, api, type RuntimeConfig } from './api'
import { LayoutLayers } from './components/LayoutLayers'
import { LayoutProcessStream } from './components/LayoutProcessStream'
import { LogicGraph } from './components/LogicGraph'
import { MarkdownMessage } from './components/MarkdownMessage'
import { MinecraftViewer } from './components/MinecraftViewer'
import { MockWorldPreview } from './components/MockWorldPreview'
import { SessionList } from './components/SessionList'
import { VerificationTable } from './components/VerificationTable'
import { canRestartLayout, canReviseLayout, phaseIndex } from './phase'
import { canStartExperimentalBuild, experimentalBuildEligibility } from '@domain/experimental-build'
import redstoneLogo from './assets/redstone-block.png'
import { sessionTokenUsage } from './session-token-usage'
import { sessionHref, sessionIdFromSearch } from './session-url'
import { sessionFailure } from './session-failure'
import { sessionVerification } from './session-verification'
import { DEFAULT_REQUEST, Metric, eventLabels, eventSummary, recordValues, sessionStateLabel, streamEvents, structuralIssueLabels } from './app-view'

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeConfig>()
  const [session, setSession] = useState<SessionSnapshot>()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [restoring, setRestoring] = useState(() => Boolean(sessionIdFromSearch(window.location.search)))
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [request, setRequest] = useState(DEFAULT_REQUEST)
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedLogic, setSelectedLogic] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [chat, setChat] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [selectedCase, setSelectedCase] = useState<number>()
  const [applyingCase, setApplyingCase] = useState<number>()
  const [worldCase, setWorldCase] = useState<WorldCaseState>()
  const [revisionInstruction, setRevisionInstruction] = useState('')
  const [layoutRetryBusy, setLayoutRetryBusy] = useState(false)
  const layoutRequestSeq = useRef(0)
  const seenSeq = useRef(new Set<number>())
  const shownSessionId = useRef<string>()
  const shownSessionEpoch = useRef(0)
  const restoreAttempt = useRef(0)
  const chatLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.config()
      .then((next) => {
        setRuntime(next)
        setSelectedModel(next.model)
      })
      .catch((reason) => setError(reason.message))
  }, [])

  useEffect(() => {
    syncFromUrl()
    window.addEventListener('popstate', syncFromUrl)
    return () => window.removeEventListener('popstate', syncFromUrl)
  }, [])

  const onLaunchScreen = !session && !restoring
  useEffect(() => {
    if (!onLaunchScreen) return
    let active = true
    api.listSessions()
      .then((next) => { if (active) setSessions(next.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) })
      .catch(() => undefined)
    return () => { active = false }
  }, [onLaunchScreen])

  useEffect(() => {
    if (!session?.id) return
    const epoch = shownSessionEpoch.current
    let active = true
    const merge = (incoming: SessionEvent[]) => {
      if (!active || shownSessionId.current !== session.id || shownSessionEpoch.current !== epoch) return
      const fresh = incoming.filter((event) => event.sessionId === session.id && !seenSeq.current.has(event.seq))
      fresh.forEach((event) => seenSeq.current.add(event.seq))
      if (fresh.length) setEvents((current) => [...current.filter((event) => event.sessionId === session.id), ...fresh].sort((a, b) => a.seq - b.seq))
    }
    api.getEvents(session.id).then(merge).catch(() => undefined)
    const source = new EventSource(`/api/sessions/${encodeURIComponent(session.id)}/events?after=0`)
    const listener = (raw: Event) => {
      try {
        merge([JSON.parse((raw as MessageEvent).data) as SessionEvent])
        api.getSession(session.id).then((next) => {
          if (active && shownSessionEpoch.current === epoch && shownSessionId.current === next.id && next.id === session.id) {
            setSession((current) => current?.id === next.id && current.latestSeq <= next.latestSeq ? next : current)
          }
        }).catch(() => undefined)
      } catch { /* heartbeat or malformed event */ }
    }
    streamEvents.forEach((name) => source.addEventListener(name, listener))
    const poll = setInterval(() => {
      api.getSession(session.id).then((next) => {
        if (active && shownSessionEpoch.current === epoch && shownSessionId.current === next.id && next.id === session.id) {
          setSession((current) => current?.id === next.id && current.latestSeq <= next.latestSeq ? next : current)
        }
      }).catch(() => undefined)
    }, 1200)
    return () => {
      active = false
      clearInterval(poll)
      source.close()
    }
  }, [session?.id])

  const buildProgress = useMemo(() => {
    const event = [...events].reverse().find((item) => item.type === 'build.block.completed')
    return event?.payload as { placed: number; total: number; block: { id: string } } | undefined
  }, [events])

  const conversation = useMemo(() => events.filter((event) =>
    event.type === 'conversation.user.message' || event.type === 'conversation.agent.reply'), [events])
  const tokenUsage = useMemo(() => sessionTokenUsage(events), [events])

  useEffect(() => {
    const node = chatLogRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [conversation.length, chatBusy])

  useEffect(() => {
    const latest = [...events].reverse().find((event) => event.type === 'minecraft.case.applied')
    if (!latest) return
    const state = latest.payload as WorldCaseState
    setSelectedCase(state.index)
    setWorldCase(state)
  }, [events])

  useEffect(() => {
    if (!layoutRetryBusy || !session || !['READY_TO_BUILD', 'FAILED'].includes(session.state)) return
    const finished = events.some((event) => event.seq > layoutRequestSeq.current && (
      event.type === 'run.error'
      || (event.type === 'layout.validation.completed' && (event.payload as { passed?: boolean }).passed)
    ))
    if (finished) setLayoutRetryBusy(false)
  }, [layoutRetryBusy, events, session])

  // Swap the workbench to another session, or back to the launch screen.
  function showSession(next?: SessionSnapshot) {
    shownSessionEpoch.current += 1
    seenSeq.current = new Set()
    setEvents([])
    setSelectedLogic(undefined)
    setSelectedCase(undefined)
    setApplyingCase(undefined)
    setWorldCase(undefined)
    setError(undefined)
    setBusy(false)
    setChatBusy(false)
    setChat('')
    setRevisionInstruction('')
    setLayoutRetryBusy(false)
    shownSessionId.current = next?.id
    setSession(next)
  }

  // Bring the workbench in line with the address bar: on load, on back/forward,
  // and after a listed session is opened. Only the latest call may settle.
  function syncFromUrl() {
    const attempt = ++restoreAttempt.current
    const id = sessionIdFromSearch(window.location.search)
    if (!id || id === shownSessionId.current) {
      if (!id) showSession(undefined)
      setRestoring(false)
      return
    }
    const settle = (apply: () => void) => {
      if (attempt !== restoreAttempt.current) return
      apply()
      setRestoring(false)
    }
    setRestoring(true)
    showSession(undefined)
    api.getSession(id).then(
      (next) => settle(() => showSession(next)),
      (reason) => settle(() => {
        showSession(undefined)
        if (reason instanceof ApiError && reason.status === 404) {
          // The link is dead for good; a transient failure keeps it so a reload can retry.
          window.history.replaceState(null, '', sessionHref(window.location))
          setError(`找不到会话 ${id}：服务端 runs/ 目录下没有它的可恢复记录。`)
        } else {
          setError(`无法恢复会话 ${id}：${reason instanceof Error ? reason.message : String(reason)}`)
        }
      }),
    )
  }

  function openSession(next?: SessionSnapshot) {
    restoreAttempt.current += 1
    setRestoring(false)
    showSession(next)
    if (sessionIdFromSearch(window.location.search) !== next?.id) {
      window.history.pushState(null, '', sessionHref(window.location, next?.id))
    }
  }

  function openListedSession(sessionId: string) {
    window.history.pushState(null, '', sessionHref(window.location, sessionId))
    syncFromUrl()
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      openSession(await api.createSession(request, selectedModel || runtime?.model || ''))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function command(action: 'approve' | 'build') {
    if (!session) return
    const epoch = shownSessionEpoch.current
    setBusy(true)
    setError(undefined)
    try {
      if (action === 'approve') await api.approveDesign(session.id)
      else await api.startBuild(session.id)
    } catch (reason) {
      if (shownSessionEpoch.current === epoch) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (shownSessionEpoch.current === epoch) setBusy(false)
    }
  }

  async function sendChat(event: FormEvent) {
    event.preventDefault()
    if (!session || !chat.trim()) return
    const epoch = shownSessionEpoch.current
    const message = chat.trim()
    setChat('')
    setChatBusy(true)
    try {
      await api.sendMessage(session.id, message, {
        logicId: selectedLogic,
        caseIndex: selectedCase,
      })
    }
    catch (reason) { if (shownSessionEpoch.current === epoch) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (shownSessionEpoch.current === epoch) setChatBusy(false) }
  }

  async function showCase(caseIndex: number) {
    if (!session || applyingCase !== undefined) return
    const epoch = shownSessionEpoch.current
    setSelectedCase(caseIndex)
    setApplyingCase(caseIndex)
    setError(undefined)
    try {
      const next = await api.showCase(session.id, caseIndex)
      if (shownSessionId.current === session.id && shownSessionEpoch.current === epoch) setWorldCase(next)
    } catch (reason) {
      if (shownSessionId.current === session.id && shownSessionEpoch.current === epoch) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (shownSessionId.current === session.id && shownSessionEpoch.current === epoch) setApplyingCase(undefined)
    }
  }

  async function retryLayout(instruction?: string) {
    if (!session || layoutRetryBusy) return
    const epoch = shownSessionEpoch.current
    layoutRequestSeq.current = session.latestSeq
    setLayoutRetryBusy(true)
    setError(undefined)
    try {
      await api.retryLayout(session.id, instruction)
      if (instruction && shownSessionEpoch.current === epoch) setRevisionInstruction('')
    } catch (reason) {
      if (shownSessionEpoch.current === epoch) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setLayoutRetryBusy(false)
      }
    }
  }

  function guideLayout(event: FormEvent) {
    event.preventDefault()
    const instruction = revisionInstruction.trim()
    if (instruction) void retryLayout(instruction)
  }

  const task = session?.artifacts.task
  const logic = session?.artifacts.logicDesign
  const layout = session?.artifacts.physicalLayout
  const verification = useMemo(() => sessionVerification(session, events), [session, events])
  const report = verification.report
  const inspection = session?.artifacts.worldInspectionReport
  const inspectedBlocks = inspection?.failedCases.reduce((total, item) => total + item.observations.length, 0) ?? 0
  const placementMismatches = inspection?.failedCases.reduce(
    (total, item) => total + item.observations.filter((observation) => !observation.matchedExpected).length,
    0,
  ) ?? 0
  const inspectionErrors = inspection?.failedCases.reduce((total, item) => total + item.errors.length, 0) ?? 0
  const activeModel = runtime?.models.find((option) => option.id === selectedModel)
  const sessionModel = runtime?.models.find((option) => option.id === session?.model)
  const failure = verification.recovered ? undefined : session?.state === 'FAILED' ? sessionFailure(session.error)
    : verification.state === 'FAILED' ? { message: '最新 Minecraft 重测未通过，请查看实际读回结果。' } : undefined
  const activePhase = session ? phaseIndex(verification.state ?? session.state, session.artifacts, session.error) : -1
  const showLayoutRevision = session ? canReviseLayout(session.state, session.artifacts, session.error, Boolean(session.logicCheck?.passed)) : false
  const showLayoutRestart = session ? canRestartLayout(
    session.state,
    session.error,
    session.artifacts,
    Boolean(session.logicCheck?.passed),
  ) : false
  // After a failed layout round, the best layout may still be built for
  // failure-case analysis when only simulated rows are wrong.
  const experimentalBuildReady = session ? canStartExperimentalBuild(session) : false
  const layoutEligibility = showLayoutRestart ? experimentalBuildEligibility(session?.layoutValidation) : undefined
  const displayedStateLabel = session ? sessionStateLabel(verification.state ?? session.state, Boolean(session.experimentalBuild)) : undefined
  const placedBlocks = buildProgress?.placed ?? session?.artifacts.buildRun?.placed ?? 0
  const viewerReady = Boolean(
    runtime?.authoritative
    && runtime.viewerUrl && session?.worldView?.available && session.worldView.viewerUrl
    && (session?.artifacts.buildRun || events.some((event) => event.type === 'minecraft.workspace.reset')),
  )
  const hasLayoutProcess = events.some((event) => {
    const payload = event.payload as { stage?: string; kind?: string }
    return (event.type.startsWith('model.') && payload.stage === 'layout')
      || (event.type === 'artifact.created' && payload.kind === 'PhysicalLayout')
      || event.type === 'layout.validation.completed'
      || event.type === 'layout.best_candidate.updated'
      || event.type === 'layout.patch.reverted'
      || event.type === 'layout.patch.rejected'
  })

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><img className="brand-mark" src={redstoneLogo} alt="Minecraft 红石" /><div><strong>MICA</strong><small>Minecraft Intelligent Circuit Architect</small></div></div>
        <div className="runtime-badges">
          <span className={`badge model ${runtime?.modelMode === 'fixture' ? 'fixture' : 'llm'}`}><i />{runtime?.modelMode === 'fixture' ? 'Fixture · 预置 NOT' : sessionModel?.name ?? session?.model ?? activeModel?.name ?? '正在读取模型'}</span>
          <span className={`badge ${runtime?.authoritative ? 'live' : 'mock'}`}><i />{runtime?.authoritative ? 'Minecraft · 实际世界' : 'Minecraft · 模拟环境'}</span>
          {session && <span className={`state-pill ${(verification.state ?? session.state).toLowerCase()}`}>{displayedStateLabel}</span>}
        </div>
      </header>

      {!runtime?.authoritative && <div className="global-warning"><b>演示模式</b>当前 Minecraft 适配器是 mock；可验证 UI、状态机和记录链路，但不会产生真实世界成功结论。使用 <code>MINECRAFT_MODE=live</code> 切换。</div>}
      {runtime?.modelMode === 'fixture' && <div className="global-warning fixture-warning"><b>预置 Agent</b>当前 TaskSpec、LogicDesign、PhysicalLayout 和对话来自代码内样例，不是 LLM 即时生成。使用 <code>MODEL_MODE=openrouter</code> 启用真实模型。</div>}
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}

      {restoring ? (
        <section className="empty-stage" aria-live="polite"><div className="pulse-node" /><span>正在恢复会话…</span></section>
      ) : !session ? (
        <section className="launch-screen">
          <div className="launch-copy">
            <span className="eyebrow">MICA · 三维数字电路智能体</span>
            <h1>三维数字电路<br />设计与搭建智能体</h1>
            <p>用一句话描述你想要的数字电路。</p>
            <div className="contract-chain">
              {[
                { zh: '理解需求', hint: '文字 → 输入输出与真值表' },
                { zh: '设计逻辑', hint: '选择门电路、写出逻辑式' },
                { zh: '规划布局', hint: '排出红石元件三维坐标' },
                { zh: '逐块搭建', hint: '在世界里逐个放置方块' },
                { zh: '验证真值表', hint: '读回世界状态逐行比对' },
              ].map((step, index) => (
                <span key={step.zh}><b>0{index + 1}</b><strong>{step.zh}</strong><em>{step.hint}</em></span>
              ))}
            </div>
            <SessionList sessions={sessions} models={runtime?.models ?? []} onOpen={openListedSession} />
          </div>
          <form className="launch-card" onSubmit={create}>
            <h2>创建工程会话</h2>
            <label htmlFor="request">电路要求</label>
            <textarea id="request" value={request} onChange={(event) => setRequest(event.target.value)} rows={7} />
            <div className="model-field">
              <label htmlFor="model">推理模型</label>
              <div className="select-wrap">
                <select
                  id="model"
                  value={selectedModel}
                  disabled={!runtime || runtime.modelMode === 'fixture'}
                  onChange={(event) => setSelectedModel(event.target.value)}
                >
                  {(runtime?.models ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="launch-notes"><span>完整真值表</span><span>相对坐标</span><span>实际读回</span></div>
            <button className="primary large" disabled={busy || request.trim().length < 3 || !selectedModel}>{busy ? '正在创建…' : '开始设计'}</button>
          </form>
        </section>
      ) : (
        <>
          <section className="session-header">
            <div>
              <div className="session-title-row"><h1>{task?.title ?? (session.state === 'FAILED' ? '任务未能完成' : 'Agent 正在理解任务…')}</h1><code>{session.id.split('-').slice(-1)[0]}</code>{session.experimentalBuild && <em className="experimental-tag">实验搭建 · 布局 v{session.experimentalBuild.layoutRef.version} 未通过模拟（模拟 {session.experimentalBuild.simulatedPassedCases}/{session.experimentalBuild.simulatedTotalCases} 行通过）</em>}</div>
              <p>{verification.recovered ? `真实 Minecraft 验证通过：计入最新重测，${report?.passedCases}/${report?.totalCases} 用例通过。` : failure?.message ?? session.activity}</p>
              {failure?.helpUrl && <a href={failure.helpUrl} target="_blank" rel="noreferrer">{failure.helpLabel}</a>}
              {failure && <details><summary>原始错误</summary><p>{session.error?.message}</p></details>}
            </div>
            <div className="header-actions">
              {session.state === 'AWAITING_DESIGN_REVIEW' && <button className="primary" disabled={busy} onClick={() => command('approve')}>确认逻辑设计 →</button>}
              {(session.state === 'READY_TO_BUILD' || experimentalBuildReady) && <button className="primary danger" disabled={busy || layoutRetryBusy} onClick={() => command('build')}>逐块搭建并验证 →</button>}
              <button className="ghost" onClick={() => { setRequest(session.request); openSession(undefined) }}>{verification.state === 'FAILED' ? '保留要求，创建新任务' : '新任务'}</button>
            </div>
          </section>

          <nav className="phase-rail">
            {['需求契约', '逻辑设计', '空间布局', '世界搭建', '实际验证'].map((label, index) => (
              <div key={label} className={`${index < activePhase ? 'done' : ''} ${index === activePhase ? 'active' : ''}`}>
                <span>{index < activePhase ? '✓' : `0${index + 1}`}</span><b>{label}</b><i />
              </div>
            ))}
          </nav>

          <section className="workbench-grid">
            <article className="panel task-panel">
              <div className="panel-heading"><h2>任务与约束</h2>{task && <em>v{task.version}</em>}</div>
              {task ? <div className="task-overview">
                <div className="task-brief"><div className="description"><MarkdownMessage content={task.description} /></div></div>
                <div className="io-list">
                  <div><span>INPUTS</span>{task.inputs.map((input) => <b key={input.id}><i className="io-dot input" />{input.id}<small>{input.label}</small></b>)}</div>
                  <div><span>OUTPUTS</span>{task.outputs.map((output) => <b key={output.id}><i className="io-dot output" />{output.id}<small>{output.label}</small></b>)}</div>
                </div>
                <div className="task-contract-summary">
                  <div className="metrics-row"><Metric label="Cases" value={task.truthTable.length} /><Metric label="Max blocks" value={task.maxBlocks} /><Metric label="Stable reads" value={task.acceptance.stableReads} /></div>
                  <div className="constraint"><span>工作区尺寸</span><code>{task.workspace.size.x} × {task.workspace.size.y} × {task.workspace.size.z}</code></div>
                </div>
              </div> : session.state === 'FAILED'
                ? <div className="engineering-note"><p>{session.request}</p><p>任务契约未生成，流水线已停止。</p></div>
                : <div className="skeleton-stack"><i /><i /><i /></div>}
            </article>

            <article className="panel logic-panel">
              <div className="panel-heading"><h2>功能结构</h2>{logic && <em>v{logic.version}</em>}</div>
              {logic ? <>
                <LogicGraph design={logic} selected={selectedLogic} onSelect={setSelectedLogic} />
                <div className="logic-footer"><code>{Object.values(logic.equations).join(' · ')}</code><span className={session.logicCheck?.passed ? 'check-pass' : 'check-wait'}>{session.logicCheck?.passed ? '✓ 确定性真值表一致' : '等待检查'}</span></div>
                <p className="engineering-note">{selectedLogic
                  ? logic.explanation.componentNotes.find((note) => note.nodeId === selectedLogic)?.text ?? logic.explanation.overview
                  : logic.explanation.overview}</p>
              </> : <div className="empty-stage">{session.state === 'FAILED'
                ? <span>逻辑设计未生成，流水线已停止。</span>
                : <><div className="pulse-node" /><span>等待 LogicDesign</span></>}</div>}
            </article>

            <article className="panel chat-panel">
              <div className="panel-heading"><h2>智能问答</h2>{session && <em className={session.modelMode !== 'fixture' ? 'model-live' : 'model-fixture'}>{chatBusy ? '回答生成中' : verification.state === 'FAILED' ? '失败后仍可问答' : verification.recovered ? '可询问重测结果' : '可与流水线并行'}</em>}</div>
              <div className={`chat-channel-note ${verification.state === 'FAILED' ? 'recovery' : ''}`}><i /><span>{verification.state === 'FAILED'
                ? '工程流水线已停止；问答使用同一模型，也可能受到余额或访问限制'
                : '理解当前产物、校验结果与世界用例；问答不会修改工程产物'}</span></div>
              <div className="chat-log" ref={chatLogRef}>
                {conversation.length === 0 && <p>可以询问设计依据、布局细节、校验错误或当前 Minecraft 用例。</p>}
                {conversation.map((event) => {
                  const userMessage = event.type === 'conversation.user.message'
                  return <div key={event.seq} className={`chat-message ${userMessage ? 'user' : 'agent'}`}><span>{userMessage ? '你' : 'Agent'}</span><MarkdownMessage content={String((event.payload as { message?: string }).message ?? '')} /></div>
                })}
                {chatBusy && <div className="chat-message agent thinking" aria-live="polite"><span>Agent · {sessionModel?.name ?? session.model}</span><p>正在读取当前产物并回答；工程流水线会继续运行。</p></div>}
              </div>
              <form className="chat-form" onSubmit={sendChat}>
                <div className="chat-compose">
                  <textarea
                    aria-label="智能问答输入"
                    value={chat}
                    maxLength={20_000}
                    rows={3}
                    onChange={(event) => setChat(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit()
                    }}
                    placeholder="询问当前设计、选中元件或世界用例；支持 Markdown…"
                  />
                  <small>{chatBusy ? '可先输入下一条问题；当前回复完成后即可发送' : '支持 Markdown · Ctrl/⌘ + Enter 发送'}</small>
                </div>
                <button disabled={chatBusy || !chat.trim()}>{chatBusy ? '等待' : '发送'}</button>
              </form>
            </article>

            <article className="panel layout-panel">
              <div className="panel-heading"><h2>空间布局</h2>{layout && <em>PhysicalLayout · v{layout.version}</em>}</div>
              {showLayoutRevision && <form className="revision-form" onSubmit={guideLayout}>
                <div className="revision-intro">
                  <strong>第三步：重新运行空间布局</strong>
                  <span>{showLayoutRestart ? '上一轮布局尝试未通过。重新运行时可不填建议，也可加入修改建议。' : '布局检查与模拟已通过。如需调整，可在开始搭建前提交建议，开启新一轮。'}每轮最多尝试 {session.runPolicy.maxLayoutVersions} 次，修改后重新检查与模拟，通过后再点击开始搭建。</span>
                  {layoutEligibility && layout && (experimentalBuildReady
                    ? <p className="experimental-build-note"><b>失败分析：</b>当前最佳布局 v{layout.version} 结构检查已通过，只是模拟有 {layoutEligibility.simulatedTotalCases - layoutEligibility.simulatedPassedCases}/{layoutEligibility.simulatedTotalCases} 行与真值表不符。也可以直接点上方「逐块搭建并验证 →」，把它照原样搭进 Minecraft，对照实测与模拟的差别。</p>
                    : layoutEligibility.blockingCodes.length > 0 && <p className="experimental-build-note muted">当前最佳布局 v{layout.version} 仍有结构问题（{layoutEligibility.blockingCodes.map((code) => structuralIssueLabels[code] ?? code).join('、')}），搭进 Minecraft 也不能反映这个布局，所以不能实验搭建。</p>)}
                </div>
                {showLayoutRestart && <div className="automatic-correction">
                  <div><strong>继续自动修补</strong><span>模型参考当前布局与检查反馈，继续解决剩余问题。</span></div>
                  <button className="primary" type="button" disabled={layoutRetryBusy} onClick={() => { void retryLayout() }}>
                    {layoutRetryBusy ? '正在修补并模拟…' : '重新运行空间布局 →'}
                  </button>
                </div>}
                <label htmlFor="layout-revision-instruction">修改建议（可选）</label>
                <textarea
                  id="layout-revision-instruction"
                  value={revisionInstruction}
                  maxLength={2000}
                  rows={3}
                  disabled={layoutRetryBusy}
                  aria-describedby="layout-revision-hint"
                  placeholder="例如：保留输入与输出位置，补上火把到灯的红石线"
                  onChange={(event) => setRevisionInstruction(event.target.value)}
                />
                <div className="revision-actions">
                  <small id="layout-revision-hint">{revisionInstruction.length}/2000 · 只修改空间布局，需求和逻辑设计继续使用</small>
                  <button className="secondary" disabled={layoutRetryBusy || !revisionInstruction.trim()}>
                    {layoutRetryBusy ? '正在修订并模拟…' : '按我的建议修改并模拟 →'}
                  </button>
                </div>
              </form>}
              <div className="layout-workspace">
                <div className="layout-process-column">
                  {hasLayoutProcess
                    ? <LayoutProcessStream key={session.id} events={events} state={session.state} maxCandidates={session.runPolicy.maxLayoutVersions} />
                    : <div className="empty-stage compact">{session.state === 'FAILED'
                      ? <span>空间布局尚未开始，流水线已停止。</span>
                      : <><div className="pulse-node" /><span>逻辑确认后显示生成与校验过程</span></>}</div>}
                </div>
                <div className="layout-preview-column">
                  {layout ? <>
                    <LayoutLayers key={`${session.id}:${layout.id}:v${layout.version}`} layout={layout} selected={selectedLogic} onSelect={setSelectedLogic} />
                    <div className="layout-stats"><span><b>{layout.blocks.length}</b> blocks</span><span><b>{new Set(layout.blocks.map((block) => block.phase ?? 0)).size}</b> phases</span><span className={session.layoutValidation?.passed ? 'check-pass' : 'check-wait'}>{session.layoutValidation?.passed ? '✓ 安全校验通过' : session.layoutValidation && !['PLANNING_LAYOUT', 'VALIDATING_LAYOUT', 'REVISING'].includes(session.state) ? '✗ 校验未通过' : '校验中'}</span></div>
                  </> : <div className="empty-stage compact">{session.state === 'FAILED'
                    ? <span>本次运行未生成可展示的空间布局。</span>
                    : <><div className="grid-placeholder" /><span>等待可展示的 PhysicalLayout</span></>}</div>}
                </div>
              </div>
            </article>

            <article className="panel viewer-panel">
              <div className="panel-heading inverse"><h2>{viewerReady ? '本会话 Minecraft 世界' : '本会话布局预览'}</h2><em className={viewerReady ? 'live-signal' : 'sim-signal'}>{viewerReady ? '实时' : '非现场画面'}</em></div>
              <div className="case-control-note"><span>{session.id}{session.worldView?.origin ? ` · 世界原点 (${session.worldView.origin.x}, ${session.worldView.origin.y}, ${session.worldView.origin.z})` : ''}</span></div>
              {runtime?.authoritative && !viewerReady && <div className="case-control-note"><span>{session.worldView?.reason ?? '此会话尚无可展示的 Minecraft 现场；下方展示设计布局。'}</span></div>}
              <div className="viewer-frame">
                {viewerReady && runtime?.viewerUrl
                  ? <MinecraftViewer key={session.id} src={session.worldView!.viewerUrl!} title="Minecraft Viewer" />
                  : <MockWorldPreview key={session.id} layout={layout} placed={runtime?.authoritative ? 0 : placedBlocks} />}
                {viewerReady && buildProgress && <div className="build-overlay"><span>SETBLOCK</span><b>{buildProgress.placed} / {buildProgress.total}</b><progress max={buildProgress.total} value={buildProgress.placed} /></div>}
                {viewerReady && worldCase && task && <div className="world-case-overlay"><span>本会话最近读回</span><b>CASE {String(worldCase.index + 1).padStart(2, '0')}</b><small>{recordValues(worldCase.inputs, task.inputs.map((input) => input.id))} → {recordValues(worldCase.actual, task.outputs.map((output) => output.id))}</small><em>{worldCase.passed ? 'READBACK MATCH' : 'READBACK MISMATCH'}</em></div>}
              </div>
            </article>

            <article className="panel verification-panel">
              <div className="panel-heading"><h2>{report ? `${report.passedCases}/${report.totalCases} 用例通过` : '验收真值表'}</h2>{report && <em className={report.passed ? 'success' : 'failure'}>{report.passed ? '通过' : '失败'}</em>}</div>
              {report?.passed === false && <div className="revision-form">
                <div className="revision-intro">
                  <strong>游戏实测未通过</strong>
                  <span>本次验收结束，已保存失败报告与现场记录。</span>
                </div>
                {inspection && <div className="inspection-summary" aria-label="世界审查摘要">
                  <span><b>{inspection.failedCases.length}</b> 个失败输入</span>
                  <span><b>{inspectedBlocks}</b> 次方块状态读回</span>
                  <span><b>{placementMismatches}</b> 个放置差异</span>
                  {inspectionErrors > 0 && <span><b>{inspectionErrors}</b> 个读取异常</span>}
                  <em>{inspection.authoritative ? '真实世界证据' : '模拟证据'}</em>
                </div>}
              </div>}
              {task ? <VerificationTable task={task} report={report} selectedCase={selectedCase} applyingCase={applyingCase} worldCase={worldCase} onSelectCase={report && session.worldView?.available ? showCase : undefined}
                unavailableReason={!report && session.error?.code === 'BUILD_FAILED'
                  ? '搭建未完成，尚未进入 Minecraft 真值表验证。下方仅显示预期结果，暂不能点击实测。'
                  : undefined} /> : <div className="empty-stage"><span>等待 TaskSpec</span></div>}
            </article>

            <article className="panel timeline-panel">
              <div className="panel-heading"><h2>工程时间线</h2><em>{events.length} 条事件</em></div>
              <div className="timeline-list">
                {[...events].reverse().slice(0, 40).map((event) => <div key={event.seq} className={event.type === 'run.error' ? 'error' : ''}><b>{String(event.seq).padStart(3, '0')}</b><i /><span><strong>{eventLabels[event.type] ?? event.type}</strong><small>{eventSummary(event)}</small></span><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time></div>)}
              </div>
            </article>
          </section>
          <footer className="session-usage-footer" aria-label="本 Session 累计 token 消耗">
            <div className="usage-heading">
              <strong>本 Session 累计 token 消耗</strong>
              <span>{tokenUsage.measuredResponses > 0
                ? `基于 ${tokenUsage.measuredResponses} 个模型已返回 usage 的响应；超时请求不计入。`
                : '等待模型返回可计量的 usage；Fixture 与超时请求不会产生 token 计量。'}</span>
            </div>
            <dl className="usage-values">
              <div><dt>总计</dt><dd>{tokenUsage.totalTokens.toLocaleString()}</dd></div>
              <div><dt>输入</dt><dd>{tokenUsage.promptTokens.toLocaleString()}</dd></div>
              <div><dt>输出</dt><dd>{tokenUsage.completionTokens.toLocaleString()}</dd></div>
              <div><dt>模型</dt><dd className="usage-model">{sessionModel?.name ?? session.model}</dd></div>
            </dl>
          </footer>
        </>
      )}
    </main>
  )
}
