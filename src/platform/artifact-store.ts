import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  BuildRun,
  LogicDesign,
  PhysicalLayout,
  SessionEvent,
  SessionSnapshot,
  TaskSpec,
  VerificationReport,
  WorldInspectionReport,
} from '@domain/domain'

type Artifact = TaskSpec | LogicDesign | PhysicalLayout | BuildRun | VerificationReport | WorldInspectionReport

export type RestoredSession = {
  snapshot: SessionSnapshot
  events: SessionEvent[]
}

type Manifest = {
  schemaVersion: string
  sessionId: string
  createdAt: string
  updatedAt: string
  mode: string
  model: string
  modelMode: string
  minecraftMode: string
  authoritative: boolean
  state: string
  latestSeq: number
  runPolicy: SessionSnapshot['runPolicy']
  codeVersion: string
}

const artifactNames: Record<string, string> = {
  task: 'task-spec',
  logic: 'logic-design',
  layout: 'physical-layout',
  build: 'build-run',
  verification: 'verification-report',
  inspection: 'world-inspection-report',
}

function safeJson(value: unknown): string {
  return `${JSON.stringify(redact(value), null, 2)}\n`
}

async function atomicWrite(file: string, contents: string, mode: number): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { mode })
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /^(authorization|api[-_]?key|[a-z0-9]+_api_key|access_token|refresh_token|id_token|secret|password)$/i.test(key)
          ? '[REDACTED]'
          : redact(child),
      ]),
    )
  }
  return value
}

export class ArtifactStore {
  private readonly emitter = new EventEmitter()
  private readonly modelCounters = new Map<string, number>()

  constructor(private readonly root: string) {
    this.emitter.setMaxListeners(100)
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  async loadSessions(): Promise<RestoredSession[]> {
    const entries = await readdir(this.root, { withFileTypes: true })
    const restored: RestoredSession[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      const dir = this.sessionDir(entry.name)
      try {
        const [snapshotText, eventsText, modelFiles] = await Promise.all([
          readFile(path.join(dir, 'snapshot.json'), 'utf8'),
          readFile(path.join(dir, 'events.jsonl'), 'utf8').catch(() => ''),
          readdir(path.join(dir, 'model')).catch(() => [] as string[]),
        ])
        const snapshot = JSON.parse(snapshotText) as SessionSnapshot
        if (snapshot.id !== entry.name) continue
        const events = eventsText
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as SessionEvent]
            } catch {
              return []
            }
          })
          .filter((event) => event.sessionId === snapshot.id)
          .sort((left, right) => left.seq - right.seq)
        const lastModelIndex = modelFiles.reduce((maximum, file) => {
          const match = /^response-(\d+)\.json$/.exec(file)
          return match ? Math.max(maximum, Number.parseInt(match[1], 10)) : maximum
        }, 0)
        this.modelCounters.set(snapshot.id, lastModelIndex)
        restored.push({ snapshot, events })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`Unable to restore ${entry.name}:`, error)
        }
      }
    }
    return restored.sort((left, right) => left.snapshot.createdAt.localeCompare(right.snapshot.createdAt))
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId)
  }

  async createSession(snapshot: SessionSnapshot): Promise<void> {
    const dir = this.sessionDir(snapshot.id)
    await Promise.all([
      mkdir(path.join(dir, 'artifacts'), { recursive: true }),
      mkdir(path.join(dir, 'model'), { recursive: true }),
      mkdir(path.join(dir, 'evidence'), { recursive: true }),
    ])
    await this.updateManifest(snapshot)
  }

  async updateManifest(snapshot: SessionSnapshot): Promise<void> {
    const manifest: Manifest = {
      schemaVersion: 'mc-ic.prototype.v1',
      sessionId: snapshot.id,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      mode: snapshot.mode,
      model: snapshot.model,
      modelMode: snapshot.modelMode,
      minecraftMode: snapshot.minecraftMode,
      authoritative: snapshot.authoritative,
      state: snapshot.state,
      latestSeq: snapshot.latestSeq,
      runPolicy: snapshot.runPolicy,
      codeVersion: process.env.CODE_VERSION ?? 'working-tree',
    }
    await Promise.all([
      atomicWrite(path.join(this.sessionDir(snapshot.id), 'manifest.json'), safeJson(manifest), 0o644),
      atomicWrite(path.join(this.sessionDir(snapshot.id), 'snapshot.json'), safeJson(snapshot), 0o644),
    ])
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    await appendFile(
      path.join(this.sessionDir(event.sessionId), 'events.jsonl'),
      `${JSON.stringify(redact(event))}\n`,
      { mode: 0o644 },
    )
    this.emitter.emit(event.sessionId, event)
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    this.emitter.on(sessionId, listener)
    return () => this.emitter.off(sessionId, listener)
  }

  async writeArtifact(
    sessionId: string,
    kind: keyof typeof artifactNames,
    artifact: Artifact,
  ): Promise<void> {
    const name = artifactNames[kind]
    await atomicWrite(
      path.join(this.sessionDir(sessionId), 'artifacts', `${name}.v${artifact.version}.json`),
      safeJson(artifact),
      0o644,
    )
  }

  async readArtifact(
    sessionId: string,
    kind: keyof typeof artifactNames,
    version: number,
  ): Promise<unknown> {
    const name = artifactNames[kind]
    if (!name || !Number.isInteger(version) || version < 1) return undefined
    try {
      const contents = await readFile(
        path.join(this.sessionDir(sessionId), 'artifacts', `${name}.v${version}.json`),
        'utf8',
      )
      return JSON.parse(contents)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async readLatestArtifact(
    sessionId: string,
    kind: keyof typeof artifactNames,
  ): Promise<unknown> {
    const name = artifactNames[kind]
    if (!name) return undefined
    const files = await readdir(path.join(this.sessionDir(sessionId), 'artifacts')).catch(() => [] as string[])
    const prefix = `${name}.v`
    const version = files.reduce((latest, file) => {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) return latest
      const parsed = Number.parseInt(file.slice(prefix.length, -'.json'.length), 10)
      return Number.isInteger(parsed) ? Math.max(latest, parsed) : latest
    }, 0)
    return version > 0 ? this.readArtifact(sessionId, kind, version) : undefined
  }

  async writeModelExchange(sessionId: string, request: unknown, response: unknown): Promise<string> {
    const index = (this.modelCounters.get(sessionId) ?? 0) + 1
    this.modelCounters.set(sessionId, index)
    const suffix = String(index).padStart(4, '0')
    const dir = path.join(this.sessionDir(sessionId), 'model')
    await Promise.all([
      atomicWrite(path.join(dir, `request-${suffix}.json`), safeJson(request), 0o600),
      atomicWrite(path.join(dir, `response-${suffix}.json`), safeJson(response), 0o600),
    ])
    return `model/response-${suffix}.json`
  }
}
