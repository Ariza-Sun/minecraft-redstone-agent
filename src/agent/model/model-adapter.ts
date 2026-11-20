import type {
  ArtifactBundle,
  AgentAction,
  LayoutValidationResult,
  LogicCheckResult,
  ModelMode,
  SessionState,
  WorldCaseState,
} from '@domain/domain'

export type ModelStage = 'task' | 'logic' | 'layout' | 'conversation'

export type ConversationTurn = {
  role: 'user' | 'assistant'
  content: string
}

export type ConversationFocus = {
  logicId?: string
  caseIndex?: number
}

export type ModelProgress =
  | {
      type: 'attempt.started'
      attempt: number
      maxAttempts: number
      model: string
    }
  | {
      type: 'output.received'
      attempt: number
      maxAttempts: number
      model: string
      rawResponseRef: string
      output: string
      truncated: boolean
      finishReason?: string
      elapsedMs: number
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    }
  | {
      type: 'output.rejected'
      attempt: number
      maxAttempts: number
      model: string
      category: 'transport' | 'upstream' | 'format' | 'schema' | 'action' | 'timeout'
      reason: string
      retrying: boolean
      rawResponseRef?: string
    }
  | {
      type: 'output.accepted'
      attempt: number
      maxAttempts: number
      model: string
      rawResponseRef: string
      actionType: AgentAction['type']
    }

export type ModelProgressReporter = (progress: ModelProgress) => void | Promise<void>

export type ModelContext = {
  sessionId: string
  requestedModel?: string
  stage: ModelStage
  sessionState: SessionState
  userRequest: string
  userMessage?: string
  artifacts: ArtifactBundle
  feedback?: unknown
  conversationHistory?: ConversationTurn[]
  focus?: ConversationFocus
  deterministicContext?: {
    logicCheck?: LogicCheckResult
    layoutValidation?: LayoutValidationResult
    displayedWorldCase?: WorldCaseState
  }
  provenance?: {
    mode: ModelMode
    model: string
  }
}

export type ModelCallResult = {
  requestedModel: string
  resolvedModel?: string
  action: AgentAction
  rawResponseRef: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  latencyMs: number
  formatErrors: string[]
  attempts: number
}

export interface ModelAdapter {
  readonly mode: ModelMode
  readonly model: string
  generate(context: ModelContext, onProgress?: ModelProgressReporter): Promise<ModelCallResult>
}

export class ModelAdapterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ModelAdapterError'
  }
}
