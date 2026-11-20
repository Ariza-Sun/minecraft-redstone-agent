import { normalizeBlockName, positionKey, type TaskSpec } from '@domain/domain'

// Plain opaque blocks that can be powered and therefore host an inverter.
// Lamps, glass, pistons and redstone blocks are "solid" for support purposes
// but are useless or harmful as a torch attachment block.
const NEUTRAL_SOLID_BLOCKS = ['minecraft:stone', 'minecraft:smooth_stone', 'minecraft:polished_andesite', 'minecraft:iron_block']
const MIN_PORT_SEPARATION = 2
const MIN_WORKSPACE = { long: 5, short: 3, height: 3 }

export function taskSemanticIssues(task: TaskSpec): string[] {
  const issues: string[] = []
  if (task.workspace.origin.x !== 0 || task.workspace.origin.y !== 0 || task.workspace.origin.z !== 0) {
    issues.push('workspace.origin must be the relative origin {x:0,y:0,z:0}')
  }
  const inputIds = task.inputs.map((input) => input.id)
  const outputIds = task.outputs.map((output) => output.id)
  if (new Set(inputIds).size !== inputIds.length) issues.push('input IDs must be unique')
  if (new Set(outputIds).size !== outputIds.length) issues.push('output IDs must be unique')
  if (inputIds.some((id) => outputIds.includes(id))) issues.push('input and output IDs must not overlap')
  if (task.truthTable.length !== 2 ** task.inputs.length) {
    issues.push(`truthTable needs ${2 ** task.inputs.length} rows for ${task.inputs.length} inputs`)
  }
  const positionInside = ({ x, y, z }: { x: number; y: number; z: number }) =>
    x >= 0 && y >= 0 && z >= 0 && x < task.workspace.size.x && y < task.workspace.size.y && z < task.workspace.size.z
  for (const item of [...task.inputs, ...task.outputs]) {
    if (!positionInside(item.port.position)) issues.push(`port ${item.id} lies outside the workspace`)
  }

  const { size } = task.workspace
  if (size.y < MIN_WORKSPACE.height || Math.max(size.x, size.z) < MIN_WORKSPACE.long || Math.min(size.x, size.z) < MIN_WORKSPACE.short) {
    issues.push(`workspace.size ${size.x}x${size.y}x${size.z} is too small to place supports, inverters and routing; use at least ${MIN_WORKSPACE.long} blocks along one horizontal axis, ${MIN_WORKSPACE.short} along the other and ${MIN_WORKSPACE.height} layers (7x4x5 recommended for one gate, 7x4x7 for two inputs)`)
  }

  const allowed = new Set(task.allowedBlocks.map(normalizeBlockName))
  if (!NEUTRAL_SOLID_BLOCKS.some((name) => allowed.has(name))) {
    issues.push(`allowedBlocks must include at least one plain opaque solid block (${NEUTRAL_SOLID_BLOCKS.join(', ')}) to serve as lever and torch attachment blocks`)
  }

  const ports = [...task.inputs, ...task.outputs]
  for (let left = 0; left < ports.length; left += 1) {
    for (let right = left + 1; right < ports.length; right += 1) {
      const a = ports[left]
      const b = ports[right]
      if (positionKey(a.port.position) === positionKey(b.port.position)) {
        issues.push(`ports ${a.id} and ${b.id} share the coordinate ${positionKey(a.port.position)}`)
      }
    }
  }
  for (const input of task.inputs) {
    for (const output of task.outputs) {
      const horizontal = Math.abs(input.port.position.x - output.port.position.x) + Math.abs(input.port.position.z - output.port.position.z)
      if (horizontal < MIN_PORT_SEPARATION) {
        issues.push(`input ${input.id} at ${positionKey(input.port.position)} and output ${output.id} at ${positionKey(output.port.position)} are only ${horizontal} block(s) apart horizontally; a lever or its attachment block next to the lamp powers it directly, so keep them at least ${MIN_PORT_SEPARATION} (preferably 3) apart`)
      }
    }
  }
  return issues
}
