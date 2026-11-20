import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  BuildRun,
  MinecraftEnvironment,
  OutputReading,
  PhysicalLayout,
  SessionEvent,
  SessionSnapshot,
  TaskSpec,
  WorldBlockObservation,
} from '@domain/domain'
import { ArtifactStore } from '@platform/artifact-store'
import type { MinecraftAdapter } from '@minecraft/minecraft-adapter'
import { FixtureModelAdapter } from '@agent/model/fixture-adapter'
import type { ModelAdapter, ModelCallResult, ModelContext } from '@agent/model/model-adapter'
import { SessionCommandError, SessionController } from './session-controller'

const tempDirs: string[] = []
afterEach(async () => Promise.all(tempDirs.splice(0).map(async (dir) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
})))

class FailingMinecraftAdapter implements MinecraftAdapter {
  readonly mode = 'mock' as const
  readonly authoritative = false
  readonly baseOrigin = { x: 0, y: 72, z: 0 }
  selectWorkspace(): void {}
  private inputs: Record<string, 0 | 1> = {}

  async connect(): Promise<MinecraftEnvironment> {
    return {
      adapter: 'mock',
      authoritative: false,
      host: 'in-process',
      port: 0,
      version: 'test-failure-adapter',
      worldOrigin: { x: 0, y: 72, z: 0 },
    }
  }

  async resetWorkspace(): Promise<void> {
    this.inputs = {}
  }

  async build(
    sessionId: string,
    runId: string,
    _task: TaskSpec,
    layout: PhysicalLayout,
  ): Promise<BuildRun> {
    return {
      id: runId,
      version: 1,
      sessionId,
      layoutRef: { id: layout.id, version: layout.version },
      environment: await this.connect(),
      status: 'completed',
      placed: layout.blocks.length,
      total: layout.blocks.length,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      errors: [],
    }
  }

  async setInputs(_task: TaskSpec, values: Record<string, 0 | 1>): Promise<void> {
    this.inputs = { ...values }
  }

  async triggerUpdate(): Promise<void> {}

  async readOutputs(task: TaskSpec, stableReads: number): Promise<Record<string, OutputReading>> {
    return Object.fromEntries(task.outputs.map((output) => [
      output.id,
      {
        // Reproduce the live baseline: Y stays on for both NOT-gate inputs.
        value: 1,
        evidence: Array.from({ length: stableReads }, () => ({
          type: 'mock-reading' as const,
          source: 'deterministic failing test adapter',
          at: new Date().toISOString(),
          properties: { inputs: this.inputs },
        })),
      },
    ]))
  }

  async inspectWorld(_task: TaskSpec, layout: PhysicalLayout): Promise<WorldBlockObservation[]> {
    return layout.blocks.map((block) => ({
      position: block.position,
      worldPosition: { x: block.position.x, y: block.position.y + 72, z: block.position.z },
      expected: [{ blockId: block.id, block: block.block, relation: 'layout' as const }],
      actualBlock: block.block,
      properties: { inputs: this.inputs, powered: block.block.includes('redstone') },
      matchedExpected: true,
    }))
  }

  async close(): Promise<void> {}
}

class RecordingModelAdapter implements ModelAdapter {
  readonly mode = 'fixture' as const
  readonly model: string
  readonly contexts: ModelContext[] = []
  revisionGate?: Promise<void>
  omitInitialWire = false
  failNextRevision = false
  rejectNextRevisionPatch = false

  constructor(private readonly delegate: FixtureModelAdapter) {
    this.model = delegate.model
  }

  async generate(context: ModelContext): Promise<ModelCallResult> {
    this.contexts.push(structuredClone(context))
    const isRevision = context.stage === 'layout'
      && (context.feedback as { reason?: unknown } | undefined)?.reason === 'layout_validation_retry'
    if (isRevision && this.revisionGate) await this.revisionGate
    if (isRevision && this.failNextRevision) {
      this.failNextRevision = false
      throw new Error('synthetic revision failure')
    }
    const result = await this.delegate.generate(context)
    if (this.omitInitialWire && result.action.type === 'propose_layout') {
      result.action = { ...result.action, layout: { ...result.action.layout,
        blocks: result.action.layout.blocks.filter((block) => block.id !== 'wire-not-A'),
      } }
    }
    if (isRevision && this.rejectNextRevisionPatch && result.action.type === 'repair_layout') {
      this.rejectNextRevisionPatch = false
      return {
        ...result,
        action: {
          ...result.action,
          patch: { ...result.action.patch, baseVersion: result.action.patch.baseVersion + 999 },
        },
      }
    }
    return result
  }
}

async function waitFor(
  controller: SessionController,
  sessionId: string,
  expected: SessionSnapshot['state'],
  timeoutMs = 4_000,
) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const snapshot = controller.get(sessionId)
    if (snapshot.state === expected) return snapshot
    if (snapshot.state === 'FAILED' && expected !== 'FAILED') {
      throw new Error(`Session failed: ${snapshot.error?.code} ${snapshot.error?.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${expected}; current=${controller.get(sessionId).state}`)
}

async function layoutSession(omitWire = false) {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-revision-'))
  tempDirs.push(runsDir)
  const store = new ArtifactStore(runsDir)
  await store.initialize()
  const model = new RecordingModelAdapter(new FixtureModelAdapter(store))
  model.omitInitialWire = omitWire
  const controller = new SessionController(store, model, new FailingMinecraftAdapter(), {
    maxTaskVersions: 2, maxLogicVersions: 3, maxLayoutVersions: omitWire ? 1 : 5,
  })
  const created = await controller.create('搭建并验证一个 NOT 非门')
  controller.begin(created.id)
  await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
  controller.approveDesign(created.id)
  const snapshot = await waitFor(controller, created.id, omitWire ? 'FAILED' : 'READY_TO_BUILD')
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { runsDir, store, model, controller, sessionId: created.id, snapshot }
}

function internalRecord(controller: SessionController, sessionId: string): SessionSnapshot & { events: SessionEvent[] } {
  return (controller as unknown as {
    sessions: Map<string, SessionSnapshot & { events: SessionEvent[] }>
  }).sessions.get(sessionId)!
}

function expectCommandError(operation: () => void, code: string) {
  try {
    operation()
    throw new Error('Expected command to be rejected')
  } catch (error) {
    expect(error).toBeInstanceOf(SessionCommandError)
    expect((error as SessionCommandError).code).toBe(code)
  }
}

async function waitForLayoutRetry(controller: SessionController, sessionId: string, timeoutMs = 4_000) {
  const started = Date.now()
  let retryStarted = false
  let leftInitialFailure = false
  while (Date.now() - started < timeoutMs) {
    retryStarted ||= controller.events(sessionId).some((event) => event.type === 'layout.retry.requested')
    const snapshot = controller.get(sessionId)
    if (retryStarted && snapshot.state === 'READY_TO_BUILD') return snapshot
    if (retryStarted && snapshot.state !== 'FAILED') leftInitialFailure = true
    if (leftInitialFailure && snapshot.state === 'FAILED') {
      throw new Error(`Layout retry failed: ${snapshot.error?.code} ${snapshot.error?.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for layout retry; current=${controller.get(sessionId).state}`)
}

async function waitForLayoutRestart(controller: SessionController, sessionId: string, timeoutMs = 4_000) {
  const started = Date.now()
  let restartStarted = false
  let leftInitialFailure = false
  while (Date.now() - started < timeoutMs) {
    restartStarted ||= controller.events(sessionId).some((event) => event.type === 'layout.restart.requested')
    const snapshot = controller.get(sessionId)
    if (restartStarted && snapshot.state === 'READY_TO_BUILD') return snapshot
    if (restartStarted && snapshot.state !== 'FAILED') leftInitialFailure = true
    if (leftInitialFailure && snapshot.state === 'FAILED') {
      throw new Error(`Fresh layout restart failed: ${snapshot.error?.code} ${snapshot.error?.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for fresh layout restart; current=${controller.get(sessionId).state}`)
}

describe('SessionController layout revision', () => {
  it('restarts a validation-exhausted layout cycle without regenerating task or logic', async () => {
    const { model, controller, sessionId } = await layoutSession()
    const record = internalRecord(controller, sessionId)
    const originalTask = structuredClone(record.artifacts.task!)
    const originalLogic = structuredClone(record.artifacts.logicDesign!)
    record.state = 'FAILED'
    record.error = {
      code: 'LAYOUT_VALIDATION_FAILED',
      message: 'PhysicalLayout did not pass within the revision budget',
      recoverable: true,
      details: {
        layoutValidationHistory: [{
          layoutVersion: 1,
          issueGroups: [{ code: 'MISSING_SUPPORT', count: 2, examples: [] }],
        }],
      },
    }
    record.layoutValidation = {
      passed: false,
      issues: [{ code: 'MISSING_SUPPORT', message: 'synthetic missing support' }],
      stats: { blocks: 9, phases: 3, mappedLogicIds: 5 },
    }
    const contextsBefore = model.contexts.length

    controller.retryLayout(sessionId)
    const ready = await waitForLayoutRetry(controller, sessionId)

    expect(ready.error).toBeUndefined()
    expect(ready.artifacts.task).toEqual(originalTask)
    expect(ready.artifacts.logicDesign).toEqual(originalLogic)
    expect(ready.artifacts.physicalLayout?.version).toBe(2)
    expect(ready.artifacts.buildRun).toBeUndefined()
    expect(ready.artifacts.verificationReport).toBeUndefined()
    expect(ready.layoutValidation?.passed).toBe(true)

    const retryContexts = model.contexts.slice(contextsBefore)
    expect(retryContexts.map((context) => context.stage)).toEqual(['layout'])
    expect(retryContexts[0].artifacts).toMatchObject({
      task: originalTask,
      logicDesign: originalLogic,
      physicalLayout: { version: 1 },
    })
    expect(retryContexts[0].feedback).toMatchObject({
      reason: 'layout_validation_retry',
      retryMode: 'automatic',
      repairMode: 'patch_best_candidate',
      repairBaseLayoutRef: { version: 1 },
      layoutValidationHistory: [{ layoutVersion: 1 }],
    })
    expect(controller.events(sessionId).some((event) => event.type === 'agent.action.proposed'
      && (event.payload as { type?: string }).type === 'repair_layout')).toBe(true)
    expect(controller.events(sessionId).find((event) => event.type === 'layout.retry.requested')?.payload).toMatchObject({
      retryMode: 'automatic',
      priorAttempts: 1,
      previousLayoutRef: { version: 1 },
    })
  })

  it('allocates a layout version above rolled-back candidates from earlier retry cycles', async () => {
    const { controller, sessionId } = await layoutSession()
    const record = internalRecord(controller, sessionId)
    const retainedBest = structuredClone(record.artifacts.physicalLayout!)
    const historicalCandidate = { ...structuredClone(retainedBest), version: 7 }
    record.latestSeq += 1
    record.events.push({
      sessionId,
      seq: record.latestSeq,
      at: new Date().toISOString(),
      type: 'artifact.created',
      payload: { kind: 'PhysicalLayout', artifact: historicalCandidate },
      refs: [{ id: historicalCandidate.id, version: historicalCandidate.version }],
    })
    record.state = 'FAILED'
    record.error = {
      code: 'LAYOUT_VALIDATION_FAILED',
      message: 'PhysicalLayout did not pass within the revision budget',
      recoverable: true,
    }
    record.layoutValidation = {
      passed: false,
      issues: [{ code: 'SIMULATED_CASE_MISMATCH', message: 'synthetic mismatch' }],
      stats: { blocks: retainedBest.blocks.length, phases: 3, mappedLogicIds: 5 },
    }

    controller.retryLayout(sessionId)
    const ready = await waitForLayoutRetry(controller, sessionId)

    expect(ready.artifacts.physicalLayout?.version).toBe(8)
    const createdVersions = controller.events(sessionId)
      .filter((event) => event.type === 'artifact.created'
        && (event.payload as { kind?: string }).kind === 'PhysicalLayout')
      .map((event) => (event.payload as { artifact: { version: number } }).artifact.version)
    expect(createdVersions).toEqual(expect.arrayContaining([1, 7, 8]))
  })

  it('resamples a complete layout without exposing the failed layout or regenerating upstream artifacts', async () => {
    const { model, controller, sessionId } = await layoutSession()
    const record = internalRecord(controller, sessionId)
    const originalTask = structuredClone(record.artifacts.task!)
    const originalLogic = structuredClone(record.artifacts.logicDesign!)
    record.state = 'FAILED'
    record.error = {
      code: 'LAYOUT_VALIDATION_FAILED',
      message: 'PhysicalLayout did not pass within the revision budget',
      recoverable: true,
      details: {
        layoutValidationHistory: [{
          layoutVersion: 1,
          issueGroups: [{ code: 'SIMULATED_CASE_MISMATCH', count: 1, examples: [] }],
        }],
      },
    }
    record.layoutValidation = {
      passed: false,
      issues: [{ code: 'SIMULATED_CASE_MISMATCH', message: 'synthetic mismatch' }],
      stats: { blocks: 9, phases: 3, mappedLogicIds: 5 },
    }
    const contextsBefore = model.contexts.length

    controller.restartLayout(sessionId)
    const ready = await waitForLayoutRestart(controller, sessionId)

    expect(ready.error).toBeUndefined()
    expect(ready.artifacts.task).toEqual(originalTask)
    expect(ready.artifacts.logicDesign).toEqual(originalLogic)
    expect(ready.artifacts.physicalLayout?.version).toBe(2)
    expect(ready.layoutValidation?.passed).toBe(true)

    const restartContexts = model.contexts.slice(contextsBefore)
    expect(restartContexts.map((context) => context.stage)).toEqual(['layout'])
    expect(restartContexts[0].artifacts).toMatchObject({
      task: originalTask,
      logicDesign: originalLogic,
    })
    expect(restartContexts[0].artifacts.physicalLayout).toBeUndefined()
    expect(restartContexts[0].feedback).toMatchObject({
      reason: 'layout_fresh_restart',
      retryMode: 'automatic',
      previousFailure: { code: 'LAYOUT_VALIDATION_FAILED' },
    })
    expect(restartContexts[0].feedback).not.toHaveProperty('layoutValidationHistory')
    expect(controller.events(sessionId).some((event) => event.type === 'agent.action.proposed'
      && (event.payload as { type?: string }).type === 'propose_layout')).toBe(true)
    expect(controller.events(sessionId).find((event) => event.type === 'layout.restart.requested')?.payload).toMatchObject({
      retryMode: 'automatic',
      priorAttempts: 1,
      previousLayoutRef: { version: 1 },
    })
  })

  it('keeps conversation available while a layout-validation failure is waiting for retry', async () => {
    const { controller, sessionId } = await layoutSession()
    const record = internalRecord(controller, sessionId)
    record.state = 'FAILED'
    record.error = {
      code: 'LAYOUT_VALIDATION_FAILED',
      message: 'PhysicalLayout did not pass within the revision budget',
      recoverable: true,
    }

    const reply = await controller.sendMessage(sessionId, '为什么空间布局失败？')

    expect(reply.message.length).toBeGreaterThan(0)
    expect(controller.get(sessionId).state).toBe('FAILED')
    expect(controller.events(sessionId).some((event) => event.type === 'conversation.agent.reply')).toBe(true)
  })

  it('uses human guidance and simulation to fix a missing wire before any build', async () => {
    const { model, controller, sessionId, snapshot } = await layoutSession(true)
    expect(snapshot.error?.code).toBe('LAYOUT_VALIDATION_FAILED')
    expect(snapshot.layoutValidation?.simulation?.passedCases).toBe(1)
    const contextsBefore = model.contexts.length
    controller.reviseLayout(sessionId, '  补上火把到灯的红石线  ')
    const ready = await waitForLayoutRetry(controller, sessionId)
    expect(ready.artifacts.task).toEqual(snapshot.artifacts.task)
    expect(ready.artifacts.logicDesign).toEqual(snapshot.artifacts.logicDesign)
    expect(ready.layoutValidation?.simulation?.passedCases).toBe(2)
    expect(ready.artifacts.physicalLayout?.blocks.some((block) => block.id === 'wire-not-A')).toBe(true)
    expect(ready.artifacts.buildRun).toBeUndefined()
    expect(ready.artifacts.verificationReport).toBeUndefined()
    expect(model.contexts.slice(contextsBefore).map((context) => context.stage)).toEqual(['layout'])
    expect(model.contexts.at(-1)?.feedback).toMatchObject({
      retryMode: 'human_guided', userInstruction: '补上火把到灯的红石线',
      repairBaseValidation: { simulation: { passedCases: 1, totalCases: 2 } },
    })
    expect(controller.events(sessionId).some((event) => event.type === 'minecraft.connected')).toBe(false)
  })

  it.each([undefined, '   '])('does not carry old guidance into an automatic retry (%s)', async (instruction) => {
    const { model, controller, sessionId } = await layoutSession(true)
    model.rejectNextRevisionPatch = true
    const before = controller.get(sessionId).latestSeq
    controller.retryLayout(sessionId, '保留旧走线，只调整火把朝向')
    const deadline = Date.now() + 4_000
    while (!controller.events(sessionId, before).some((event) => event.type === 'run.error')) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for rejected guided repair')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(controller.get(sessionId).error?.details).toMatchObject({ userInstruction: '保留旧走线，只调整火把朝向' })
    controller.retryLayout(sessionId, instruction)
    await waitForLayoutRetry(controller, sessionId)
    const feedback = model.contexts.at(-1)?.feedback as Record<string, unknown>
    expect(feedback.retryMode).toBe('automatic')
    expect(feedback).not.toHaveProperty('userInstruction')
    expect(controller.get(sessionId).layoutValidation?.passed).toBe(true)
    expect(controller.get(sessionId).artifacts.buildRun).toBeUndefined()
  })

  it('keeps the current round guidance while retrying an invalid patch', async () => {
    const { model, controller, sessionId } = await layoutSession()
    model.rejectNextRevisionPatch = true
    const before = model.contexts.length
    controller.retryLayout(sessionId, '保留端口位置，检查火把朝向')
    await waitForLayoutRetry(controller, sessionId)
    const contexts = model.contexts.slice(before)
    expect(contexts).toHaveLength(2)
    for (const context of contexts) {
      expect(context.feedback).toMatchObject({ retryMode: 'human_guided', userInstruction: '保留端口位置，检查火把朝向' })
    }
    expect(controller.get(sessionId).artifacts.buildRun).toBeUndefined()
  })

  it('allows a guided adjustment after simulation passes and waits for explicit build', async () => {
    const { model, controller, sessionId, snapshot } = await layoutSession()
    controller.retryLayout(sessionId, '保持输入输出位置，检查走线')
    const ready = await waitForLayoutRetry(controller, sessionId)
    expect(ready.artifacts.physicalLayout?.version).toBe(2)
    expect(ready.layoutValidation?.simulation?.passedCases).toBe(2)
    expect(ready.artifacts.task).toEqual(snapshot.artifacts.task)
    expect(ready.artifacts.logicDesign).toEqual(snapshot.artifacts.logicDesign)
    expect(model.contexts.at(-1)?.feedback).toMatchObject({ retryMode: 'human_guided' })
    expect(ready.artifacts.buildRun).toBeUndefined()
  })

  it('builds a layout that failed only simulation as a marked experiment for failure analysis', async () => {
    const { model, controller, sessionId, snapshot } = await layoutSession(true)
    expect(snapshot.error?.code).toBe('LAYOUT_VALIDATION_FAILED')
    expect(snapshot.layoutValidation?.simulation).toMatchObject({ evaluated: true, passedCases: 1, totalCases: 2 })
    const contextsBefore = model.contexts.length
    controller.startBuild(sessionId)
    const started = Date.now()
    while (!controller.get(sessionId).artifacts.verificationReport || controller.get(sessionId).state !== 'FAILED') {
      if (Date.now() - started > 4_000) throw new Error('Experimental build did not finish')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const finished = controller.get(sessionId)
    expect(finished.experimentalBuild).toMatchObject({
      layoutRef: { version: snapshot.artifacts.physicalLayout!.version },
      simulatedPassedCases: 1,
      simulatedTotalCases: 2,
    })
    expect(finished.experimentalBuild?.unresolvedIssueCodes).toContain('SIMULATED_CASE_MISMATCH')
    expect(finished.error?.code).toBe('MINECRAFT_VERIFICATION_FAILED')
    // The final message still says the layout failed, not just "the game run failed".
    expect(finished.error?.message).toContain(`布局 v${snapshot.artifacts.physicalLayout!.version} 未通过模拟`)
    expect(controller.summaries().find((item) => item.id === sessionId)?.experimentalBuild).toBe(true)
    expect(finished.artifacts.worldInspectionReport).toBeDefined()
    expect(model.contexts.length).toBe(contextsBefore)
    const types = controller.events(sessionId).map((event) => event.type)
    expect(types.indexOf('build.experimental.requested')).toBeGreaterThan(-1)
    expect(types.indexOf('build.experimental.requested')).toBeLessThan(types.indexOf('build.started'))
    expectCommandError(() => controller.retryLayout(sessionId), 'LAYOUT_RETRY_INVALID_STATE')
    expect(() => controller.startBuild(sessionId)).toThrow('start-build is not allowed')
  })

  it('refuses an experimental build while the best layout still has structural issues', async () => {
    const { controller, sessionId } = await layoutSession(true)
    const record = internalRecord(controller, sessionId)
    record.layoutValidation = {
      ...record.layoutValidation!,
      issues: [...record.layoutValidation!.issues, { code: 'MISSING_SUPPORT', message: 'torch has nothing to hang on' }],
    }
    expect(() => controller.startBuild(sessionId)).toThrow('start-build is not allowed in FAILED')
    expect(controller.get(sessionId).experimentalBuild).toBeUndefined()
  })

  it('finishes failed game acceptance with evidence and rejects all layout restart paths', async () => {
    const { runsDir, store, model, controller, sessionId } = await layoutSession()
    const contextsBefore = model.contexts.length
    controller.startBuild(sessionId)
    const failed = await waitFor(controller, sessionId, 'FAILED')
    expect(failed.error).toMatchObject({ code: 'MINECRAFT_VERIFICATION_FAILED', recoverable: false })
    expect(failed.artifacts.verificationReport?.cases.map((item) => item.passed)).toEqual([true, false])
    expect(failed.artifacts.worldInspectionReport).toMatchObject({
      layoutRef: { version: 1 }, failedCases: [{ caseIndex: 1, inputs: { A: 1 } }],
    })
    expect(model.contexts.length).toBe(contextsBefore)
    expect(controller.events(sessionId).some((event) => event.type.startsWith('world.correction.'))).toBe(false)
    expectCommandError(() => controller.reviseLayout(sessionId, '补线'), 'LAYOUT_RETRY_INVALID_STATE')
    expectCommandError(() => controller.retryLayout(sessionId), 'LAYOUT_RETRY_INVALID_STATE')
    expectCommandError(() => controller.restartLayout(sessionId), 'LAYOUT_RESTART_INVALID_STATE')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await readdir(path.join(runsDir, sessionId, 'artifacts'))).length).toBeGreaterThan(0)
    const restored = new SessionController(store, model, new FailingMinecraftAdapter(), undefined, await store.loadSessions())
    expect(restored.get(sessionId).artifacts.verificationReport).toEqual(failed.artifacts.verificationReport)
    expectCommandError(() => restored.retryLayout(sessionId), 'LAYOUT_RETRY_INVALID_STATE')
  })

  it('reserves layout correction before queuing and prevents a concurrent build', async () => {
    const { model, controller, sessionId } = await layoutSession()
    let release!: () => void
    model.revisionGate = new Promise<void>((resolve) => { release = resolve })
    controller.retryLayout(sessionId, '保持布局，重新检查')
    expectCommandError(() => controller.retryLayout(sessionId), 'LAYOUT_RETRY_ALREADY_PENDING')
    expectCommandError(() => controller.startBuild(sessionId), 'LAYOUT_RETRY_ALREADY_PENDING')
    release()
    await waitForLayoutRetry(controller, sessionId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.startBuild(sessionId)
    expectCommandError(() => controller.retryLayout(sessionId), 'LAYOUT_RETRY_ALREADY_PENDING')
    await waitFor(controller, sessionId, 'FAILED')
  })

  it('keeps failed model repairs recoverable inside the layout stage', async () => {
    const { model, controller, sessionId } = await layoutSession()
    model.failNextRevision = true
    controller.retryLayout(sessionId, '保留当前设计')
    const failed = await waitFor(controller, sessionId, 'FAILED')
    expect(failed.error?.code).toBe('LAYOUT_RETRY_PIPELINE_FAILED')
    expect(failed.artifacts.buildRun).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.retryLayout(sessionId)
    await waitForLayoutRetry(controller, sessionId)
  })
})
