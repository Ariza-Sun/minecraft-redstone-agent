import type { SessionEvent, SessionState } from '@domain/domain'

// Presentation-only helpers for the workbench: Chinese phase/event labels,
// per-event one-line summaries, and small formatting utilities.

export const DEFAULT_REQUEST = '搭一个非门。输入用拉杆，输出用红石灯；拉杆关时灯亮，开时灯灭'

/**
 * State label that keeps "the layout failed" visible after an experimental
 * build, so the final label never reads like a normal pass or a normal
 * in-game failure.
 */
export function sessionStateLabel(state: SessionState, experimentalBuild?: boolean): string {
  const label = stateLabels[state] ?? state
  if (!experimentalBuild) return label
  if (state === 'SUCCEEDED') return '布局未通过 · 实验实测通过'
  if (state === 'FAILED') return '布局未通过 · 实验实测未通过'
  return `实验搭建 · ${label}`
}

/** Short Chinese names for the layout issues that block an experimental build. */
export const structuralIssueLabels: Record<string, string> = {
  DUPLICATE_BLOCK_ID: '方块 id 重复',
  DUPLICATE_POSITION: '坐标重叠',
  MISSING_SUPPORT: '缺少依附方块',
  INVALID_SUPPORT_BLOCK: '依附方块不合适',
  INVALID_BLOCKSTATE: '方块属性非法',
  UNKNOWN_BLOCKSTATE: '方块属性未知',
  INVALID_INPUT_PORT: '输入端口不对',
  INVALID_OUTPUT_PORT: '输出端口不对',
  INPUT_PORT_NOT_EXCLUSIVE: '输入端口被占用',
  OUTPUT_PORT_NOT_EXCLUSIVE: '输出端口被占用',
  OUT_OF_BOUNDS: '方块超出边界',
  BOUNDS_EXCEED_WORKSPACE: '布局超出工作区',
  BLOCK_BUDGET_EXCEEDED: '方块数超限',
  BLOCK_NOT_ALLOWED: '使用了不允许的方块',
  STALE_LOGIC_REF: '对应的逻辑设计已过期',
  UNKNOWN_LOGIC_MAPPING: '对应了不存在的逻辑元件',
  UNMAPPED_LOGIC_ID: '有逻辑元件没有对应方块',
}

export const stateLabels: Record<SessionState, string> = {
  CREATED: '已创建',
  COLLECTING_REQUIREMENTS: '整理需求',
  DESIGNING_LOGIC: '逻辑设计',
  CHECKING_LOGIC: '逻辑检查',
  AWAITING_DESIGN_REVIEW: '等待审阅',
  PLANNING_LAYOUT: '空间规划',
  VALIDATING_LAYOUT: '布局校验',
  READY_TO_BUILD: '可以搭建',
  BUILDING: '逐块搭建',
  VERIFYING: '真值表验证',
  INSPECTING_WORLD: '审查 Minecraft',
  AWAITING_LAYOUT_REPAIR: '旧版实测失败',
  REVISING: '自主修订',
  SUCCEEDED: '真实验证通过',
  COMPLETED_NON_AUTHORITATIVE: '演示链路完成',
  PAUSED: '已暂停',
  FAILED: '运行失败',
  CANCELLED: '已取消',
}

export const eventLabels: Record<string, string> = {
  'session.created': '会话创建',
  'session.cancelled': '任务已取消',
  'experiment.imported': '导入计时实验',
  'session.state.changed': '阶段切换',
  'agent.activity.updated': 'Agent 活动',
  'agent.action.proposed': '结构化动作',
  'model.call.started': '模型调用开始',
  'model.attempt.started': '模型尝试开始',
  'model.output.received': '收到模型输出',
  'model.output.rejected': '模型输出拒绝',
  'model.output.accepted': '模型输出可用',
  'model.call.completed': '模型响应',
  'artifact.created': '产物固化',
  'task.validation.completed': '任务校验',
  'logic.check.completed': '逻辑检查',
  'design.review.approved': '人工确认',
  'layout.revision.requested': '请求修订布局',
  'layout.retry.requested': '重新运行空间布局',
  'layout.validation.completed': '布局校验',
  'layout.best_candidate.updated': '最佳布局更新',
  'layout.patch.reverted': '布局 Patch 回滚',
  'layout.patch.rejected': '布局 Patch 拒绝',
  'world.inspection.case.started': '审查失败用例',
  'world.inspection.case.completed': '世界读回完成',
  'world.inspection.completed': '世界审查完成',
  'world.correction.requested': '请求物理纠错（历史）',
  'world.correction.cycle.started': '纠错循环开始（历史）',
  'world.correction.completed': '物理纠错完成（历史）',
  'world.correction.exhausted': '纠错循环结束（历史）',
  'world.correction.failed': '本轮纠错已恢复（历史）',
  'world.correction.recovered': '恢复世界审查（历史）',
  'minecraft.connected': 'Minecraft 连接',
  'minecraft.workspace.reset': '工作区重置',
  'minecraft.workspace.reserved': '分配独立工作区',
  'build.started': '开始搭建',
  'build.block.completed': '方块落位',
  'build.completed': '搭建完成',
  'build.failed': '搭建失败',
  'verification.case.completed': '测试用例',
  'verification.completed': '验证完成',
  'minecraft.case.apply.started': '切换世界用例',
  'minecraft.case.applied': '世界状态就绪',
  'minecraft.case.apply.failed': '世界状态失败',
  'conversation.user.message': '用户消息',
  'conversation.agent.reply': 'Agent 回复',
  'conversation.failed': '对话失败',
  'run.error': '结构化错误',
}

export const streamEvents = Object.keys(eventLabels)

export function eventSummary(event: SessionEvent): string {
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload) return ''
  if (event.type === 'session.cancelled' || event.type === 'experiment.imported') return String(payload.message ?? '')
  if (event.type === 'session.state.changed') return `${stateLabels[String(payload.from) as SessionState] ?? payload.from} → ${stateLabels[String(payload.to) as SessionState] ?? payload.to}`
  if (event.type === 'agent.activity.updated') return String(payload.message ?? '')
  if (event.type === 'agent.action.proposed') return String(payload.type ?? '')
  if (event.type === 'model.call.started') return `${payload.stage} · ${payload.model}`
  if (event.type === 'model.attempt.started') return `${payload.stage} · 尝试 ${payload.attempt}/${payload.maxAttempts}`
  if (event.type === 'model.output.received') return `${payload.stage} · ${((payload.usage as { totalTokens?: number })?.totalTokens ?? 0).toLocaleString()} tokens`
  if (event.type === 'model.output.rejected') return String(payload.reason ?? '')
  if (event.type === 'model.output.accepted') return `${payload.stage} · ${payload.actionType}`
  if (event.type === 'artifact.created') return `${payload.kind} · v${(payload.artifact as { version?: number })?.version ?? '?'}`
  if (event.type === 'layout.revision.requested') {
    const mode = payload.revisionMode === 'human_guided' ? '用户指导修订' : '自动修订'
    return `${mode} · 基于 PhysicalLayout v${(payload.previousLayoutRef as { version?: number })?.version ?? '?'}`
  }
  if (event.type === 'layout.retry.requested') return `保留既有逻辑 · 继承 ${payload.priorAttempts ?? 0} 次失败记录`
  if (event.type === 'layout.best_candidate.updated') return `PhysicalLayout v${(payload.bestLayoutRef as { version?: number })?.version ?? '?'} · ${payload.issueCount ?? '?'} 个问题`
  if (event.type === 'layout.patch.reverted') return `候选 v${(payload.candidateLayoutRef as { version?: number })?.version ?? '?'} 未改善 · 回到 v${(payload.bestLayoutRef as { version?: number })?.version ?? '?'}`
  if (event.type === 'layout.patch.rejected') return String((payload.errors as string[] | undefined)?.join('；') ?? 'Patch 无法应用')
  if (event.type === 'world.inspection.case.started') return `Case ${Number(payload.caseIndex) + 1} · 正在重放失败输入`
  if (event.type === 'world.inspection.case.completed') return `Case ${Number(payload.caseIndex) + 1} · ${payload.observedBlocks ?? 0} 个方块 · ${payload.mismatchedBlocks ?? 0} 个放置差异`
  if (event.type === 'world.inspection.completed') return `${payload.failedCases ?? 0} 个失败用例 · ${payload.observedBlocks ?? 0} 次方块状态读回`
  if (event.type === 'world.correction.requested') return `${payload.mode === 'human_guided' ? '人工引导' : '自动纠错'} · TaskSpec / LogicDesign 已冻结`
  if (event.type === 'world.correction.cycle.started') return `第 ${payload.cycle}/${payload.maxCycles} 轮 · 仅修订 PhysicalLayout`
  if (event.type === 'world.correction.completed') return `${payload.cyclesUsed ?? 0} 轮后验证通过`
  if (event.type === 'world.correction.exhausted') return `${payload.cyclesUsed ?? 0} 轮后仍未通过（历史记录）`
  if (event.type === 'world.correction.failed') return String((payload.error as { message?: string } | undefined)?.message ?? '已恢复上一份世界证据')
  if (event.type === 'world.correction.recovered') return `PhysicalLayout v${(payload.layoutRef as { version?: number } | undefined)?.version ?? '?'} · 历史记录`
  if (event.type === 'logic.check.completed' || event.type === 'layout.validation.completed') return payload.passed ? '检查通过' : `${(payload.issues as unknown[])?.length ?? 0} 个问题`
  if (event.type === 'build.block.completed') return `${payload.placed}/${payload.total} · ${(payload.block as { block?: string })?.block?.replace('minecraft:', '')}`
  if (event.type === 'verification.case.completed') return `Case ${Number(payload.index) + 1} · ${payload.passed ? 'PASS' : 'FAIL'}`
  if (event.type === 'minecraft.case.apply.started') return `Case ${Number(payload.index) + 1} · 正在设置输入`
  if (event.type === 'minecraft.case.applied') return `Case ${Number(payload.index) + 1} · ${payload.passed ? 'WORLD MATCH' : 'WORLD MISMATCH'}`
  if (event.type === 'minecraft.case.apply.failed' || event.type === 'conversation.failed') return String(payload.message ?? '')
  if (event.type === 'conversation.user.message' || event.type === 'conversation.agent.reply') return String(payload.message ?? '')
  if (event.type === 'run.error') return String(payload.message ?? '')
  return ''
}

export function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return <div className={`metric ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>
}

export function recordValues(record: Record<string, unknown>, ids: string[]): string {
  return ids.map((id) => `${id}=${String(record[id])}`).join(' · ')
}
