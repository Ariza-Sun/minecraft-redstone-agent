import type { AgentAction, LogicDesignDraft, PhysicalLayoutDraft, TaskSpecDraft } from '@domain/domain'
import type { ArtifactStore } from '@platform/artifact-store'
import { ModelAdapterError, type ModelAdapter, type ModelCallResult, type ModelContext, type ModelProgressReporter } from './model-adapter'

function notTask(description: string): TaskSpecDraft {
  return {
    title: '单输入 NOT 门',
    description,
    inputs: [{ id: 'A', label: '输入 A', port: { position: { x: 1, y: 2, z: 2 }, facing: 'north' } }],
    outputs: [{ id: 'Y', label: '输出 Y', port: { position: { x: 4, y: 1, z: 2 }, facing: 'east' } }],
    truthTable: [
      { inputs: { A: 0 }, outputs: { Y: 1 } },
      { inputs: { A: 1 }, outputs: { Y: 0 } },
    ],
    workspace: { origin: { x: 0, y: 0, z: 0 }, size: { x: 7, y: 4, z: 5 } },
    allowedBlocks: [
      'minecraft:stone',
      'minecraft:lever',
      'minecraft:redstone_wall_torch',
      'minecraft:redstone_wire',
      'minecraft:redstone_lamp',
    ],
    maxBlocks: 16,
    acceptance: { requireAllCases: true, stableReads: 3 },
  }
}

const notLogic: LogicDesignDraft = {
  nodes: [
    { id: 'A', kind: 'input', label: '输入 A' },
    { id: 'NOT_A', kind: 'not', label: '反相器' },
    { id: 'Y', kind: 'output', label: '输出 Y' },
  ],
  edges: [
    { id: 'signal-A', from: 'A', to: 'NOT_A', signal: 'A' },
    { id: 'signal-not-A', from: 'NOT_A', to: 'Y', signal: '¬A' },
  ],
  equations: { Y: 'Y = NOT A' },
  explanation: {
    overview: '拉杆 A 驱动输入块；侧挂红石火把完成反相，火把输出经红石粉送到灯 Y。',
    componentNotes: [
      { nodeId: 'A', text: 'A=1 时拉杆为输入块强充能。' },
      { nodeId: 'NOT_A', text: '输入块充能时侧挂火把熄灭，因此输出与 A 相反。' },
      { nodeId: 'Y', text: '红石灯把反相信号显示为可读取的 lit 状态。' },
    ],
    validationPlan: '依次设置 A=0 和 A=1；每次触发邻居更新并连续读取红石灯三次。',
  },
}

const notLayout: PhysicalLayoutDraft = {
  bounds: { x: 7, y: 4, z: 5 },
  blocks: [
    { id: 'base-input', block: 'minecraft:stone', position: { x: 1, y: 0, z: 2 }, properties: {}, implements: ['signal-A'], phase: 0 },
    { id: 'base-torch', block: 'minecraft:stone', position: { x: 2, y: 0, z: 2 }, properties: {}, implements: ['NOT_A'], phase: 0 },
    { id: 'base-wire', block: 'minecraft:stone', position: { x: 3, y: 0, z: 2 }, properties: {}, implements: ['signal-not-A'], phase: 0 },
    { id: 'base-output', block: 'minecraft:stone', position: { x: 4, y: 0, z: 2 }, properties: {}, implements: ['Y'], phase: 0 },
    { id: 'input-core', block: 'minecraft:stone', position: { x: 1, y: 1, z: 2 }, properties: {}, implements: ['A', 'signal-A'], phase: 1 },
    { id: 'lever-A', block: 'minecraft:lever', position: { x: 1, y: 2, z: 2 }, properties: { face: 'floor', facing: 'north', powered: false }, implements: ['A'], phase: 2 },
    { id: 'torch-not-A', block: 'minecraft:redstone_wall_torch', position: { x: 2, y: 1, z: 2 }, properties: { facing: 'east', lit: true }, implements: ['NOT_A', 'signal-not-A'], phase: 2 },
    { id: 'wire-not-A', block: 'minecraft:redstone_wire', position: { x: 3, y: 1, z: 2 }, properties: {}, implements: ['signal-not-A'], phase: 2 },
    { id: 'lamp-Y', block: 'minecraft:redstone_lamp', position: { x: 4, y: 1, z: 2 }, properties: {}, implements: ['Y'], phase: 2 },
  ],
  explanation: {
    overview: '完整布局沿 X 轴展开，输入、反相、路由和输出保持一眼可追踪。',
    criticalOrientations: [
      { blockId: 'lever-A', text: '拉杆位于输入块顶面。' },
      { blockId: 'torch-not-A', text: 'wall torch facing=east，挂接到西侧输入块。' },
    ],
    routingNotes: ['所有坐标均相对工作区原点。', 'phase 只优化可视搭建顺序，不承担逻辑正确性。'],
  },
}

export class FixtureModelAdapter implements ModelAdapter {
  readonly mode = 'fixture' as const
  readonly model = 'fixture/not-gate-v1'

  constructor(private readonly store: ArtifactStore) {}

  async generate(context: ModelContext, onProgress?: ModelProgressReporter): Promise<ModelCallResult> {
    const started = Date.now()
    await onProgress?.({
      type: 'attempt.started',
      attempt: 1,
      maxAttempts: 1,
      model: this.model,
    })
    let action: AgentAction
    if (context.stage === 'task') {
      if (!/(not|非门|反相|取反)/i.test(context.userRequest)) {
        throw new ModelAdapterError('The offline fixture only supports the NOT-gate sample request', 'FIXTURE_TASK_UNSUPPORTED')
      }
      action = { type: 'propose_task_spec', taskSpec: notTask(context.userRequest), message: '已把请求规范化为完整的单输入 NOT 真值表。' }
    } else if (context.stage === 'logic') {
      action = { type: 'propose_logic_design', design: notLogic, message: '逻辑设计已生成，等待确定性真值表检查。' }
    } else if (context.stage === 'layout') {
      const repairBase = context.artifacts.physicalLayout
      const repairMode = repairBase
        && context.feedback
        && typeof context.feedback === 'object'
        && !Array.isArray(context.feedback)
        && (context.feedback as Record<string, unknown>).repairMode === 'patch_best_candidate'
      if (repairBase && repairMode) {
        const targetById = new Map(notLayout.blocks.map((block) => [block.id, block]))
        const baseById = new Map(repairBase.blocks.map((block) => [block.id, block]))
        action = {
          type: 'repair_layout',
          patch: {
            baseVersion: repairBase.version,
            upsertBlocks: notLayout.blocks.filter((block) => JSON.stringify(baseById.get(block.id)) !== JSON.stringify(block)),
            removeBlockIds: repairBase.blocks.filter((block) => !targetById.has(block.id)).map((block) => block.id),
            explanation: notLayout.explanation,
            changeSummary: {
              reason: 'Restore the deterministic fixture layout from the retained repair base.',
              changed: ['Only block IDs that differ from the fixture baseline are patched.'],
              impact: ['Unmentioned blocks are preserved by the controller.'],
            },
          },
          message: '已对当前最佳布局生成局部修补。',
        }
      } else {
        action = { type: 'propose_layout', layout: notLayout, message: '已生成完整基础方块布局，等待边界与 blockstate 校验。' }
      }
    } else {
      const question = context.userMessage ?? ''
      const worldCase = context.deterministicContext?.displayedWorldCase
      const report = context.artifacts.verificationReport
      const message = /(llm|模型|即时|生成|fixture|规则)/i.test(question)
        ? '当前是离线 fixture 模式：TaskSpec、LogicDesign 和 PhysicalLayout 都来自代码内预置的 NOT 门样例，不是 LLM 即时生成。切换到 MODEL_MODE=openrouter 后，三个工程产物和本轮对话才由配置的模型实时生成。'
        : /(验证|用例|case|输入|输出|状态)/i.test(question)
          ? worldCase
            ? `当前 Minecraft 展示 Case ${worldCase.index + 1}：输入 ${JSON.stringify(worldCase.inputs)}，实际输出 ${JSON.stringify(worldCase.actual)}，${worldCase.passed ? '与期望一致' : '与期望不一致'}。这是${worldCase.authoritative ? '真实世界读回' : '非权威 mock 结果'}。`
            : report
              ? `验证报告通过 ${report.passedCases}/${report.totalCases} 个用例；点击真值表中的一行可把该输入重新施加到当前世界。`
              : '当前还没有 Minecraft 验证报告。'
          : /(布局|方块|坐标|红石)/i.test(question)
            ? context.artifacts.physicalLayout?.explanation.overview ?? '当前尚无可引用的 PhysicalLayout。'
            : context.artifacts.logicDesign?.explanation.overview ?? '当前尚无可引用的逻辑设计。'
      action = {
        type: 'reply',
        message,
        refs: context.artifacts.logicDesign ? [{ id: context.artifacts.logicDesign.id, version: context.artifacts.logicDesign.version }] : undefined,
      }
    }
    const rawResponseRef = await this.store.writeModelExchange(
      context.sessionId,
      {
        fixture: true,
        stage: context.stage,
        userMessage: context.userMessage,
        conversationHistory: context.conversationHistory,
        focus: context.focus,
        deterministicContext: context.deterministicContext,
        provenance: context.provenance,
        feedback: context.feedback,
      },
      { fixture: true, action },
    )
    await onProgress?.({
      type: 'output.received',
      attempt: 1,
      maxAttempts: 1,
      model: this.model,
      rawResponseRef,
      output: JSON.stringify(action),
      truncated: false,
      elapsedMs: Date.now() - started,
    })
    await onProgress?.({
      type: 'output.accepted',
      attempt: 1,
      maxAttempts: 1,
      model: this.model,
      rawResponseRef,
      actionType: action.type,
    })
    return {
      requestedModel: this.model,
      resolvedModel: this.model,
      action,
      rawResponseRef,
      latencyMs: Date.now() - started,
      formatErrors: [],
      attempts: 1,
    }
  }
}
