import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from '@platform/artifact-store'
import type { AppConfig } from '@platform/config'
import { MockMinecraftAdapter } from '@minecraft/mock-adapter'
import { FixtureModelAdapter } from '@agent/model/fixture-adapter'
import type { ModelAdapter, ModelCallResult, ModelContext, ModelProgressReporter } from '@agent/model/model-adapter'
import { SessionController } from './session-controller'
import { DeterministicLayoutValidator } from '@agent/tools/layout-validator'
import { workspacesOverlap } from '@domain/session-workspace'

const tempDirs: string[] = []
afterEach(async () => Promise.all(tempDirs.splice(0).map(async (dir) => {
  // Event and manifest writes may still be draining when a test ends.
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

async function waitFor(
  controller: SessionController,
  sessionId: string,
  expected: string,
  timeoutMs = 4_000,
) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const snapshot = controller.get(sessionId)
    if (snapshot.state === expected) return snapshot
    if (snapshot.state === 'FAILED') throw new Error(`Session failed: ${snapshot.error?.message}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${expected}; current=${controller.get(sessionId).state}`)
}

class BlockingLayoutModel implements ModelAdapter {
  readonly mode = 'fixture' as const
  readonly model = 'fixture/not-gate-v1'
  readonly layoutStarted: Promise<void>
  private resolveLayoutStarted!: () => void
  private readonly layoutGate: Promise<void>
  private resolveLayoutGate!: () => void

  constructor(private readonly delegate: FixtureModelAdapter) {
    this.layoutStarted = new Promise((resolve) => { this.resolveLayoutStarted = resolve })
    this.layoutGate = new Promise((resolve) => { this.resolveLayoutGate = resolve })
  }

  releaseLayout(): void {
    this.resolveLayoutGate()
  }

  async generate(
    context: ModelContext,
    onProgress?: ModelProgressReporter,
  ): Promise<ModelCallResult> {
    if (context.stage === 'layout') {
      this.resolveLayoutStarted()
      await this.layoutGate
    }
    return this.delegate.generate(context, onProgress)
  }
}

class CorrectingLayoutModel implements ModelAdapter {
  readonly mode = 'fixture' as const
  readonly model = 'fixture/not-gate-v1'
  readonly contexts: ModelContext[] = []
  private layoutCalls = 0

  constructor(private readonly delegate: FixtureModelAdapter) {}

  async generate(
    context: ModelContext,
    onProgress?: ModelProgressReporter,
  ): Promise<ModelCallResult> {
    this.contexts.push(structuredClone(context))
    const result = await this.delegate.generate(context, onProgress)
    if (context.stage !== 'layout' || result.action.type !== 'propose_layout') return result
    this.layoutCalls += 1
    if (this.layoutCalls !== 1) return result
    const lamp = result.action.layout.blocks.find((block) => block.id === 'lamp-Y')!
    return {
      ...result,
      action: {
        ...result.action,
        layout: {
          ...result.action.layout,
          blocks: [
            ...result.action.layout.blocks,
            {
              id: 'wire-on-output-port',
              block: 'minecraft:redstone_wire',
              position: { ...lamp.position },
              properties: {},
              implements: ['signal-not-A'],
            },
          ],
        },
      },
    }
  }
}

class RegressingThenCorrectingLayoutModel implements ModelAdapter {
  readonly mode = 'fixture' as const
  readonly model = 'fixture/not-gate-v1'
  readonly contexts: ModelContext[] = []
  private layoutCalls = 0

  constructor(private readonly delegate: FixtureModelAdapter) {}

  async generate(
    context: ModelContext,
    onProgress?: ModelProgressReporter,
  ): Promise<ModelCallResult> {
    this.contexts.push(structuredClone(context))
    const result = await this.delegate.generate(context, onProgress)
    if (context.stage !== 'layout') return result
    this.layoutCalls += 1
    if (this.layoutCalls === 1 && result.action.type === 'propose_layout') {
      const lamp = result.action.layout.blocks.find((block) => block.id === 'lamp-Y')!
      return {
        ...result,
        action: {
          ...result.action,
          layout: {
            ...result.action.layout,
            blocks: [...result.action.layout.blocks, {
              id: 'wire-on-output-port',
              block: 'minecraft:redstone_wire',
              position: { ...lamp.position },
              properties: {},
              implements: ['signal-not-A'],
            }],
          },
        },
      }
    }
    const base = context.artifacts.physicalLayout!
    if (this.layoutCalls === 2) {
      const lever = base.blocks.find((block) => block.id === 'lever-A')!
      return {
        ...result,
        action: {
          type: 'repair_layout',
          patch: {
            baseVersion: base.version,
            upsertBlocks: [{
              id: 'second-port-collision',
              block: 'minecraft:redstone_wire',
              position: { ...lever.position },
              properties: {},
              implements: ['signal-A'],
            }],
            removeBlockIds: [],
            explanation: base.explanation,
            changeSummary: {
              reason: 'Synthetic regressing patch',
              changed: ['Added a second collision'],
              impact: ['Must be rolled back'],
            },
          },
          message: 'Synthetic regression',
        },
      }
    }
    return {
      ...result,
      action: {
        type: 'repair_layout',
        patch: {
          baseVersion: base.version,
          upsertBlocks: [],
          removeBlockIds: ['wire-on-output-port'],
          explanation: base.explanation,
          changeSummary: {
            reason: 'Remove the original output-port collision',
            changed: ['Removed wire-on-output-port'],
            impact: ['Restores output port exclusivity'],
          },
        },
        message: 'Synthetic correction',
      },
    }
  }
}

class StructuralThenFunctionalLayoutModel implements ModelAdapter {
  readonly mode = 'fixture' as const
  readonly model = 'fixture/not-gate-v1'
  readonly contexts: ModelContext[] = []
  private layoutCalls = 0

  constructor(private readonly delegate: FixtureModelAdapter) {}

  async generate(
    context: ModelContext,
    onProgress?: ModelProgressReporter,
  ): Promise<ModelCallResult> {
    this.contexts.push(structuredClone(context))
    const result = await this.delegate.generate(context, onProgress)
    if (context.stage !== 'layout') return result
    this.layoutCalls += 1
    if (this.layoutCalls === 1 && result.action.type === 'propose_layout') {
      // v1: one structural collision on a plain support block; the simulation
      // waits for it.
      const baseInput = result.action.layout.blocks.find((block) => block.id === 'base-input')!
      return {
        ...result,
        action: {
          ...result.action,
          layout: {
            ...result.action.layout,
            blocks: [...result.action.layout.blocks, {
              id: 'extra-wire',
              block: 'minecraft:redstone_wire',
              position: { ...baseInput.position },
              properties: {},
              implements: ['signal-A'],
            }],
          },
        },
      }
    }
    const base = context.artifacts.physicalLayout!
    const wire = base.blocks.find((block) => block.id === 'wire-not-A')!
    if (this.layoutCalls === 2) {
      // v2: structurally clean, but the output route is now a plain stone block
      // that the torch cannot power, so row A=0 fails in the simulation.
      return {
        ...result,
        action: {
          type: 'repair_layout',
          patch: {
            baseVersion: base.version,
            upsertBlocks: [{ ...wire, block: 'minecraft:stone', properties: {} }],
            removeBlockIds: ['extra-wire'],
            explanation: base.explanation,
            changeSummary: { reason: 'Fix collision, break the route', changed: ['wire-not-A'], impact: ['Functional regression'] },
          },
          message: 'Structural fix with a functional regression',
        },
      }
    }
    return {
      ...result,
      action: {
        type: 'repair_layout',
        patch: {
          baseVersion: base.version,
          upsertBlocks: [{ ...wire, block: 'minecraft:redstone_wire', properties: {} }],
          removeBlockIds: [],
          explanation: base.explanation,
          changeSummary: { reason: 'Restore the wire', changed: ['wire-not-A'], impact: ['All rows pass'] },
        },
        message: 'Restore the output wire',
      },
    }
  }
}

describe('SessionController vertical slice', () => {
  it('ranks a structurally clean candidate above one with a structural issue even when the simulation now fails', async () => {
    const runsDir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-layout-ranking-'))
    tempDirs.push(runsDir)
    const minecraftConfig: AppConfig['minecraft'] = {
      mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0,
      viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: 'http://localhost:3007',
    }
    const store = new ArtifactStore(runsDir)
    await store.initialize()
    const model = new StructuralThenFunctionalLayoutModel(new FixtureModelAdapter(store))
    const controller = new SessionController(store, model, new MockMinecraftAdapter(minecraftConfig))

    const created = await controller.create('搭建并验证一个 NOT 非门')
    controller.begin(created.id)
    await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
    controller.approveDesign(created.id)
    const ready = await waitFor(controller, created.id, 'READY_TO_BUILD')

    expect(ready.artifacts.physicalLayout?.version).toBe(3)
    expect(ready.layoutValidation?.simulation).toMatchObject({ evaluated: true, passedCases: 2, totalCases: 2 })

    const events = controller.events(created.id)
    const validations = events.filter((event) => event.type === 'layout.validation.completed')
      .map((event) => event.payload as { issues: Array<{ code: string }>; simulation?: { evaluated: boolean } })
    expect(validations[0].issues.map((issue) => issue.code)).toEqual(['DUPLICATE_POSITION'])
    expect(validations[0].simulation).toMatchObject({ evaluated: false })
    expect(validations[1].issues.map((issue) => issue.code)).toEqual(['SIMULATED_CASE_MISMATCH'])
    expect(validations[1].issues[0]).toMatchObject({
      code: 'SIMULATED_CASE_MISMATCH',
    })

    const bestUpdates = events.filter((event) => event.type === 'layout.best_candidate.updated')
      .map((event) => event.payload as { bestLayoutRef: { version: number }; structural: number; functional: number })
    expect(bestUpdates.map((payload) => payload.bestLayoutRef.version)).toEqual([1, 2])
    expect(bestUpdates[1]).toMatchObject({ structural: 0, functional: 1 })
    expect(events.some((event) => event.type === 'layout.patch.reverted')).toBe(false)

    const thirdCall = model.contexts.filter((context) => context.stage === 'layout')[2]
    expect(thirdCall.artifacts.physicalLayout?.version).toBe(2)
    expect(thirdCall.feedback).toMatchObject({
      repairBaseValidation: {
        structuralIssues: 0,
        functionalIssues: 1,
        simulation: {
          evaluated: true,
          passedCases: 1,
          totalCases: 2,
          failedCases: [expect.objectContaining({ index: 0, inputs: { A: 0 } })],
        },
      },
    })
    const failedCase = (thirdCall.feedback as { repairBaseValidation: { simulation: { failedCases: Array<{ states: string[] }> } } })
      .repairBaseValidation.simulation.failedCases[0]
    expect(failedCase.states.join('\n')).toContain('torch-not-A=LIT')
    expect(failedCase.states.join('\n')).toContain('lamp-Y=OFF')
  })

  it('retains cumulative structured validation errors while correcting a layout', async () => {
    const runsDir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-layout-history-'))
    tempDirs.push(runsDir)
    const minecraftConfig: AppConfig['minecraft'] = {
      mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0,
      viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: 'http://localhost:3007',
    }
    const store = new ArtifactStore(runsDir)
    await store.initialize()
    const model = new CorrectingLayoutModel(new FixtureModelAdapter(store))
    const controller = new SessionController(store, model, new MockMinecraftAdapter(minecraftConfig))

    const created = await controller.create('搭建并验证一个 NOT 非门')
    controller.begin(created.id)
    await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
    controller.approveDesign(created.id)
    const ready = await waitFor(controller, created.id, 'READY_TO_BUILD')

    expect(ready.artifacts.physicalLayout?.version).toBe(2)
    const layoutContexts = model.contexts.filter((context) => context.stage === 'layout')
    expect(layoutContexts).toHaveLength(2)
    expect(layoutContexts[0].feedback).toBeUndefined()
    expect(layoutContexts[1].artifacts.physicalLayout).toMatchObject({
      version: 1,
      blocks: expect.arrayContaining([expect.objectContaining({ id: 'wire-on-output-port' })]),
    })
    expect(layoutContexts[1].feedback).toMatchObject({
      reason: 'layout_validation_failed',
      repairMode: 'patch_best_candidate',
      repairBaseLayoutRef: { version: 1 },
      layoutValidationHistory: [{
        layoutVersion: 1,
        issueGroups: expect.arrayContaining([
          expect.objectContaining({ code: 'DUPLICATE_POSITION' }),
          expect.objectContaining({ code: 'OUTPUT_PORT_NOT_EXCLUSIVE' }),
        ]),
      }],
    })
    expect(controller.events(created.id).some((event) => event.type === 'agent.action.proposed'
      && (event.payload as { type?: string }).type === 'repair_layout')).toBe(true)
  })

  it('rolls back a non-improving patch and repairs the retained best candidate', async () => {
    const runsDir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-layout-best-candidate-'))
    tempDirs.push(runsDir)
    const minecraftConfig: AppConfig['minecraft'] = {
      mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0,
      viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: 'http://localhost:3007',
    }
    const store = new ArtifactStore(runsDir)
    await store.initialize()
    const model = new RegressingThenCorrectingLayoutModel(new FixtureModelAdapter(store))
    const controller = new SessionController(store, model, new MockMinecraftAdapter(minecraftConfig))

    const created = await controller.create('搭建并验证一个 NOT 非门')
    controller.begin(created.id)
    await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
    controller.approveDesign(created.id)
    const ready = await waitFor(controller, created.id, 'READY_TO_BUILD')

    expect(ready.artifacts.physicalLayout?.version).toBe(3)
    const layoutContexts = model.contexts.filter((context) => context.stage === 'layout')
    expect(layoutContexts.map((context) => context.artifacts.physicalLayout?.version)).toEqual([undefined, 1, 1])
    expect(controller.events(created.id).find((event) => event.type === 'layout.patch.reverted')?.payload).toMatchObject({
      candidateLayoutRef: { version: 2 },
      bestLayoutRef: { version: 1 },
      reason: 'Candidate did not strictly reduce the deterministic issue count',
    })
  })

  it('runs TaskSpec → LogicDesign → PhysicalLayout → build → verification with one event chain', async () => {
    const runsDir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-runs-'))
    tempDirs.push(runsDir)
    const minecraftConfig: AppConfig['minecraft'] = {
      mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0,
      viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: 'http://localhost:3007',
    }
    const store = new ArtifactStore(runsDir)
    await store.initialize()
    const controller = new SessionController(store, new FixtureModelAdapter(store), new MockMinecraftAdapter(minecraftConfig))

    const created = await controller.create('搭建并验证一个 NOT 非门')
    controller.begin(created.id)
    const reviewed = await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
    expect(reviewed.logicCheck?.passed).toBe(true)
    expect(reviewed.artifacts.logicDesign?.taskSpecRef).toEqual({ id: reviewed.artifacts.task?.id, version: 1 })

    controller.approveDesign(created.id)
    const ready = await waitFor(controller, created.id, 'READY_TO_BUILD')
    expect(ready.layoutValidation?.passed).toBe(true)
    expect(ready.artifacts.physicalLayout?.logicDesignRef).toEqual({ id: ready.artifacts.logicDesign?.id, version: 1 })
    const layoutEventTypes = controller.events(created.id)
      .filter((event) => (event.payload as { stage?: string }).stage === 'layout'
        || event.type === 'layout.validation.completed')
      .map((event) => event.type)
    expect(layoutEventTypes).toEqual(expect.arrayContaining([
      'model.call.started',
      'model.attempt.started',
      'model.output.received',
      'model.output.accepted',
      'layout.validation.completed',
    ]))
    const task = ready.artifacts.task!
    const logic = ready.artifacts.logicDesign!
    const layout = ready.artifacts.physicalLayout!
    const collision = await new DeterministicLayoutValidator().validate(task, logic, {
      ...layout,
      blocks: [...layout.blocks, { ...layout.blocks[0], id: 'deliberate-collision' }],
    })
    expect(collision.passed).toBe(false)
    expect(collision.issues.some((issue) => issue.code === 'DUPLICATE_POSITION')).toBe(true)

    const unsupported = await new DeterministicLayoutValidator().validate(task, logic, {
      ...layout,
      blocks: layout.blocks.filter((block) => block.id !== 'input-core'),
    })
    expect(unsupported.passed).toBe(false)
    expect(unsupported.issues.some((issue) => issue.code === 'MISSING_SUPPORT' && issue.blockId === 'lever-A')).toBe(true)

    controller.startBuild(created.id)
    const completed = await waitFor(controller, created.id, 'COMPLETED_NON_AUTHORITATIVE')
    expect(completed.artifacts.buildRun?.placed).toBe(completed.artifacts.physicalLayout?.blocks.length)
    expect(completed.artifacts.verificationReport?.passed).toBe(true)
    expect(completed.artifacts.verificationReport?.authoritative).toBe(false)
    expect(controller.events(created.id).map((event) => event.seq)).toEqual(
      controller.events(created.id).map((_, index) => index + 1),
    )

    const displayed = await controller.showVerificationCase(created.id, 0)
    expect(displayed).toMatchObject({
      index: 0,
      inputs: { A: 0 },
      expected: { Y: 1 },
      actual: { Y: 1 },
      passed: true,
      authoritative: false,
    })
    expect(displayed.evidence).toHaveLength(task.acceptance.stableReads)
    expect(controller.events(created.id).some((event) => event.type === 'minecraft.case.applied')).toBe(true)

    const provenanceReply = await controller.sendMessage(created.id, '这个电路是 LLM 即时生成的吗？', { caseIndex: 0 })
    expect(provenanceReply.message).toContain('fixture')
    const caseReply = await controller.sendMessage(created.id, '当前用例的真实状态是什么？', { caseIndex: 0 })
    expect(caseReply.message).toContain('Case 1')

    const conversationRequests = (await readdir(path.join(runsDir, created.id, 'model')))
      .filter((name) => name.startsWith('request-'))
      .sort()
    const lastConversationRequest = JSON.parse(await readFile(
      path.join(runsDir, created.id, 'model', conversationRequests.at(-1)!),
      'utf8',
    ))
    expect(lastConversationRequest.focus).toEqual({ caseIndex: 0 })
    expect(lastConversationRequest.deterministicContext.displayedWorldCase.index).toBe(0)
    expect(lastConversationRequest.conversationHistory).toEqual([
      { role: 'user', content: '这个电路是 LLM 即时生成的吗？' },
      { role: 'assistant', content: provenanceReply.message },
    ])

    const manifest = await readFile(path.join(runsDir, created.id, 'manifest.json'), 'utf8')
    const eventLog = await readFile(path.join(runsDir, created.id, 'events.jsonl'), 'utf8')
    expect(JSON.parse(manifest).state).toBe('COMPLETED_NON_AUTHORITATIVE')
    expect(eventLog).toContain('verification.completed')
    expect(eventLog).not.toContain('OPENROUTER_API_KEY')

    await store.writeModelExchange(created.id, { authorization: 'Bearer sk-or-v1-test-secret' }, { ok: true })
    const modelFiles = (await readdir(path.join(runsDir, created.id, 'model'))).filter((name) => name.startsWith('request-')).sort()
    const redacted = await readFile(path.join(runsDir, created.id, 'model', modelFiles.at(-1)!), 'utf8')
    expect(redacted).not.toContain('sk-or-v1-test-secret')
    expect(redacted).toContain('[REDACTED]')

    const restored = await store.loadSessions()
    expect(restored.find((item) => item.snapshot.id === created.id)?.snapshot).toMatchObject({
      id: created.id,
      state: 'COMPLETED_NON_AUTHORITATIVE',
      artifacts: {
        task: { version: 1 },
        logicDesign: { version: 1 },
        physicalLayout: { version: 1 },
      },
    })
    expect(restored.find((item) => item.snapshot.id === created.id)?.events.length).toBe(controller.events(created.id).length)
  })

  it('answers context conversation while layout generation is still running', async () => {
    const runsDir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-concurrent-chat-'))
    tempDirs.push(runsDir)
    const minecraftConfig: AppConfig['minecraft'] = {
      mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0,
      viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: 'http://localhost:3007',
    }
    const store = new ArtifactStore(runsDir)
    await store.initialize()
    const model = new BlockingLayoutModel(new FixtureModelAdapter(store))
    const controller = new SessionController(store, model, new MockMinecraftAdapter(minecraftConfig))
    const created = await controller.create('搭建并验证一个 NOT 非门')

    controller.begin(created.id)
    await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
    controller.approveDesign(created.id)
    await model.layoutStarted

    try {
      const reply = await Promise.race([
        controller.sendMessage(created.id, '为什么这样设计？'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Conversation was blocked by layout')), 500)),
      ])
      expect(reply.message).toContain('反相')
      expect(controller.get(created.id).state).toBe('PLANNING_LAYOUT')
    } finally {
      model.releaseLayout()
    }

    await waitFor(controller, created.id, 'READY_TO_BUILD')
    const events = controller.events(created.id)
    expect(events.some((event) => event.type === 'conversation.agent.reply')).toBe(true)
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length)
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
  })

  it('shows verified retests in home summaries and preserves the active circuit across a reload', async () => {
    const minecraftConfig: AppConfig['minecraft'] = {
      mode: 'mock', host: 'localhost', port: 25565, username: 'test', origin: { x: 0, y: 72, z: 0 },
      commandDelayMs: 0, settleMs: 0, viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: '/minecraft-viewer/',
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-retest-summary-'))
    tempDirs.push(dir)
    const store = new ArtifactStore(path.join(dir, 'runs'))
    await store.initialize()
    const minecraft = new MockMinecraftAdapter(minecraftConfig)
    const model = new FixtureModelAdapter(store)
    const controller = new SessionController(store, model, minecraft)
    const created = await controller.create('NOT')
    controller.begin(created.id)
    await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
    controller.approveDesign(created.id)
    await waitFor(controller, created.id, 'READY_TO_BUILD')
    controller.startBuild(created.id)
    const snapshot = await waitFor(controller, created.id, 'COMPLETED_NON_AUTHORITATIVE')
    const events = controller.events(created.id)
    snapshot.state = 'FAILED'
    snapshot.authoritative = true
    snapshot.error = { code: 'MINECRAFT_VERIFICATION_FAILED', message: 'Input did not switch', recoverable: false }
    const report = snapshot.artifacts.verificationReport!
    report.authoritative = true
    const row = structuredClone(report.cases[0])
    report.cases[0] = { ...row, passed: false, actual: { Y: 'unreadable' }, evidence: [] }
    report.passed = false
    report.passedCases -= 1
    report.environmentErrors = [{ code: 'VERIFICATION_CASE_ERROR', message: 'Input did not switch', details: { index: 0 }, recoverable: true }]
    events.push({ sessionId: snapshot.id, seq: snapshot.latestSeq + 1, at: new Date(Date.parse(report.finishedAt) + 1000).toISOString(),
      type: 'minecraft.case.applied', payload: { ...row, authoritative: true, appliedAt: new Date().toISOString() },
      refs: [report.taskSpecRef, report.buildRunRef, { id: snapshot.artifacts.physicalLayout!.id, version: snapshot.artifacts.physicalLayout!.version }] })
    snapshot.latestSeq += 1
    const restarted = new SessionController(store, model, minecraft, undefined, [{ snapshot, events }])
    expect(restarted.summaries()[0].state).toBe('SUCCEEDED')
    expect(restarted.get(snapshot.id).artifacts.verificationReport?.passed).toBe(false)
    const build = vi.spyOn(minecraft, 'build')
    const reset = vi.spyOn(minecraft, 'resetWorkspace')
    const connect = vi.spyOn(minecraft, 'connect')
    const generate = vi.spyOn(model, 'generate')
    // Showing a case after reload reads the existing circuit; no model or build.
    expect(await restarted.showVerificationCase(snapshot.id, 1)).toMatchObject({ passed: true, purpose: 'display' })
    expect(connect).toHaveBeenCalledOnce()
    expect(build).not.toHaveBeenCalled()
    expect(reset).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('positions the observer while building instead of waiting for verification to finish', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-live-build-view-'))
    tempDirs.push(dir)
    const config: AppConfig['minecraft'] = { mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0, viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: '/minecraft-viewer/' }
    const store = new ArtifactStore(path.join(dir, 'runs'))
    await store.initialize()
    const positionObserver = vi.fn(async () => {})
    const minecraft = Object.assign(new MockMinecraftAdapter(config), { positionObserver })
    const controller = new SessionController(store, new FixtureModelAdapter(store), minecraft)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const building = new Promise<void>((resolve) => { started = resolve })
    const build = minecraft.build.bind(minecraft)
    vi.spyOn(minecraft, 'build').mockImplementation(async (...args) => {
      started()
      await gate
      return build(...args)
    })
    const session = await controller.create('NOT')
    controller.begin(session.id)
    await waitFor(controller, session.id, 'AWAITING_DESIGN_REVIEW')
    controller.approveDesign(session.id)
    await waitFor(controller, session.id, 'READY_TO_BUILD')
    controller.startBuild(session.id)
    await building
    try {
      expect(controller.get(session.id).worldView?.available).toBe(true)
      await Promise.race([
        controller.positionObserver('MICA_v_1234abcd', { x: 7, y: 76, z: 7 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Observer blocked by build')), 500)),
      ])
      expect(positionObserver).toHaveBeenCalledOnce()
      expect(controller.get(session.id).state).toBe('BUILDING')
      expect(controller.get(session.id).artifacts.verificationReport).toBeUndefined()
    } finally { release() }
    await waitFor(controller, session.id, 'COMPLETED_NON_AUTHORITATIVE')
  })

  it('keeps two concurrent tasks in separate persistent regions and can retest either after reload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-isolation-'))
    tempDirs.push(dir)
    const config: AppConfig['minecraft'] = { mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0, viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: '/minecraft-viewer/' }
    const store = new ArtifactStore(path.join(dir, 'runs'))
    await store.initialize()
    const minecraft = new MockMinecraftAdapter(config)
    const model = new FixtureModelAdapter(store)
    const controller = new SessionController(store, model, minecraft)
    const sessions = await Promise.all([controller.create('NOT A'), controller.create('NOT B')])
    for (const session of sessions) controller.begin(session.id)
    await Promise.all(sessions.map((session) => waitFor(controller, session.id, 'AWAITING_DESIGN_REVIEW')))
    for (const session of sessions) controller.approveDesign(session.id)
    await Promise.all(sessions.map((session) => waitFor(controller, session.id, 'READY_TO_BUILD')))
    for (const session of sessions) controller.startBuild(session.id)
    const completed = await Promise.all(sessions.map((session) => waitFor(controller, session.id, 'COMPLETED_NON_AUTHORITATIVE')))
    const [a, b] = completed
    expect(workspacesOverlap(a.worldWorkspace!, b.worldWorkspace!)).toBe(false)
    expect(a.artifacts.buildRun?.environment.worldOrigin).toEqual(a.worldWorkspace?.origin)
    expect(b.artifacts.buildRun?.environment.worldOrigin).toEqual(b.worldWorkspace?.origin)
    expect(a.worldView?.available).toBe(true)
    expect(b.worldView?.available).toBe(true)
    const restored = completed.map((snapshot) => ({ snapshot, events: controller.events(snapshot.id) }))
    const restarted = new SessionController(store, model, minecraft, undefined, restored)
    const select = vi.spyOn(minecraft, 'selectWorkspace')
    const reset = vi.spyOn(minecraft, 'resetWorkspace')
    const build = vi.spyOn(minecraft, 'build')
    await restarted.showVerificationCase(a.id, 0)
    expect(select).toHaveBeenLastCalledWith(a.worldWorkspace?.origin)
    await restarted.showVerificationCase(b.id, 1)
    expect(select).toHaveBeenLastCalledWith(b.worldWorkspace?.origin)
    expect(reset).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()
    // Old shared-coordinate sessions must not borrow the latest circuit.
    const legacy = structuredClone(restored)
    for (const [index, item] of legacy.entries()) for (const event of item.events) {
      if (event.type === 'minecraft.workspace.reset') {
        ;(event.payload as { worldOrigin: typeof config.origin }).worldOrigin = config.origin
        event.at = `2026-10-07T10:0${index}:00.000Z`
      }
    }
    const old = new SessionController(store, model, minecraft, undefined, legacy)
    expect(old.worldView(a.id).available).toBe(false)
    expect(old.worldView(b.id).available).toBe(true)
    await expect(old.showVerificationCase(a.id, 0)).rejects.toMatchObject({ code: 'WORLD_SESSION_NOT_ACTIVE' })
  })

  it('lists sessions as light summaries, including ones restored from disk', async () => {
    const runsDir = await mkdtemp(path.join(os.tmpdir(), 'mc-ic-summaries-'))
    tempDirs.push(runsDir)
    const minecraftConfig: AppConfig['minecraft'] = {
      mode: 'mock', host: 'localhost', port: 25565, username: 'test',
      origin: { x: 0, y: 72, z: 0 }, commandDelayMs: 0, settleMs: 0,
      viewerEnabled: false, viewerPort: 3007, viewerPublicUrl: 'http://localhost:3007',
    }
    const store = new ArtifactStore(runsDir)
    await store.initialize()
    const controller = new SessionController(store, new FixtureModelAdapter(store), new MockMinecraftAdapter(minecraftConfig))

    // Until a TaskSpec exists the request stands in for the title, cut to a bounded length.
    const request = `搭建并验证一个 NOT 非门。${'补充说明。'.repeat(60)}`
    const created = await controller.create(request)
    expect(controller.summaries()).toEqual([expect.objectContaining({
      id: created.id,
      state: 'COLLECTING_REQUIREMENTS',
      mode: 'interactive',
      model: 'fixture/not-gate-v1',
      modelMode: 'fixture',
      title: request.slice(0, 120),
    })])

    controller.begin(created.id)
    const reviewed = await waitFor(controller, created.id, 'AWAITING_DESIGN_REVIEW')
    const [summary] = controller.summaries()
    expect(summary).toMatchObject({ state: 'AWAITING_DESIGN_REVIEW', title: reviewed.artifacts.task!.title })
    expect(summary).not.toHaveProperty('artifacts')
    expect(summary).not.toHaveProperty('request')

    // State becomes visible in memory before its queued manifest write completes.
    // Once persistence drains, a restart must restore the same current row.
    await vi.waitFor(async () => {
      const restarted = new SessionController(
        store,
        new FixtureModelAdapter(store),
        new MockMinecraftAdapter(minecraftConfig),
        undefined,
        await store.loadSessions(),
      )
      expect(restarted.summaries()).toEqual(controller.summaries())
    }, { timeout: 4_000 })
  })
})
