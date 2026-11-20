import {
  normalizeBlockName,
  type BuildProgress,
  type BuildRun,
  type LayoutBlock,
  type MinecraftEnvironment,
  type OutputReading,
  type PhysicalLayout,
  type Position,
  type TaskSpec,
  type WorldBlockObservation,
} from '@domain/domain'
import type { AppConfig } from '@platform/config'
import { blockCapability } from '@domain/block-capabilities'
import { attachmentSupportPosition, orderBlocksForBuild } from '@domain/layout-physics'
import { isGrasslandSurface } from '@domain/world-environment'
import type { MinecraftAdapter } from './minecraft-adapter'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class MockMinecraftAdapter implements MinecraftAdapter {
  readonly mode = 'mock' as const
  readonly authoritative = false
  private inputs: Record<string, 0 | 1> = {}
  readonly baseOrigin: Position
  private origin: Position

  constructor(private readonly config: AppConfig['minecraft']) {
    this.baseOrigin = { ...config.origin }
    this.origin = { ...config.origin }
  }

  selectWorkspace(origin: Position): void {
    this.origin = { ...origin }
  }

  async connect(): Promise<MinecraftEnvironment> {
    return {
      adapter: 'mock',
      authoritative: false,
      host: 'in-process',
      port: 0,
      version: 'non-authoritative-demo',
      worldOrigin: { ...this.origin },
    }
  }

  async resetWorkspace(_task: TaskSpec): Promise<void> {
    this.inputs = {}
  }

  async build(
    sessionId: string,
    runId: string,
    _task: TaskSpec,
    layout: PhysicalLayout,
    onProgress: (progress: BuildProgress) => Promise<void> | void,
  ): Promise<BuildRun> {
    const run: BuildRun = {
      id: runId,
      version: 1,
      sessionId,
      layoutRef: { id: layout.id, version: layout.version },
      environment: await this.connect(),
      status: 'running',
      placed: 0,
      total: layout.blocks.length,
      startedAt: new Date().toISOString(),
      errors: [],
    }
    for (const block of orderBlocksForBuild(layout.blocks)) {
      await sleep(18)
      run.placed += 1
      await onProgress({
        runId,
        placed: run.placed,
        total: run.total,
        block,
        worldPosition: {
          x: this.origin.x + block.position.x,
          y: this.origin.y + block.position.y,
          z: this.origin.z + block.position.z,
        },
      })
    }
    run.status = 'completed'
    run.finishedAt = new Date().toISOString()
    return run
  }

  async setInputs(_task: TaskSpec, values: Record<string, 0 | 1>): Promise<void> {
    this.inputs = { ...values }
  }

  async triggerUpdate(_task: TaskSpec, _layout: PhysicalLayout): Promise<void> {
    await sleep(20)
  }

  async readOutputs(task: TaskSpec, stableReads: number): Promise<Record<string, OutputReading>> {
    const row = task.truthTable.find((candidate) =>
      task.inputs.every((input) => candidate.inputs[input.id] === this.inputs[input.id]))
    return Object.fromEntries(task.outputs.map((output) => [
      output.id,
      {
        value: row?.outputs[output.id] ?? 'unreadable',
        evidence: Array.from({ length: stableReads }, () => ({
          type: 'mock-reading' as const,
          source: 'in-process truth-table fixture; never benchmark eligible',
          at: new Date().toISOString(),
          properties: { input: this.inputs, authoritative: false },
        })),
      },
    ]))
  }

  async inspectWorld(_task: TaskSpec, layout: PhysicalLayout): Promise<WorldBlockObservation[]> {
    const key = (position: Position) => `${position.x},${position.y},${position.z}`
    const byPosition = new Map<string, LayoutBlock[]>()
    for (const block of layout.blocks) {
      const blocks = byPosition.get(key(block.position)) ?? []
      blocks.push(block)
      byPosition.set(key(block.position), blocks)
    }
    const targets = new Map<string, { position: Position; expected: WorldBlockObservation['expected'] }>()
    const add = (position: Position, expected: WorldBlockObservation['expected'][number]) => {
      const id = key(position)
      const target = targets.get(id) ?? { position, expected: [] }
      if (!target.expected.some((item) => item.blockId === expected.blockId && item.relation === expected.relation)) {
        target.expected.push(expected)
      }
      targets.set(id, target)
    }
    for (const block of layout.blocks) {
      add(block.position, { blockId: block.id, block: normalizeBlockName(block.block), relation: 'layout' })
      const supportPosition = attachmentSupportPosition(block)
      if (!supportPosition) continue
      const support = byPosition.get(key(supportPosition))?.[0]
      add(supportPosition, {
        blockId: block.id,
        block: support
          ? normalizeBlockName(support.block)
          : isGrasslandSurface(supportPosition)
            ? 'minecraft:grass_block'
            : 'minecraft:solid_support',
        relation: 'attachment_support',
      })
    }
    return [...targets.values()].map((target) => {
      const layoutBlock = byPosition.get(key(target.position))?.[0]
      const actualBlock = layoutBlock
        ? normalizeBlockName(layoutBlock.block)
        : isGrasslandSurface(target.position)
          ? 'minecraft:grass_block'
          : undefined
      const properties = layoutBlock
        ? {
            ...layoutBlock.properties,
            ...(actualBlock === 'minecraft:lever'
              ? {
                  powered: Boolean(layoutBlock.implements
                    .map((id) => this.inputs[id])
                    .find((value) => value !== undefined)),
                }
              : {}),
            mock: true,
          }
        : { mock: true }
      const matchedExpected = target.expected.every((expected) => (
        expected.block === 'minecraft:solid_support'
          ? Boolean(actualBlock && blockCapability(actualBlock)?.solidSupport)
          : actualBlock === expected.block
      ))
      return {
        position: target.position,
        worldPosition: {
          x: this.origin.x + target.position.x,
          y: this.origin.y + target.position.y,
          z: this.origin.z + target.position.z,
        },
        expected: target.expected,
        actualBlock,
        properties,
        matchedExpected,
      }
    })
  }

  async close(): Promise<void> {}
}
