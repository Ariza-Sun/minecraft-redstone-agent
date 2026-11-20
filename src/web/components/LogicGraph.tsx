import { useMemo } from 'react'
import type { LogicDesign } from '@domain/domain'

type Props = {
  design: LogicDesign
  selected?: string
  onSelect: (id: string) => void
}

const palette: Record<string, string> = {
  input: '#8a5515',
  output: '#19704b',
  not: '#6547a0',
  and: '#17678f',
  or: '#a43850',
  xor: '#745f08',
  nand: '#17678f',
  nor: '#a43850',
  xnor: '#745f08',
}

const nodeWidth = 150
const nodeHalfWidth = nodeWidth / 2

function wrapNodeLabel(label: string, maxCharacters = 20): string[] {
  const usesWordBoundaries = /\s/.test(label)
  const tokens = usesWordBoundaries ? label.trim().split(/\s+/) : Array.from(label)
  const separator = usesWordBoundaries ? ' ' : ''
  const lines: string[] = []
  let current = ''

  for (const token of tokens) {
    const candidate = current ? `${current}${separator}${token}` : token
    if (candidate.length <= maxCharacters || !current) {
      current = candidate
      continue
    }
    lines.push(current)
    current = token
  }
  if (current) lines.push(current)
  if (lines.length <= 2) return lines

  return [lines[0], `${lines.slice(1).join(separator).slice(0, maxCharacters - 1)}…`]
}

export function LogicGraph({ design, selected, onSelect }: Props) {
  const graph = useMemo(() => {
    const levels = new Map<string, number>()
    design.nodes.filter((node) => node.kind === 'input').forEach((node) => levels.set(node.id, 0))
    for (let pass = 0; pass < design.nodes.length; pass += 1) {
      for (const node of design.nodes) {
        if (node.kind === 'input') continue
        const parents = design.edges.filter((edge) => edge.to === node.id).map((edge) => levels.get(edge.from))
        if (parents.length > 0 && parents.every((level) => level !== undefined)) {
          levels.set(node.id, Math.max(...(parents as number[])) + 1)
        }
      }
    }
    design.nodes.forEach((node) => { if (!levels.has(node.id)) levels.set(node.id, 1) })
    const maxLevel = Math.max(1, ...levels.values())
    const groups = new Map<number, typeof design.nodes>()
    for (const node of design.nodes) groups.set(levels.get(node.id) ?? 0, [...(groups.get(levels.get(node.id) ?? 0) ?? []), node])
    const height = Math.max(250, Math.max(...[...groups.values()].map((nodes) => nodes.length)) * 92 + 70)
    const width = Math.max(780, maxLevel * 210 + 168)
    const positions = new Map<string, { x: number; y: number }>()
    for (const [level, nodes] of groups) {
      nodes.forEach((node, index) => positions.set(node.id, {
        x: 84 + (level / maxLevel) * (width - 168),
        y: ((index + 1) / (nodes.length + 1)) * height,
      }))
    }
    return { width, height, positions }
  }, [design])

  return (
    <div className="logic-canvas" role="img" aria-label="逻辑电路图">
      <svg viewBox={`0 0 ${graph.width} ${graph.height}`}>
        <defs>
          <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#52645b" />
          </marker>
        </defs>
        {design.edges.map((edge) => {
          const from = graph.positions.get(edge.from)
          const to = graph.positions.get(edge.to)
          if (!from || !to) return null
          const dx = Math.max(46, (to.x - from.x) * 0.48)
          const active = selected === edge.id || selected === edge.from || selected === edge.to
          return (
            <g key={edge.id} className={active ? 'graph-edge selected' : 'graph-edge'} onClick={() => onSelect(edge.id)}>
              <path d={`M ${from.x + nodeHalfWidth} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x - nodeHalfWidth} ${to.y}`} markerEnd="url(#arrow)" />
              <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 8}>{edge.signal}</text>
            </g>
          )
        })}
        {design.nodes.map((node) => {
          const point = graph.positions.get(node.id)
          if (!point) return null
          const active = selected === node.id
          const labelLines = wrapNodeLabel(node.label)
          return (
            <g
              key={node.id}
              className={active ? 'graph-node selected' : 'graph-node'}
              transform={`translate(${point.x - nodeHalfWidth}, ${point.y - 38})`}
              style={{ '--node-color': palette[node.kind] } as React.CSSProperties}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onSelect(node.id)
              }}
              role="button"
              tabIndex={0}
            >
              <title>{node.label}</title>
              <rect width={nodeWidth} height="76" rx="14" />
              <text className="node-kind" x={nodeHalfWidth} y="23">{node.kind.toUpperCase()}</text>
              <text className="node-label" x={nodeHalfWidth} y={labelLines.length > 1 ? 43 : 49}>
                {labelLines.map((line, index) => <tspan key={line} x={nodeHalfWidth} dy={index === 0 ? 0 : 14}>{line}</tspan>)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
