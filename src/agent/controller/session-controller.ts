import { randomUUID } from 'node:crypto'
import {
  logicDesignSchema,
  physicalLayoutSchema,
  taskSpecSchema,
  versionRef,
  type AgentAction,
  type ArtifactBundle,
  type LogicDesign,
  type OutputValue,
  type PhysicalLayout,
  type Position,
  type RunPolicy,
  type RunError,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
  type SessionSummary,
  type TaskSpec,
  type VerificationCase,
  type VerificationReport,
  type VersionRef,
  type WorldCaseState,
  type WorldInspectionReport,
} from '@domain/domain'
import type { ArtifactStore } from '@platform/artifact-store'
import type { RestoredSession } from '@platform/artifact-store'
import type { MinecraftAdapter } from '@minecraft/minecraft-adapter'
import type { ConversationFocus, ModelAdapter, ModelContext } from '@agent/model/model-adapter'
import { DeterministicLayoutValidator, compareLayoutValidations, issueCounts } from '@agent/tools/layout-validator'
import { DeterministicLogicChecker } from '@agent/tools/logic-checker'
import { MinecraftTruthTableVerifier } from '@agent/tools/verifier'
import { taskSemanticIssues } from './task-semantics'
import { LAYOUT_REPAIR_DIRECTIVE, compactLayoutIssues, compactLayoutValidation, compactValidationHistory } from './layout-feedback'
import { materializeLayoutRepair } from './layout-repair'
import { sessionVerification } from '@domain/session-verification'
import { allocateSessionWorkspace, workspacesOverlap, type SessionWorkspace } from '@domain/session-workspace'
import { canStartExperimentalBuild, experimentalBuildEligibility } from '@domain/experimental-build'

type SessionRecord = SessionSnapshot & { events: SessionEvent[] }

type LayoutRevisionMode = 'automatic' | 'human_guided'

export class SessionCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SessionCommandError'
  }
}

const transitions: Record<SessionState, SessionState[]> = {
  CREATED: ['COLLECTING_REQUIREMENTS', 'FAILED', 'CANCELLED'],
  COLLECTING_REQUIREMENTS: ['DESIGNING_LOGIC', 'FAILED', 'CANCELLED'],
  DESIGNING_LOGIC: ['CHECKING_LOGIC', 'FAILED', 'CANCELLED'],
  CHECKING_LOGIC: ['AWAITING_DESIGN_REVIEW', 'REVISING', 'FAILED', 'CANCELLED'],
  AWAITING_DESIGN_REVIEW: ['PLANNING_LAYOUT', 'FAILED', 'CANCELLED'],
  PLANNING_LAYOUT: ['VALIDATING_LAYOUT', 'REVISING', 'FAILED', 'CANCELLED'],
  VALIDATING_LAYOUT: ['READY_TO_BUILD', 'REVISING', 'FAILED', 'CANCELLED'],
  READY_TO_BUILD: ['PLANNING_LAYOUT', 'BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['VERIFYING', 'FAILED', 'CANCELLED', 'PAUSED'],
  VERIFYING: ['SUCCEEDED', 'COMPLETED_NON_AUTHORITATIVE', 'INSPECTING_WORLD', 'FAILED', 'CANCELLED'],
  INSPECTING_WORLD: ['FAILED', 'CANCELLED'],
  AWAITING_LAYOUT_REPAIR: ['FAILED', 'CANCELLED'],
  REVISING: ['DESIGNING_LOGIC', 'PLANNING_LAYOUT', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  COMPLETED_NON_AUTHORITATIVE: [],
  PAUSED: ['BUILDING', 'VERIFYING', 'FAILED', 'CANCELLED'],
  // FAILED → BUILDING only for an experimental build (see startBuild).
  FAILED: ['PLANNING_LAYOUT', 'BUILDING'],
  CANCELLED: [],
}

function now(): string {
  return new Date().toISOString()
}

function runError(error: unknown, fallbackCode: string): RunError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const code = String(error.code)
    return {
      code,
      message: String(error.message),
      details: 'details' in error ? error.details : undefined,
      recoverable: 'recoverable' in error
        ? Boolean(error.recoverable)
        : code === 'LAYOUT_VALIDATION_FAILED' || code === 'LAYOUT_RETRY_PIPELINE_FAILED',
    }
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
  }
}

function nextPhysicalLayoutVersion(session: SessionRecord): number {
  let highest = session.artifacts.physicalLayout?.version ?? 0
  for (const event of session.events) {
    if (event.type !== 'artifact.created') continue
    const payload = event.payload as { kind?: unknown; artifact?: { version?: unknown } }
    if (payload.kind !== 'PhysicalLayout') continue
    const version = payload.artifact?.version
    if (typeof version === 'number' && Number.isInteger(version)) highest = Math.max(highest, version)
  }
  return highest + 1
}

export class SessionController {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly conversationQueues = new Map<string, Promise<void>>()
  private readonly eventQueues = new Map<string, Promise<void>>()
  private readonly layoutRevisions = new Set<string>()
  private readonly pendingBuilds = new Set<string>()
  private readonly buildVersions = new Map<string, number>()
  private readonly verificationVersions = new Map<string, number>()
  private readonly inspectionVersions = new Map<string, number>()
  private minecraftQueue: Promise<void> = Promise.resolve()
  private activeWorldSessionId?: string
  private readonly logicChecker = new DeterministicLogicChecker()
  private readonly layoutValidator: DeterministicLayoutValidator
  private readonly verifier: MinecraftTruthTableVerifier

  constructor(
    private readonly store: ArtifactStore,
    private readonly model: ModelAdapter,
    private readonly minecraft: MinecraftAdapter,
    private readonly runPolicy: RunPolicy = {
      maxTaskVersions: 2,
      maxLogicVersions: 3,
      maxLayoutVersions: 5,
    },
    restoredSessions: RestoredSession[] = [],
  ) {
    this.layoutValidator = new DeterministicLayoutValidator({ simulate: runPolicy.simulateLayouts ?? true })
    this.verifier = new MinecraftTruthTableVerifier(minecraft)
    for (const restored of restoredSessions) {
      const sessionId = restored.snapshot.id
      this.sessions.set(sessionId, {
        ...structuredClone(restored.snapshot),
        events: structuredClone(restored.events),
      })
      this.buildVersions.set(sessionId, restored.snapshot.artifacts.buildRun?.version ?? 0)
      this.verificationVersions.set(sessionId, restored.snapshot.artifacts.verificationReport?.version ?? 0)
      this.inspectionVersions.set(sessionId, restored.snapshot.artifacts.worldInspectionReport?.version ?? 0)
    }
    // Reconnect to the existing circuit after a reload, without rebuilding it
    // or assigning its ownership to an older session just opened in the UI.
    const latestReset = restoredSessions.flatMap((restored) => restored.events)
      .filter((event) => event.type === 'minecraft.workspace.reset')
      .sort((a, b) => a.at.localeCompare(b.at)).at(-1)
    this.activeWorldSessionId = latestReset?.sessionId
  }

  async restoreWorldConnection(): Promise<void> {
    if (this.minecraft.mode === 'live' && this.activeWorldSessionId) {
      const view = this.worldView(this.activeWorldSessionId)
      if (view.origin) this.minecraft.selectWorkspace(view.origin)
      await this.minecraft.connect()
    }
  }

  async positionObserver(username: string, position: Position): Promise<void> {
    // Moving a named observer does not change the builder's workspace, inputs,
    // or blocks. It must not wait behind the build-and-verification lock.
    await this.minecraft.connect()
    if (!this.minecraft.positionObserver) throw new Error('Minecraft adapter cannot position an observer')
    await this.minecraft.positionObserver(username, position)
  }

  private workspaceResets() {
    return [...this.sessions.values()].flatMap((session) => session.events.flatMap((event) => {
      if (event.type !== 'minecraft.workspace.reset') return []
      const payload = event.payload as { worldOrigin?: SessionWorkspace['origin']; workspace?: { size?: SessionWorkspace['size'] } }
      if (!payload.worldOrigin || !payload.workspace?.size) return []
      return [{ sessionId: session.id, at: event.at, origin: payload.worldOrigin, size: payload.workspace.size }]
    }))
  }

  worldView(sessionId: string): NonNullable<SessionSnapshot['worldView']> {
    const session = this.require(sessionId)
    const resets = this.workspaceResets()
    const own = resets.filter((item) => item.sessionId === sessionId).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
    if (!own) return { available: false, origin: session.worldWorkspace?.origin, reason: '此会话尚未完成 Minecraft 工作区准备。' }
    const overwritten = resets.some((other) => other.sessionId !== sessionId && other.at >= own.at && workspacesOverlap(own, other))
    if (overwritten) return { available: false, origin: own.origin, reason: '此旧会话的共享工作区已被后续任务覆盖；下方仅显示本会话的布局预览。' }
    return { available: true, origin: own.origin,
      viewerUrl: this.minecraft.mode === 'live' ? `/minecraft-viewer/${encodeURIComponent(sessionId)}/` : undefined }
  }

  async create(
    request: string,
    mode: 'interactive' | 'benchmark' = 'interactive',
    requestedModel?: string,
  ): Promise<SessionSnapshot> {
    const id = `session-${Date.now()}-${randomUUID().slice(0, 8)}`
    const timestamp = now()
    const selectedModel = this.model.mode !== 'fixture'
      ? requestedModel ?? this.model.model
      : this.model.model
    const record: SessionRecord = {
      id,
      state: 'CREATED',
      mode,
      createdAt: timestamp,
      updatedAt: timestamp,
      request,
      model: selectedModel,
      modelMode: this.model.mode,
      minecraftMode: this.minecraft.mode,
      authoritative: this.minecraft.authoritative,
      runPolicy: this.runPolicy,
      activity: 'Session created',
      artifacts: {},
      latestSeq: 0,
      events: [],
    }
    this.sessions.set(id, record)
    await this.store.createSession(this.snapshot(record))
    await this.emit(record, 'session.created', {
      request,
      mode,
      model: selectedModel,
      modelMode: record.modelMode,
      minecraftMode: this.minecraft.mode,
      authoritative: this.minecraft.authoritative,
      runPolicy: this.runPolicy,
    })
    await this.setState(record, 'COLLECTING_REQUIREMENTS', '正在把自然语言请求整理为 TaskSpec')
    return this.snapshot(record)
  }

  begin(sessionId: string): void {
    this.enqueue(sessionId, async () => {
      const session = this.require(sessionId)
      try {
        await this.produceTask(session)
        await this.produceLogic(session)
        if (session.mode === 'benchmark' && session.state === 'AWAITING_DESIGN_REVIEW') {
          await this.emit(session, 'design.review.auto_approved', { policy: 'benchmark-fixed-policy' })
          await this.produceLayout(session)
        }
      } catch (error) {
        await this.fail(session, error, 'SESSION_PIPELINE_FAILED')
      }
    })
  }

  approveDesign(sessionId: string): void {
    const current = this.require(sessionId)
    if (current.state !== 'AWAITING_DESIGN_REVIEW') {
      throw new Error(`approve-design is not allowed in ${current.state}`)
    }
    this.enqueue(sessionId, async () => {
      const session = this.require(sessionId)
      if (session.state !== 'AWAITING_DESIGN_REVIEW') {
        throw new Error(`approve-design is not allowed in ${session.state}`)
      }
      await this.emit(session, 'design.review.approved', {
        logicDesignRef: session.artifacts.logicDesign && versionRef(session.artifacts.logicDesign),
      })
      try {
        await this.produceLayout(session)
      } catch (error) {
        const cause = runError(error, 'LAYOUT_PIPELINE_FAILED')
        await this.fail(session, cause.code === 'LAYOUT_VALIDATION_FAILED'
          ? cause
          : {
              code: 'LAYOUT_PIPELINE_FAILED',
              message: cause.message,
              details: { cause },
              recoverable: true,
            }, 'LAYOUT_PIPELINE_FAILED')
      }
    })
  }

  reviseLayout(sessionId: string, instruction?: string): void {
    this.retryLayout(sessionId, instruction)
  }

  retryLayout(sessionId: string, instruction?: string): void {
    const session = this.require(sessionId)
    const normalizedInstruction = instruction?.trim() || undefined
    if (normalizedInstruction && normalizedInstruction.length > 2_000) {
      throw new SessionCommandError(
        'Layout retry instruction must be at most 2000 characters after trimming.',
        'LAYOUT_RETRY_INSTRUCTION_TOO_LONG',
      )
    }
    if (!['FAILED', 'READY_TO_BUILD'].includes(session.state) || session.artifacts.buildRun || session.artifacts.verificationReport) {
      throw new SessionCommandError(
        `Layout changes are only allowed before building; current state is ${session.state}.`,
        'LAYOUT_RETRY_INVALID_STATE',
      )
    }
    if (session.state === 'FAILED' && ![
      'LAYOUT_VALIDATION_FAILED',
      'LAYOUT_PIPELINE_FAILED',
      'LAYOUT_RETRY_PIPELINE_FAILED',
      // Backward compatibility for layout calls that failed before layout
      // pipeline errors were wrapped with stage-specific recovery semantics.
      'MODEL_HTTP_ERROR',
      'MODEL_FORMAT_INVALID',
      'MODEL_RESPONSE_INVALID',
      'MODEL_REQUEST_FAILED',
      'LAYOUT_RESTART_PIPELINE_FAILED',
    ].includes(session.error?.code ?? '')) {
      throw new SessionCommandError(
        `This failure cannot restart from PhysicalLayout: ${session.error?.code ?? 'UNKNOWN_FAILURE'}.`,
        'LAYOUT_RETRY_UNSUPPORTED_FAILURE',
      )
    }
    if (this.layoutRevisions.has(sessionId) || this.pendingBuilds.has(sessionId)) {
      throw new SessionCommandError(
        'A layout retry is already queued or running for this session.',
        'LAYOUT_RETRY_ALREADY_PENDING',
      )
    }

    const task = session.artifacts.task
    const design = session.artifacts.logicDesign
    const previousLayout = session.artifacts.physicalLayout
    const missing: string[] = []
    if (!task) missing.push('TaskSpec')
    if (!design) missing.push('LogicDesign')
    if (!session.logicCheck?.passed) missing.push('a passed LogicDesign check')
    if (missing.length > 0) {
      throw new SessionCommandError(
        `Layout retry prerequisites are not satisfied: missing ${missing.join(', ')}.`,
        'LAYOUT_RETRY_PRECONDITION_FAILED',
      )
    }

    const failureDetails = session.error?.details && typeof session.error.details === 'object'
      ? structuredClone(session.error.details as Record<string, unknown>)
      : {}
    // Guidance belongs to the round explicitly requested by the user. Keep
    // diagnostic history, but do not reactivate old advice on an automatic retry.
    delete failureDetails.userInstruction
    const previousHistory = Array.isArray(failureDetails.layoutValidationHistory)
      ? failureDetails.layoutValidationHistory
      : []
    const retryMode: LayoutRevisionMode = normalizedInstruction ? 'human_guided' : 'automatic'
    const feedback = {
      ...failureDetails,
      reason: 'layout_validation_retry',
      retryMode,
      previousFailure: {
        code: session.error?.code,
        message: session.error?.message,
      },
      layoutValidationHistory: previousHistory,
      repairMode: previousLayout ? 'patch_best_candidate' : undefined,
      revisionDirective: previousLayout
        ? 'Repair the preserved best PhysicalLayout with a local patch. Preserve every unmentioned block and reduce the remaining deterministic issues.'
        : 'No repair base is available; create one complete PhysicalLayout candidate.',
      ...(previousLayout ? { previousLayoutRef: versionRef(previousLayout) } : {}),
      ...(normalizedInstruction ? { userInstruction: normalizedInstruction } : {}),
    }

    this.layoutRevisions.add(sessionId)
    this.enqueue(sessionId, async () => {
      const queuedSession = this.require(sessionId)
      try {
        await this.emit(queuedSession, 'layout.retry.requested', {
          retryMode,
          priorAttempts: previousHistory.length,
          ...(previousLayout ? { previousLayoutRef: versionRef(previousLayout) } : {}),
          ...(normalizedInstruction ? { userInstruction: normalizedInstruction } : {}),
        }, [versionRef(task!), versionRef(design!), ...(previousLayout ? [versionRef(previousLayout)] : [])])
        queuedSession.error = undefined
        // Preserve both the best failed candidate and its deterministic score.
        // A restarted cycle must continue with repair_layout rather than falling
        // back to a fresh propose_layout call.
        await this.produceLayout(queuedSession, feedback, true)
      } catch (error) {
        const structured = runError(error, 'LAYOUT_RETRY_PIPELINE_FAILED')
        await this.fail(queuedSession, structured.code === 'LAYOUT_VALIDATION_FAILED'
          ? structured
          : {
              code: 'LAYOUT_RETRY_PIPELINE_FAILED',
              message: structured.message,
              details: { cause: structured },
              recoverable: true,
            }, 'LAYOUT_RETRY_PIPELINE_FAILED')
      } finally {
        this.layoutRevisions.delete(sessionId)
      }
    })
  }

  restartLayout(sessionId: string, instruction?: string): void {
    const session = this.require(sessionId)
    const normalizedInstruction = instruction?.trim() || undefined
    if (normalizedInstruction && normalizedInstruction.length > 2_000) {
      throw new SessionCommandError(
        'Fresh layout restart instruction must be at most 2000 characters after trimming.',
        'LAYOUT_RESTART_INSTRUCTION_TOO_LONG',
      )
    }
    if (session.state !== 'FAILED' || session.artifacts.buildRun || session.artifacts.verificationReport) {
      throw new SessionCommandError(
        `Fresh layout restart is only allowed for a failure before building; current state is ${session.state}.`,
        'LAYOUT_RESTART_INVALID_STATE',
      )
    }
    if (![
      'LAYOUT_VALIDATION_FAILED',
      'LAYOUT_PIPELINE_FAILED',
      'LAYOUT_RETRY_PIPELINE_FAILED',
      'LAYOUT_RESTART_PIPELINE_FAILED',
      'MODEL_HTTP_ERROR',
      'MODEL_FORMAT_INVALID',
      'MODEL_RESPONSE_INVALID',
      'MODEL_REQUEST_FAILED',
    ].includes(session.error?.code ?? '')) {
      throw new SessionCommandError(
        `This failure cannot restart PhysicalLayout from scratch: ${session.error?.code ?? 'UNKNOWN_FAILURE'}.`,
        'LAYOUT_RESTART_UNSUPPORTED_FAILURE',
      )
    }
    if (this.layoutRevisions.has(sessionId) || this.pendingBuilds.has(sessionId)) {
      throw new SessionCommandError(
        'A layout retry or restart is already queued or running for this session.',
        'LAYOUT_RESTART_ALREADY_PENDING',
      )
    }

    const task = session.artifacts.task
    const design = session.artifacts.logicDesign
    const previousLayout = session.artifacts.physicalLayout
    const missing: string[] = []
    if (!task) missing.push('TaskSpec')
    if (!design) missing.push('LogicDesign')
    if (!session.logicCheck?.passed) missing.push('a passed LogicDesign check')
    if (missing.length > 0) {
      throw new SessionCommandError(
        `Fresh layout restart prerequisites are not satisfied: missing ${missing.join(', ')}.`,
        'LAYOUT_RESTART_PRECONDITION_FAILED',
      )
    }

    const failureDetails = session.error?.details && typeof session.error.details === 'object'
      ? structuredClone(session.error.details as Record<string, unknown>)
      : {}
    const previousHistory = Array.isArray(failureDetails.layoutValidationHistory)
      ? failureDetails.layoutValidationHistory
      : []
    const retryMode: LayoutRevisionMode = normalizedInstruction ? 'human_guided' : 'automatic'
    const feedback = {
      reason: 'layout_fresh_restart',
      retryMode,
      previousFailure: {
        code: session.error?.code,
        message: session.error?.message,
      },
      revisionDirective: 'Generate a new complete propose_layout candidate with an independent topology. Do not patch or copy the failed PhysicalLayout.',
      ...(normalizedInstruction ? { userInstruction: normalizedInstruction } : {}),
    }

    this.layoutRevisions.add(sessionId)
    this.enqueue(sessionId, async () => {
      const queuedSession = this.require(sessionId)
      try {
        await this.emit(queuedSession, 'layout.restart.requested', {
          retryMode,
          priorAttempts: previousHistory.length,
          ...(previousLayout ? { previousLayoutRef: versionRef(previousLayout) } : {}),
          ...(normalizedInstruction ? { userInstruction: normalizedInstruction } : {}),
        }, [versionRef(task!), versionRef(design!), ...(previousLayout ? [versionRef(previousLayout)] : [])])
        queuedSession.error = undefined
        // Do not expose the failed PhysicalLayout to the model. Artifact files
        // and events remain immutable evidence, while the next version number
        // continues monotonically inside produceLayout.
        await this.produceLayout(queuedSession, feedback, false)
      } catch (error) {
        const structured = runError(error, 'LAYOUT_RESTART_PIPELINE_FAILED')
        await this.fail(queuedSession, structured.code === 'LAYOUT_VALIDATION_FAILED'
          ? structured
          : {
              code: 'LAYOUT_RESTART_PIPELINE_FAILED',
              message: structured.message,
              details: { cause: structured },
              recoverable: true,
            }, 'LAYOUT_RESTART_PIPELINE_FAILED')
      } finally {
        this.layoutRevisions.delete(sessionId)
      }
    })
  }

  /**
   * Builds a validated layout, or, after a layout round ran out of attempts,
   * builds the best layout as an experiment when its only remaining problems
   * are simulated truth-table mismatches (failure-case analysis).
   */
  startBuild(sessionId: string): void {
    const current = this.require(sessionId)
    if (current.state !== 'READY_TO_BUILD' && !canStartExperimentalBuild(current)) {
      throw new Error(`start-build is not allowed in ${current.state}`)
    }
    if (this.layoutRevisions.has(sessionId) || this.pendingBuilds.has(sessionId)) {
      throw new SessionCommandError('A layout change or build is already pending.', 'LAYOUT_RETRY_ALREADY_PENDING')
    }
    this.pendingBuilds.add(sessionId)
    this.enqueue(sessionId, async () => {
      const session = this.require(sessionId)
      try {
        if (session.state !== 'READY_TO_BUILD') {
          if (!canStartExperimentalBuild(session)) throw new Error(`start-build is not allowed in ${session.state}`)
          const eligibility = experimentalBuildEligibility(session.layoutValidation)
          session.experimentalBuild = {
            requestedAt: now(),
            layoutRef: versionRef(session.artifacts.physicalLayout!),
            unresolvedIssueCodes: [...new Set(session.layoutValidation!.issues.map((issue) => issue.code))],
            simulatedPassedCases: eligibility.simulatedPassedCases,
            simulatedTotalCases: eligibility.simulatedTotalCases,
          }
          session.error = undefined
          await this.emit(session, 'build.experimental.requested', {
            ...session.experimentalBuild,
            unresolvedIssues: session.layoutValidation!.issues,
          }, [session.experimentalBuild.layoutRef])
        }
        await this.withMinecraftLock(() => this.buildAndVerify(session))
      } catch (error) {
        await this.fail(session, error, 'BUILD_PIPELINE_FAILED')
      } finally {
        this.pendingBuilds.delete(sessionId)
      }
    })
  }

  sendMessage(sessionId: string, message: string, focus?: ConversationFocus): Promise<{ message: string }> {
    return this.scheduleConversation(sessionId, async () => {
      const session = this.require(sessionId)
      const conversationHistory = session.events.flatMap((event) => {
        if (event.type !== 'conversation.user.message' && event.type !== 'conversation.agent.reply') return []
        const payload = event.payload as { message?: unknown }
        if (typeof payload.message !== 'string') return []
        return [{
          role: event.type === 'conversation.user.message' ? 'user' as const : 'assistant' as const,
          content: payload.message,
        }]
      }).slice(-12)
      const displayedWorldCase = [...session.events]
        .reverse()
        .find((event) => event.type === 'minecraft.case.applied')?.payload as WorldCaseState | undefined
      await this.emit(session, 'conversation.user.message', { message, focus })
      try {
        const result = await this.callModel(session, {
          stage: 'conversation',
          sessionState: session.state,
          userRequest: session.request,
          userMessage: message,
          artifacts: structuredClone(session.artifacts),
          sessionId: session.id,
          conversationHistory,
          focus,
          deterministicContext: {
            logicCheck: session.logicCheck,
            layoutValidation: session.layoutValidation,
            displayedWorldCase,
          },
          provenance: { mode: session.modelMode, model: session.model },
        })
        if (result.type !== 'reply' && result.type !== 'report_blocker') {
          throw new Error(`Conversation returned disallowed action ${result.type}`)
        }
        const refs = result.type === 'reply' ? result.refs : undefined
        await this.emit(session, 'conversation.agent.reply', {
          message: result.message,
          refs,
          ...(result.type === 'report_blocker' ? { blockerCode: result.code } : {}),
        }, refs)
        return { message: result.message }
      } catch (error) {
        const structured = runError(error, 'CONVERSATION_FAILED')
        await this.emit(session, 'conversation.failed', structured)
        throw error
      }
    })
  }

  showVerificationCase(sessionId: string, caseIndex: number): Promise<WorldCaseState> {
    const current = this.require(sessionId)
    if (!current.artifacts.buildRun || !current.artifacts.verificationReport) {
      throw new Error(`show-case is not allowed in ${current.state}`)
    }
    return this.schedule(sessionId, () => this.withMinecraftLock(async () => {
      const session = this.require(sessionId)
      const task = session.artifacts.task
      const layout = session.artifacts.physicalLayout
      const run = session.artifacts.buildRun
      const row = task?.truthTable[caseIndex]
      if (!task || !layout || !run || !row) {
        throw { code: 'CASE_NOT_FOUND', message: `Verification case ${caseIndex} is unavailable` }
      }
      const view = this.worldView(session.id)
      if (!view.available || !view.origin) {
        throw {
          code: 'WORLD_SESSION_NOT_ACTIVE',
          message: view.reason ?? '此会话的 Minecraft 电路不可用。',
        }
      }
      this.minecraft.selectWorkspace(view.origin)
      await this.emit(session, 'minecraft.case.apply.started', { index: caseIndex, inputs: row.inputs }, [versionRef(run), versionRef(task)])
      try {
        await this.minecraft.connect()
        await this.minecraft.setInputs(task, row.inputs)
        await this.minecraft.triggerUpdate(task, layout)
        const readings = await this.minecraft.readOutputs(task, task.acceptance.stableReads)
        const actual: Record<string, OutputValue> = Object.fromEntries(task.outputs.map((output) => [
          output.id,
          readings[output.id]?.value ?? 'unreadable',
        ]))
        const state: WorldCaseState = {
          purpose: 'display',
          index: caseIndex,
          inputs: row.inputs,
          expected: row.outputs,
          actual,
          passed: task.outputs.every((output) => actual[output.id] === row.outputs[output.id]),
          evidence: task.outputs.flatMap((output) => readings[output.id]?.evidence ?? []),
          authoritative: run.environment.authoritative,
          appliedAt: now(),
        }
        await this.emit(session, 'minecraft.case.applied', state, [versionRef(run), versionRef(task), versionRef(layout)])
        return state
      } catch (error) {
        const structured = runError(error, 'WORLD_CASE_APPLY_FAILED')
        await this.emit(session, 'minecraft.case.apply.failed', { index: caseIndex, ...structured }, [versionRef(run), versionRef(task)])
        throw error
      }
    }))
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((record) => this.snapshot(record))
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      state: sessionVerification(session, session.events).state ?? session.state,
      mode: session.mode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      modelMode: session.modelMode,
      title: (session.artifacts.task?.title ?? session.request ?? '').slice(0, 120),
      ...(session.experimentalBuild ? { experimentalBuild: true } : {}),
    }))
  }

  get(sessionId: string): SessionSnapshot {
    return { ...this.snapshot(this.require(sessionId)), worldView: this.worldView(sessionId) }
  }

  events(sessionId: string, after = 0): SessionEvent[] {
    return this.require(sessionId).events.filter((event) => event.seq > after)
  }

  findArtifact(id: string, version: number): unknown {
    for (const session of this.sessions.values()) {
      for (const artifact of Object.values(session.artifacts)) {
        if (artifact && artifact.id === id && artifact.version === version) return structuredClone(artifact)
      }
    }
    return undefined
  }

  private schedule<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.scheduleOn(this.queues, sessionId, operation)
  }

  private scheduleConversation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.scheduleOn(this.conversationQueues, sessionId, operation)
  }

  private scheduleOn<T>(
    queue: Map<string, Promise<void>>,
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = queue.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    let tail: Promise<void>
    tail = result.then(
      () => {
        if (queue.get(sessionId) === tail) queue.delete(sessionId)
      },
      () => {
        if (queue.get(sessionId) === tail) queue.delete(sessionId)
      },
    )
    queue.set(sessionId, tail)
    return result
  }

  private enqueue(sessionId: string, operation: () => Promise<void>): void {
    void this.schedule(sessionId, operation)
      .catch(async (error) => {
        const session = this.sessions.get(sessionId)
        if (session && session.state !== 'FAILED') await this.fail(session, error, 'COMMAND_FAILED')
      })
      .catch((error) => console.error('Failed to record queued command error', error))
  }

  private withMinecraftLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.minecraftQueue.then(operation)
    this.minecraftQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private require(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    return session
  }

  private snapshot(session: SessionRecord): SessionSnapshot {
    const { events: _events, ...snapshot } = session
    return structuredClone(snapshot)
  }

  private emit(session: SessionRecord, type: string, payload: unknown, refs?: Array<{ id: string; version: number }>): Promise<void> {
    const previous = this.eventQueues.get(session.id) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const event: SessionEvent = {
        sessionId: session.id,
        seq: session.latestSeq + 1,
        at: now(),
        type,
        payload,
        refs,
      }
      session.latestSeq = event.seq
      session.updatedAt = event.at
      session.events.push(event)
      await this.store.appendEvent(event)
      await this.store.updateManifest(this.snapshot(session))
    })
    let tail: Promise<void>
    tail = operation.then(
      () => {
        if (this.eventQueues.get(session.id) === tail) this.eventQueues.delete(session.id)
      },
      () => {
        if (this.eventQueues.get(session.id) === tail) this.eventQueues.delete(session.id)
      },
    )
    this.eventQueues.set(session.id, tail)
    return operation
  }

  private async setState(session: SessionRecord, next: SessionState, activity: string): Promise<void> {
    if (!transitions[session.state].includes(next)) {
      throw new Error(`Invalid session transition ${session.state} → ${next}`)
    }
    const previous = session.state
    session.state = next
    session.activity = activity
    await this.emit(session, 'session.state.changed', { from: previous, to: next, activity })
    await this.emit(session, 'agent.activity.updated', { stage: next, message: activity })
  }

  private async fail(session: SessionRecord, error: unknown, code: string): Promise<void> {
    const structured = runError(error, code)
    session.error = structured
    session.activity = structured.message
    await this.emit(session, 'run.error', structured)
    if (session.state !== 'FAILED' && transitions[session.state].includes('FAILED')) {
      await this.setState(session, 'FAILED', `运行失败：${structured.message}`)
    }
  }

  private async callModel(session: SessionRecord, context: ModelContext): Promise<AgentAction> {
    const call = session.events.filter((event) => (
      event.type === 'model.call.started'
      && (event.payload as { stage?: string }).stage === context.stage
    )).length + 1
    await this.emit(session, 'agent.activity.updated', { stage: context.stage, message: `正在调用 ${session.model}` })
    await this.emit(session, 'model.call.started', { stage: context.stage, call, model: session.model })
    const result = await this.model.generate({
      ...context,
      requestedModel: session.model,
      provenance: context.provenance ?? { mode: session.modelMode, model: session.model },
    }, async (progress) => {
      await this.emit(session, `model.${progress.type}`, { stage: context.stage, call, ...progress })
    })
    await this.emit(session, 'model.call.completed', {
      stage: context.stage,
      requestedModel: result.requestedModel,
      resolvedModel: result.resolvedModel,
      rawResponseRef: result.rawResponseRef,
      usage: result.usage,
      latencyMs: result.latencyMs,
      formatErrors: result.formatErrors,
      attempts: result.attempts,
    })
    await this.emit(session, 'agent.action.proposed', {
      type: result.action.type,
      message: 'message' in result.action ? result.action.message : undefined,
    })
    if (result.action.type === 'report_blocker') {
      throw { code: result.action.code, message: result.action.message }
    }
    return result.action
  }

  private async produceTask(session: SessionRecord): Promise<void> {
    let feedback: unknown
    for (let attempt = 0; attempt < this.runPolicy.maxTaskVersions; attempt += 1) {
      const action = await this.callModel(session, {
        sessionId: session.id,
        stage: 'task',
        sessionState: session.state,
        userRequest: session.request,
        artifacts: session.artifacts,
        feedback,
      })
      if (action.type !== 'propose_task_spec') throw new Error(`Expected propose_task_spec, received ${action.type}`)
      const task = taskSpecSchema.parse({
        ...action.taskSpec,
        id: `${session.id}:task`,
        version: (session.artifacts.task?.version ?? 0) + 1,
      })
      const issues = taskSemanticIssues(task)
      if (issues.length > 0) {
        await this.emit(session, 'task.validation.completed', { passed: false, issues })
        feedback = { issues }
        continue
      }
      session.artifacts.task = task
      await this.store.writeArtifact(session.id, 'task', task)
      await this.emit(session, 'artifact.created', { kind: 'TaskSpec', artifact: task }, [versionRef(task)])
      await this.emit(session, 'task.validation.completed', { passed: true, issues: [] }, [versionRef(task)])
      await this.setState(session, 'DESIGNING_LOGIC', '正在生成与 TaskSpec 分离的 LogicDesign')
      return
    }
    throw { code: 'TASK_SPEC_INVALID', message: 'Agent could not produce a semantically valid TaskSpec', details: feedback }
  }

  private async produceLogic(session: SessionRecord): Promise<void> {
    const task = session.artifacts.task
    if (!task) throw new Error('TaskSpec is required before LogicDesign')
    let feedback: unknown
    for (let attempt = 0; attempt < this.runPolicy.maxLogicVersions; attempt += 1) {
      const action = await this.callModel(session, {
        sessionId: session.id,
        stage: 'logic',
        sessionState: session.state,
        userRequest: session.request,
        artifacts: session.artifacts,
        feedback,
      })
      if (action.type !== 'propose_logic_design') throw new Error(`Expected propose_logic_design, received ${action.type}`)
      const design: LogicDesign = logicDesignSchema.parse({
        ...action.design,
        id: `${session.id}:logic`,
        version: (session.artifacts.logicDesign?.version ?? 0) + 1,
        taskSpecRef: versionRef(task),
      })
      session.artifacts.logicDesign = design
      session.artifacts.physicalLayout = undefined
      session.artifacts.buildRun = undefined
      session.artifacts.verificationReport = undefined
      session.artifacts.worldInspectionReport = undefined
      await this.store.writeArtifact(session.id, 'logic', design)
      await this.emit(session, 'artifact.created', { kind: 'LogicDesign', artifact: design }, [versionRef(design), versionRef(task)])
      await this.setState(session, 'CHECKING_LOGIC', '确定性 Logic Checker 正在执行完整真值表')
      const result = await this.logicChecker.check(task, design)
      session.logicCheck = result
      await this.emit(session, 'logic.check.completed', result, [versionRef(design), versionRef(task)])
      if (result.passed) {
        await this.setState(session, 'AWAITING_DESIGN_REVIEW', '逻辑检查通过；等待人工审阅并确认')
        return
      }
      feedback = result
      if (attempt < this.runPolicy.maxLogicVersions - 1) {
        await this.setState(session, 'REVISING', '逻辑检查失败；Agent 将依据结构化错误修订')
        await this.setState(session, 'DESIGNING_LOGIC', '正在生成新的 LogicDesign 版本')
      }
    }
    throw { code: 'LOGIC_CHECK_FAILED', message: 'LogicDesign did not pass within the revision budget', details: feedback }
  }

  private async produceLayout(
    session: SessionRecord,
    initialFeedback?: unknown,
    includeActiveArtifacts = Boolean(initialFeedback),
  ): Promise<void> {
    const task = session.artifacts.task
    const design = session.artifacts.logicDesign
    if (!task || !design || !session.logicCheck?.passed) throw new Error('A checked LogicDesign is required before layout planning')
    await this.setState(session, 'PLANNING_LAYOUT', 'Agent 正在从已确认逻辑设计生成或修补 PhysicalLayout')
    // Task and logic stay immutable during this layout-only cycle. The
    // physical layout supplied to each repair call is the best candidate seen
    // so far, never merely the most recent candidate.
    const stableLayoutArtifacts: ArtifactBundle = includeActiveArtifacts
      ? structuredClone(session.artifacts)
      : { task: structuredClone(task), logicDesign: structuredClone(design) }
    let bestLayout = stableLayoutArtifacts.physicalLayout
      ? structuredClone(stableLayoutArtifacts.physicalLayout)
      : undefined
    delete stableLayoutArtifacts.physicalLayout
    let bestValidation = bestLayout
      ? await this.layoutValidator.validate(task, design, bestLayout)
      : undefined
    // A worse candidate can be rolled back to an older best layout. Deriving
    // the next number only from that active best would then reuse artifact
    // versions (and overwrite layout-vN.json) in the following retry cycle.
    // The immutable event history is the authoritative high-water mark.
    let nextLayoutVersion = nextPhysicalLayoutVersion(session)
    let feedback: unknown = initialFeedback
    const priorValidationHistory = initialFeedback && typeof initialFeedback === 'object' && !Array.isArray(initialFeedback)
      && Array.isArray((initialFeedback as Record<string, unknown>).layoutValidationHistory)
      ? structuredClone((initialFeedback as Record<string, unknown>).layoutValidationHistory as Array<{
          layoutVersion: number
          issueGroups: ReturnType<typeof compactLayoutIssues>
        }>)
      : []
    const validationHistory: Array<{
      layoutVersion: number
      issueGroups: ReturnType<typeof compactLayoutIssues>
    }> = []
    if (bestLayout && feedback && typeof feedback === 'object' && !Array.isArray(feedback)) {
      feedback = {
        ...feedback,
        repairMode: 'patch_best_candidate',
        repairBaseLayoutRef: versionRef(bestLayout),
        repairBaseValidation: bestValidation ? compactLayoutValidation(bestValidation) : undefined,
        revisionDirective: 'Return a repair_layout patch against artifacts.physicalLayout. Preserve every unmentioned block and make the smallest coherent change required by the supplied evidence.',
      }
    }
    for (let attempt = 0; attempt < this.runPolicy.maxLayoutVersions; attempt += 1) {
      const repairMode = Boolean(bestLayout)
      const action = await this.callModel(session, {
        sessionId: session.id,
        stage: 'layout',
        sessionState: session.state,
        userRequest: session.request,
        artifacts: {
          ...stableLayoutArtifacts,
          ...(bestLayout ? { physicalLayout: structuredClone(bestLayout) } : {}),
        },
        feedback,
      })
      let layout: PhysicalLayout | undefined
      if (!repairMode) {
        if (action.type !== 'propose_layout') throw new Error(`Expected propose_layout, received ${action.type}`)
        layout = physicalLayoutSchema.parse({
          ...action.layout,
          id: `${session.id}:layout`,
          version: nextLayoutVersion,
          logicDesignRef: versionRef(design),
        })
      } else {
        if (action.type !== 'repair_layout') throw new Error(`Expected repair_layout, received ${action.type}`)
        const repaired = materializeLayoutRepair(bestLayout!, action.patch, nextLayoutVersion, design)
        if (!repaired.layout) {
          feedback = {
            ...(initialFeedback && typeof initialFeedback === 'object' && !Array.isArray(initialFeedback)
              ? initialFeedback as Record<string, unknown>
              : { reason: 'layout_validation_failed' }),
            repairMode: 'patch_best_candidate',
            repairBaseLayoutRef: versionRef(bestLayout!),
            repairBaseValidation: bestValidation ? compactLayoutValidation(bestValidation) : undefined,
            patchApplicationErrors: repaired.errors,
            layoutValidationHistory: compactValidationHistory([...priorValidationHistory, ...validationHistory]),
            revisionDirective: 'Return a repair_layout patch against artifacts.physicalLayout. Keep baseVersion exact and change only the blocks needed to reduce the deterministic issue count.',
          }
          await this.emit(session, 'layout.patch.rejected', {
            baseLayoutRef: versionRef(bestLayout!),
            errors: repaired.errors,
          }, [versionRef(bestLayout!)])
          if (attempt < this.runPolicy.maxLayoutVersions - 1) {
            await this.setState(session, 'REVISING', '布局 patch 无法应用；Agent 将修正 patch')
            await this.setState(session, 'PLANNING_LAYOUT', '正在修补当前最佳 PhysicalLayout')
          }
          continue
        }
        layout = repaired.layout
      }
      nextLayoutVersion += 1
      session.artifacts.physicalLayout = layout
      session.artifacts.buildRun = undefined
      session.artifacts.verificationReport = undefined
      session.artifacts.worldInspectionReport = undefined
      session.layoutValidation = undefined
      await this.store.writeArtifact(session.id, 'layout', layout)
      await this.emit(session, 'artifact.created', { kind: 'PhysicalLayout', artifact: layout }, [versionRef(layout), versionRef(design)])
      await this.setState(session, 'VALIDATING_LAYOUT', '确定性 Layout Validator 正在检查完整布局')
      const result = await this.layoutValidator.validate(task, design, layout)
      session.layoutValidation = result
      await this.emit(session, 'layout.validation.completed', result, [versionRef(layout)])
      if (result.passed) {
        await this.setState(session, 'READY_TO_BUILD', '布局校验通过；可以逐块写入 Minecraft')
        return
      }
      validationHistory.push({
        layoutVersion: layout.version,
        issueGroups: compactLayoutIssues(result.issues),
      })
      const candidateValidation = compactLayoutValidation(result)
      const previousBest = bestLayout
      // Structural issues (floating, colliding or misplaced blocks) outrank
      // functional ones (simulated output bits and truth-table rows), so fixing the last
      // structural defect is never rolled back merely because the simulation
      // can now see functional failures that were previously hidden.
      const acceptedAsBest = !bestValidation || compareLayoutValidations(result, bestValidation) < 0
      if (acceptedAsBest) {
        bestLayout = structuredClone(layout)
        bestValidation = structuredClone(result)
        await this.emit(session, 'layout.best_candidate.updated', {
          previousLayoutRef: previousBest ? versionRef(previousBest) : undefined,
          bestLayoutRef: versionRef(bestLayout),
          issueCount: result.issues.length,
          ...issueCounts(result),
        }, [versionRef(bestLayout)])
      } else {
        session.artifacts.physicalLayout = structuredClone(bestLayout!)
        session.layoutValidation = structuredClone(bestValidation!)
        await this.emit(session, 'layout.patch.reverted', {
          candidateLayoutRef: versionRef(layout),
          candidateIssueCount: result.issues.length,
          bestLayoutRef: versionRef(bestLayout!),
          bestIssueCount: bestValidation!.issues.length,
          reason: 'Candidate did not strictly reduce the deterministic issue count',
        }, [versionRef(layout), versionRef(bestLayout!)])
      }
      feedback = initialFeedback && typeof initialFeedback === 'object' && !Array.isArray(initialFeedback)
        ? {
            ...initialFeedback,
            repairMode: 'patch_best_candidate',
            repairBaseLayoutRef: versionRef(bestLayout!),
            repairBaseValidation: compactLayoutValidation(bestValidation!),
            lastCandidate: {
              layoutRef: versionRef(layout),
              validation: candidateValidation,
              acceptedAsBest,
            },
            layoutValidationHistory: compactValidationHistory([...priorValidationHistory, ...validationHistory]),
            revisionDirective: LAYOUT_REPAIR_DIRECTIVE,
          }
        : {
            reason: 'layout_validation_failed',
            repairMode: 'patch_best_candidate',
            repairBaseLayoutRef: versionRef(bestLayout!),
            repairBaseValidation: compactLayoutValidation(bestValidation!),
            lastCandidate: {
              layoutRef: versionRef(layout),
              validation: candidateValidation,
              acceptedAsBest,
            },
            layoutValidationHistory: compactValidationHistory([...priorValidationHistory, ...validationHistory]),
            revisionDirective: LAYOUT_REPAIR_DIRECTIVE,
          }
      if (attempt < this.runPolicy.maxLayoutVersions - 1) {
        await this.setState(session, 'REVISING', '布局校验失败；Agent 将依据结构化错误修订')
        await this.setState(session, 'PLANNING_LAYOUT', '正在修补当前最佳 PhysicalLayout')
      }
    }
    if (bestLayout && bestValidation) {
      session.artifacts.physicalLayout = structuredClone(bestLayout)
      session.layoutValidation = structuredClone(bestValidation)
    }
    throw { code: 'LAYOUT_VALIDATION_FAILED', message: 'PhysicalLayout did not pass within the revision budget', details: feedback }
  }

  private async buildAndVerify(session: SessionRecord): Promise<void> {
    const task = session.artifacts.task
    const layout = session.artifacts.physicalLayout
    if (!task || !layout || !(session.layoutValidation?.passed || session.experimentalBuild)) {
      throw new Error('A validated PhysicalLayout is required before build')
    }
    if (!session.worldWorkspace) {
      const occupied = [
        ...this.workspaceResets(),
        ...[...this.sessions.values()].flatMap((item) => item.worldWorkspace ? [item.worldWorkspace] : []),
      ]
      session.worldWorkspace = allocateSessionWorkspace(this.minecraft.baseOrigin, task.workspace.size, occupied)
      await this.emit(session, 'minecraft.workspace.reserved', session.worldWorkspace)
    }
    this.minecraft.selectWorkspace(session.worldWorkspace.origin)
    await this.setState(session, 'BUILDING', '正在连接 Minecraft、准备独立工作区并逐块 /setblock')
    const environment = await this.minecraft.connect()
    await this.emit(session, 'minecraft.connected', environment)
    this.activeWorldSessionId = session.id
    await this.minecraft.resetWorkspace(task)
    await this.emit(session, 'minecraft.workspace.reset', { workspace: task.workspace, worldOrigin: environment.worldOrigin })
    const runId = `${session.id}:build-${randomUUID().slice(0, 8)}`
    await this.emit(session, 'build.started', { runId, layoutRef: versionRef(layout), total: layout.blocks.length })
    const builtRun = await this.minecraft.build(session.id, runId, task, layout, async (progress) => {
      await this.emit(session, 'build.block.completed', progress, [versionRef(layout)])
    })
    const buildVersion = (this.buildVersions.get(session.id) ?? 0) + 1
    this.buildVersions.set(session.id, buildVersion)
    const run = { ...builtRun, version: buildVersion }
    session.artifacts.buildRun = run
    await this.store.writeArtifact(session.id, 'build', run)
    await this.emit(session, run.status === 'completed' ? 'build.completed' : 'build.failed', run, [versionRef(run), versionRef(layout)])
    if (run.status !== 'completed') throw { code: 'BUILD_FAILED', message: 'Minecraft build did not complete', details: run.errors }

    await this.setState(session, 'VERIFYING', '正在 Minecraft 中逐行设置输入并读取稳定输出')
    const reportId = `${session.id}:verification-${randomUUID().slice(0, 8)}`
    const verification = await this.verifier.verify(reportId, task, layout, run, async (result) => {
      await this.emit(session, 'verification.case.completed', result, [versionRef(run), versionRef(task)])
    })
    const verificationVersion = (this.verificationVersions.get(session.id) ?? 0) + 1
    this.verificationVersions.set(session.id, verificationVersion)
    const report = { ...verification, version: verificationVersion }
    session.artifacts.verificationReport = report
    await this.store.writeArtifact(session.id, 'verification', report)
    await this.emit(session, 'verification.completed', report, [versionRef(report), versionRef(run), versionRef(task)])

    if (report.passed && report.authoritative) {
      session.artifacts.worldInspectionReport = undefined
      await this.setState(session, 'SUCCEEDED', session.experimentalBuild
        ? `布局 v${session.experimentalBuild.layoutRef.version} 未通过模拟；实验搭建后，真实 Minecraft 完整真值表验证通过（模拟与游戏不一致）`
        : '真实 Minecraft 完整真值表验证通过')
    } else if (report.passed) {
      session.artifacts.worldInspectionReport = undefined
      await this.setState(session, 'COMPLETED_NON_AUTHORITATIVE', '离线演示链路完成；结果不是 Minecraft 真值证据')
    } else {
      await this.setState(session, 'INSPECTING_WORLD', 'Minecraft 验证失败；Agent 正在读取失败状态下的真实方块与红石属性')
      await this.inspectFailedWorldCases(session, task, layout, run, report)
      await this.fail(session, {
        code: 'MINECRAFT_VERIFICATION_FAILED',
        message: session.experimentalBuild
          ? `布局 v${session.experimentalBuild.layoutRef.version} 未通过模拟；实验搭建后游戏实测也未通过，已保留验收报告与现场记录。`
          : '游戏实测未通过；已保留验收报告与现场记录，本次验收结束。',
        details: {
          verificationReportRef: versionRef(report),
          worldInspectionReportRef: session.artifacts.worldInspectionReport && versionRef(session.artifacts.worldInspectionReport),
        },
        recoverable: false,
      }, 'MINECRAFT_VERIFICATION_FAILED')
    }
  }

  private async inspectFailedWorldCases(
    session: SessionRecord,
    task: TaskSpec,
    layout: PhysicalLayout,
    run: NonNullable<ArtifactBundle['buildRun']>,
    verificationReport: VerificationReport,
  ): Promise<void> {
    const startedAt = now()
    const failedCases = [] as WorldInspectionReport['failedCases']
    for (const failedCase of verificationReport.cases.filter((item) => !item.passed)) {
      await this.emit(session, 'world.inspection.case.started', {
        caseIndex: failedCase.index,
        inputs: failedCase.inputs,
      }, [versionRef(layout), versionRef(run), versionRef(verificationReport)])
      const errors: RunError[] = []
      let observedOutputs: Record<string, OutputValue> = Object.fromEntries(task.outputs.map((output) => [
        output.id,
        'unreadable',
      ]))
      try {
        await this.minecraft.setInputs(task, failedCase.inputs)
        await this.minecraft.triggerUpdate(task, layout)
        const readings = await this.minecraft.readOutputs(task, task.acceptance.stableReads)
        observedOutputs = Object.fromEntries(task.outputs.map((output) => [
          output.id,
          readings[output.id]?.value ?? 'unreadable',
        ]))
      } catch (error) {
        errors.push(runError(error, 'WORLD_INSPECTION_CASE_REPLAY_FAILED'))
      }
      let observations: WorldInspectionReport['failedCases'][number]['observations'] = []
      try {
        observations = await this.minecraft.inspectWorld(task, layout)
      } catch (error) {
        errors.push(runError(error, 'WORLD_INSPECTION_BLOCK_READ_FAILED'))
      }
      const inspected = {
        caseIndex: failedCase.index,
        inputs: failedCase.inputs,
        expectedOutputs: failedCase.expected,
        observedOutputs,
        observations,
        errors,
        inspectedAt: now(),
      }
      failedCases.push(inspected)
      await this.emit(session, 'world.inspection.case.completed', {
        caseIndex: inspected.caseIndex,
        observedOutputs: inspected.observedOutputs,
        observedBlocks: observations.length,
        mismatchedBlocks: observations.filter((item) => !item.matchedExpected).length,
        errors: errors.length,
      }, [versionRef(layout), versionRef(run), versionRef(verificationReport)])
    }

    const inspectionVersion = (this.inspectionVersions.get(session.id) ?? 0) + 1
    this.inspectionVersions.set(session.id, inspectionVersion)
    const report: WorldInspectionReport = {
      id: `${session.id}:world-inspection`,
      version: inspectionVersion,
      taskSpecRef: versionRef(task),
      layoutRef: versionRef(layout),
      buildRunRef: versionRef(run),
      verificationReportRef: versionRef(verificationReport),
      authoritative: run.environment.authoritative && this.minecraft.authoritative,
      failedCases,
      startedAt,
      finishedAt: now(),
    }
    session.artifacts.worldInspectionReport = report
    await this.store.writeArtifact(session.id, 'inspection', report)
    await this.emit(session, 'artifact.created', {
      kind: 'WorldInspectionReport',
      artifact: report,
    }, [
      versionRef(report),
      versionRef(task),
      versionRef(layout),
      versionRef(run),
      versionRef(verificationReport),
    ])
    await this.emit(session, 'world.inspection.completed', {
      inspectionRef: versionRef(report),
      failedCases: report.failedCases.length,
      observedBlocks: report.failedCases.reduce((total, item) => total + item.observations.length, 0),
      mismatchedBlocks: report.failedCases.reduce(
        (total, item) => total + item.observations.filter((observation) => !observation.matchedExpected).length,
        0,
      ),
      authoritative: report.authoritative,
    }, [versionRef(report), versionRef(verificationReport)])
  }
}
