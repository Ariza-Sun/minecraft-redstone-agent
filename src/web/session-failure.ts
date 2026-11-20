import type { RunError } from '@domain/domain'

export function sessionFailure(error?: RunError): { message: string; helpUrl?: string; helpLabel?: string } | undefined {
  if (!error) return undefined
  const details = error.details as { status?: number; cause?: RunError } | undefined
  if (details?.cause) return sessionFailure(details.cause)
  if (details?.status === 402) return {
    message: 'OpenRouter 余额或 API Key 额度不足，无法支付本次模型请求。可检查余额与额度，或保留任务要求、选择免费模型创建新任务。',
    helpUrl: 'https://openrouter.ai/settings/credits',
    helpLabel: '查看 OpenRouter 余额',
  }
  if (details?.status === 403) return {
    message: 'OpenRouter 拒绝了本次请求（403），流水线已停止。请检查账户与模型供应商的使用限制；若认为是误判，请联系 OpenRouter 支持。',
    helpUrl: 'https://openrouter.ai/support',
    helpLabel: '联系 OpenRouter 支持',
  }
  return { message: error.message }
}
