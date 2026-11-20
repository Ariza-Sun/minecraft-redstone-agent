import type {
  BuildProgress,
  BuildRun,
  MinecraftEnvironment,
  OutputReading,
  PhysicalLayout,
  Position,
  TaskSpec,
  WorldBlockObservation,
} from '@domain/domain'

export interface MinecraftAdapter {
  readonly mode: 'live' | 'mock'
  readonly authoritative: boolean
  readonly baseOrigin: Position
  selectWorkspace(origin: Position): void
  positionObserver?(username: string, position: Position): Promise<void>
  connect(): Promise<MinecraftEnvironment>
  resetWorkspace(task: TaskSpec): Promise<void>
  build(
    sessionId: string,
    runId: string,
    task: TaskSpec,
    layout: PhysicalLayout,
    onProgress: (progress: BuildProgress) => Promise<void> | void,
  ): Promise<BuildRun>
  setInputs(task: TaskSpec, values: Record<string, 0 | 1>): Promise<void>
  triggerUpdate(task: TaskSpec, layout: PhysicalLayout): Promise<void>
  readOutputs(task: TaskSpec, stableReads: number): Promise<Record<string, OutputReading>>
  inspectWorld(task: TaskSpec, layout: PhysicalLayout): Promise<WorldBlockObservation[]>
  close(): Promise<void>
}

export class MinecraftAdapterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'MinecraftAdapterError'
  }
}
