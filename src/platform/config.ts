import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import type { Position, RunPolicy } from '@domain/domain'
import { loadBasicAuth, type BasicAuthConfig } from './basic-auth'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
export const projectRoot = path.resolve(moduleDir, '../..')

// Secrets and local settings live in .env.local, which is gitignored.
dotenv.config({ path: path.join(projectRoot, '.env.local') })

function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10)
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer`)
  return value
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  return /^(1|true|yes)$/i.test(value)
}

function oneOf<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = process.env[name] ?? fallback
  if (!values.includes(value as T)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

export type AppConfig = {
  apiPort: number
  webOrigin: string
  runsDir: string
  modelMode: 'openrouter' | 'fixture'
  auth?: BasicAuthConfig
  runPolicy: RunPolicy
  openRouter: {
    apiKey?: string
    model: string
    baseUrl: string
    timeoutMs: number
    maxAttempts: number
    retryBaseMs: number
    maxOutputTokens: number
  }
  minecraft: {
    mode: 'live' | 'mock'
    host: string
    port: number
    username: string
    origin: Position
    commandDelayMs: number
    settleMs: number
    viewerEnabled: boolean
    viewerPort: number
    viewerPublicUrl: string
  }
}

export function loadConfig(): AppConfig {
  const viewerPort = integer('MC_VIEWER_PORT', 3007)
  return {
    apiPort: integer('API_PORT', 8787),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    runsDir: path.resolve(projectRoot, process.env.RUNS_DIR ?? 'runs'),
    modelMode: oneOf('MODEL_MODE', ['openrouter', 'fixture'] as const, 'openrouter'),
    auth: loadBasicAuth(),
    runPolicy: {
      maxTaskVersions: integer('RUN_MAX_TASK_VERSIONS', 2),
      maxLogicVersions: integer('RUN_MAX_LOGIC_VERSIONS', 3),
      maxLayoutVersions: integer('RUN_MAX_LAYOUT_VERSIONS', 5),
      simulateLayouts: boolean('RUN_LAYOUT_SIMULATION', true),
    },
    openRouter: {
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-3.5-lightning:free',
      baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      timeoutMs: integer('MODEL_TIMEOUT_MS', 900_000),
      maxAttempts: integer('MODEL_MAX_ATTEMPTS', 3),
      retryBaseMs: integer('MODEL_RETRY_BASE_MS', 8_000),
      // Global safety ceiling. Individual stages/models still apply tighter
      // limits.
      maxOutputTokens: integer('MODEL_MAX_OUTPUT_TOKENS', 128_000),
    },
    minecraft: {
      mode: oneOf('MINECRAFT_MODE', ['live', 'mock'] as const, 'live'),
      host: process.env.MC_HOST ?? 'localhost',
      port: integer('MC_PORT', 25565),
      username: process.env.MC_USER ?? 'RedstoneBot',
      origin: {
        x: integer('MC_ORIGIN_X', 0),
        y: integer('MC_ORIGIN_Y', 72),
        z: integer('MC_ORIGIN_Z', 0),
      },
      commandDelayMs: integer('MC_COMMAND_DELAY_MS', 90),
      settleMs: integer('MC_SETTLE_MS', 650),
      viewerEnabled: boolean('MC_VIEWER_ENABLED', true),
      viewerPort,
      viewerPublicUrl: process.env.MC_VIEWER_PUBLIC_URL ?? '/minecraft-viewer/',
    },
  }
}
