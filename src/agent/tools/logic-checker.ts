import type {
  Binary,
  LogicCheckIssue,
  LogicCheckResult,
  LogicDesign,
  LogicNodeKind,
  TaskSpec,
} from '@domain/domain'

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

function applyGate(kind: LogicNodeKind, inputs: Binary[]): Binary | undefined {
  if (kind === 'output' && inputs.length === 1) return inputs[0]
  if (kind === 'not' && inputs.length === 1) return inputs[0] === 1 ? 0 : 1
  if (inputs.length < 2) return undefined
  const all = inputs.every((value) => value === 1)
  const any = inputs.some((value) => value === 1)
  const parity = inputs.reduce<number>((sum, value) => sum + value, 0) % 2 === 1
  if (kind === 'and') return all ? 1 : 0
  if (kind === 'or') return any ? 1 : 0
  if (kind === 'xor') return parity ? 1 : 0
  if (kind === 'nand') return all ? 0 : 1
  if (kind === 'nor') return any ? 0 : 1
  if (kind === 'xnor') return parity ? 0 : 1
  return undefined
}

function sameKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

export class DeterministicLogicChecker {
  async check(task: TaskSpec, design: LogicDesign): Promise<LogicCheckResult> {
    const issues: LogicCheckIssue[] = []
    const nodes = new Map(design.nodes.map((node) => [node.id, node]))

    for (const id of duplicates(design.nodes.map((node) => node.id))) {
      issues.push({ code: 'DUPLICATE_NODE_ID', message: `Duplicate logic node id: ${id}`, nodeId: id })
    }
    for (const id of duplicates(design.edges.map((edge) => edge.id))) {
      issues.push({ code: 'DUPLICATE_EDGE_ID', message: `Duplicate logic edge id: ${id}` })
    }
    if (design.taskSpecRef.id !== task.id || design.taskSpecRef.version !== task.version) {
      issues.push({ code: 'STALE_TASK_REF', message: 'LogicDesign does not reference the active TaskSpec version' })
    }

    const incoming = new Map<string, string[]>()
    for (const edge of design.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
        issues.push({ code: 'DANGLING_EDGE', message: `Edge ${edge.id} references a missing node` })
        continue
      }
      incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from])
    }

    for (const input of task.inputs) {
      if (nodes.get(input.id)?.kind !== 'input') {
        issues.push({ code: 'MISSING_INPUT_NODE', message: `Task input ${input.id} needs a matching input node`, nodeId: input.id })
      }
    }
    const taskInputIds = new Set(task.inputs.map((input) => input.id))
    const taskOutputIds = new Set(task.outputs.map((output) => output.id))
    for (const node of design.nodes) {
      if (node.kind === 'input' && !taskInputIds.has(node.id)) {
        issues.push({ code: 'UNKNOWN_INPUT_NODE', message: `Input node ${node.id} is not declared by TaskSpec`, nodeId: node.id })
      }
      if (node.kind === 'output' && !taskOutputIds.has(node.id)) {
        issues.push({ code: 'UNKNOWN_OUTPUT_NODE', message: `Output node ${node.id} is not declared by TaskSpec`, nodeId: node.id })
      }
    }
    for (const output of task.outputs) {
      if (nodes.get(output.id)?.kind !== 'output') {
        issues.push({ code: 'MISSING_OUTPUT_NODE', message: `Task output ${output.id} needs a matching output node`, nodeId: output.id })
      }
      if (!design.equations[output.id]) {
        issues.push({ code: 'MISSING_OUTPUT_EQUATION', message: `Output ${output.id} has no human-readable equation`, nodeId: output.id })
      }
    }

    for (const node of design.nodes) {
      const count = incoming.get(node.id)?.length ?? 0
      if (node.kind === 'input' && count !== 0) {
        issues.push({ code: 'INPUT_HAS_DRIVER', message: `Input ${node.id} must not have incoming edges`, nodeId: node.id })
      } else if ((node.kind === 'not' || node.kind === 'output') && count !== 1) {
        issues.push({ code: 'INVALID_ARITY', message: `${node.kind} node ${node.id} requires exactly one input`, nodeId: node.id })
      } else if (!['input', 'not', 'output'].includes(node.kind) && count < 2) {
        issues.push({ code: 'INVALID_ARITY', message: `${node.kind} node ${node.id} requires at least two inputs`, nodeId: node.id })
      }
    }

    const inputIds = task.inputs.map((item) => item.id).sort()
    const outputIds = task.outputs.map((item) => item.id).sort()
    const truthRows = new Set<string>()
    task.truthTable.forEach((row, index) => {
      if (!sameKeys(row.inputs, inputIds)) {
        issues.push({ code: 'INVALID_TRUTH_INPUTS', message: `Truth-table row ${index} has incorrect input keys`, caseIndex: index })
      }
      if (!sameKeys(row.outputs, outputIds)) {
        issues.push({ code: 'INVALID_TRUTH_OUTPUTS', message: `Truth-table row ${index} has incorrect output keys`, caseIndex: index })
      }
      const key = inputIds.map((id) => `${id}=${row.inputs[id]}`).join(';')
      if (truthRows.has(key)) {
        issues.push({ code: 'DUPLICATE_TRUTH_ROW', message: `Truth-table row ${index} duplicates ${key}`, caseIndex: index })
      }
      truthRows.add(key)
    })
    if (task.truthTable.length !== 2 ** task.inputs.length) {
      issues.push({ code: 'INCOMPLETE_TRUTH_TABLE', message: `Expected ${2 ** task.inputs.length} rows for ${task.inputs.length} inputs` })
    }

    const evaluatedCases = task.truthTable.map((row, index) => {
      const values = new Map<string, Binary>()
      for (const input of task.inputs) values.set(input.id, row.inputs[input.id])
      const pending = new Set(design.nodes.filter((node) => node.kind !== 'input').map((node) => node.id))

      let progressed = true
      while (pending.size > 0 && progressed) {
        progressed = false
        for (const nodeId of [...pending]) {
          const node = nodes.get(nodeId)
          if (!node) continue
          const sources = incoming.get(nodeId) ?? []
          const inputs = sources.map((source) => values.get(source))
          if (inputs.some((value) => value === undefined)) continue
          const value = applyGate(node.kind, inputs as Binary[])
          if (value === undefined) continue
          values.set(nodeId, value)
          pending.delete(nodeId)
          progressed = true
        }
      }

      const actual: Record<string, Binary | 'unresolved'> = {}
      let passed = true
      for (const output of task.outputs) {
        actual[output.id] = values.get(output.id) ?? 'unresolved'
        if (actual[output.id] !== row.outputs[output.id]) passed = false
      }
      if (pending.size > 0) {
        issues.push({
          code: 'UNRESOLVED_GRAPH',
          message: `Case ${index} cannot resolve nodes: ${[...pending].join(', ')}`,
          caseIndex: index,
        })
      }
      if (!passed) {
        issues.push({ code: 'TRUTH_TABLE_MISMATCH', message: `Logic mismatch in truth-table row ${index}`, caseIndex: index })
      }
      return { index, expected: row.outputs, actual, passed }
    })

    return { passed: issues.length === 0 && evaluatedCases.every((item) => item.passed), issues, evaluatedCases }
  }
}
