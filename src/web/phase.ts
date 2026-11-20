import type { ArtifactBundle, RunError, SessionState } from '@domain/domain'

const layoutFailures = [
  'LAYOUT_VALIDATION_FAILED', 'LAYOUT_PIPELINE_FAILED',
  'LAYOUT_RETRY_PIPELINE_FAILED', 'LAYOUT_RESTART_PIPELINE_FAILED',
  'MODEL_HTTP_ERROR', 'MODEL_FORMAT_INVALID', 'MODEL_RESPONSE_INVALID', 'MODEL_REQUEST_FAILED',
]

export function canRestartLayout(
  state: SessionState,
  error: RunError | undefined,
  artifacts: ArtifactBundle,
  logicCheckPassed: boolean,
): boolean {
  return state === 'FAILED'
    && layoutFailures.includes(error?.code ?? '')
    && Boolean(artifacts.task && artifacts.logicDesign && logicCheckPassed)
    && !artifacts.buildRun && !artifacts.verificationReport
}

export function canReviseLayout(
  state: SessionState,
  artifacts: ArtifactBundle,
  error?: RunError,
  logicCheckPassed = false,
): boolean {
  return Boolean(artifacts.task && artifacts.logicDesign && logicCheckPassed)
    && !artifacts.buildRun && !artifacts.verificationReport
    && (state === 'READY_TO_BUILD' || canRestartLayout(state, error, artifacts, logicCheckPassed))
}

export function phaseIndex(state: SessionState, artifacts: ArtifactBundle, error?: RunError): number {
  if (['CREATED', 'COLLECTING_REQUIREMENTS'].includes(state)) return 0
  if (state === 'REVISING') return artifacts.physicalLayout ? 2 : 1
  if (['DESIGNING_LOGIC', 'CHECKING_LOGIC', 'AWAITING_DESIGN_REVIEW'].includes(state)) return 1
  if (['PLANNING_LAYOUT', 'VALIDATING_LAYOUT', 'READY_TO_BUILD'].includes(state)) return 2
  if (state === 'FAILED' && !artifacts.buildRun) {
    if (!artifacts.task) return 0
    if (!artifacts.logicDesign) return 1
    if (layoutFailures.includes(error?.code ?? '')) return 2
  }
  if (state === 'BUILDING' || (state === 'FAILED' && error?.code === 'BUILD_FAILED')) return 3
  // Legacy post-verification states stay readable, but cannot resume design.
  if (['VERIFYING', 'INSPECTING_WORLD', 'AWAITING_LAYOUT_REPAIR', 'SUCCEEDED', 'COMPLETED_NON_AUTHORITATIVE'].includes(state)) return 4
  if (state === 'FAILED' && artifacts.verificationReport) return 4
  return -1
}
