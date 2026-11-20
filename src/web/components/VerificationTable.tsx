import type { KeyboardEvent } from 'react'
import type { TaskSpec, VerificationReport, WorldCaseState } from '@domain/domain'

function values(record: Record<string, unknown>, order: string[]) {
  return order.map((id) => `${id}=${String(record[id])}`).join('  ')
}

type Props = {
  task: TaskSpec
  report?: VerificationReport
  selectedCase?: number
  applyingCase?: number
  worldCase?: WorldCaseState
  unavailableReason?: string
  onSelectCase?: (index: number) => void
}

export function VerificationTable({ task, report, selectedCase, applyingCase, worldCase, unavailableReason, onSelectCase }: Props) {
  const inputIds = task.inputs.map((input) => input.id)
  const outputIds = task.outputs.map((output) => output.id)
  if (!report) {
    return (
      <>
      {unavailableReason && <div className="case-control-note" role="status"><span>{unavailableReason}</span></div>}
      <div className="truth-preview">
        {task.truthTable.map((row, index) => (
          <div key={index}><span>{values(row.inputs, inputIds)}</span><i>→</i><strong>{values(row.outputs, outputIds)}</strong><em>待实测</em></div>
        ))}
      </div>
      </>
    )
  }
  return (
    <div className="verification-wrap">
      {!report.authoritative && <div className="evidence-warning">非权威演示数据：未连接真实 Minecraft，不可用于 benchmark 或成功声明。</div>}
      <div className="case-control-note">
        <span>点击用例，切换输入并查看电路状态。</span>
        {worldCase && <b>当前展示用例 {String(worldCase.index + 1).padStart(2, '0')} · {worldCase.passed ? '输出正确' : '输出不符'}</b>}
      </div>
      <table className="verification-table">
        <thead><tr><th>#</th><th>输入</th><th>期望</th><th>Minecraft 实际</th><th>证据</th><th>结论</th></tr></thead>
        <tbody>
          {report.cases.map((item) => {
            const active = selectedCase === item.index
            const applying = applyingCase === item.index
            const { actual, evidence, passed } = item
            const activate = () => { if (onSelectCase && applyingCase === undefined) onSelectCase(item.index) }
            const keyActivate = (event: KeyboardEvent<HTMLTableRowElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              activate()
            }
            return <tr
              key={item.index}
              className={`${passed ? 'pass' : 'fail'} ${onSelectCase ? 'interactive' : ''} ${active ? 'active-case' : ''} ${applying ? 'applying-case' : ''}`}
              onClick={activate}
              onKeyDown={keyActivate}
              tabIndex={onSelectCase ? 0 : undefined}
              role={onSelectCase ? 'button' : undefined}
              aria-label={onSelectCase ? `在 Minecraft 中展示用例 ${item.index + 1}` : undefined}
              aria-pressed={onSelectCase ? active : undefined}
            >
              <td>{String(item.index + 1).padStart(2, '0')}</td>
              <td>{values(item.inputs, inputIds)}</td>
              <td>{values(item.expected, outputIds)}</td>
              <td>{applying ? '切换中…' : values(actual, outputIds)}</td>
              <td>{evidence.length} 次读回</td>
              <td><span>{applying ? '切换中…' : passed ? '通过' : '未通过'}</span></td>
            </tr>
          })}
        </tbody>
      </table>
    </div>
  )
}
