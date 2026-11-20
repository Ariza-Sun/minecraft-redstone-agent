import { positionKey, type LogicDesign, type PhysicalLayout } from '@domain/domain'

export class DeterministicDiffEngine {
  logic(before: LogicDesign, after: LogicDesign) {
    const beforeNodes = new Set(before.nodes.map((node) => node.id))
    const afterNodes = new Set(after.nodes.map((node) => node.id))
    const beforeEdges = new Set(before.edges.map((edge) => edge.id))
    const afterEdges = new Set(after.edges.map((edge) => edge.id))
    return {
      nodesAdded: [...afterNodes].filter((id) => !beforeNodes.has(id)),
      nodesRemoved: [...beforeNodes].filter((id) => !afterNodes.has(id)),
      edgesAdded: [...afterEdges].filter((id) => !beforeEdges.has(id)),
      edgesRemoved: [...beforeEdges].filter((id) => !afterEdges.has(id)),
      equationsChanged: Object.keys({ ...before.equations, ...after.equations }).filter(
        (key) => before.equations[key] !== after.equations[key],
      ),
    }
  }

  layout(before: PhysicalLayout, after: PhysicalLayout) {
    const previous = new Map(before.blocks.map((block) => [positionKey(block.position), block]))
    const next = new Map(after.blocks.map((block) => [positionKey(block.position), block]))
    return {
      added: [...next.entries()].filter(([key]) => !previous.has(key)).map(([, block]) => block),
      removed: [...previous.entries()].filter(([key]) => !next.has(key)).map(([, block]) => block),
      changed: [...next.entries()]
        .filter(([key, block]) => previous.has(key) && JSON.stringify(previous.get(key)) !== JSON.stringify(block))
        .map(([, block]) => block),
    }
  }
}
