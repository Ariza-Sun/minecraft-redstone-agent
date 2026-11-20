import { useEffect, useMemo, useState } from 'react'
import type { LayoutBlock, PhysicalLayout } from '@domain/domain'

type Props = {
  layout: PhysicalLayout
  selected?: string
  onSelect: (logicId: string) => void
}

const labels: Record<string, string> = {
  stone: 'ST',
  smooth_stone: 'ST',
  lever: 'LV',
  redstone_wall_torch: 'RT',
  redstone_torch: 'RT',
  redstone_wire: 'RW',
  redstone_lamp: 'LP',
  repeater: 'RP',
  comparator: 'CP',
  piston: 'PI',
  sticky_piston: 'SP',
}

function shortName(block: string) {
  return block.replace('minecraft:', '')
}

function BlockInspector({ block }: { block?: LayoutBlock }) {
  if (!block) return <div className="block-inspector empty">选择一个方块查看映射</div>
  return (
    <div className="block-inspector">
      <span className={`block-swatch ${shortName(block.block)}`} />
      <div>
        <strong>{shortName(block.block)}</strong>
        <span>#{block.id} · ({block.position.x}, {block.position.y}, {block.position.z})</span>
        <span>映射：{block.implements.join(' · ')}</span>
        {Object.keys(block.properties).length > 0 && <span>{JSON.stringify(block.properties)}</span>}
      </div>
    </div>
  )
}

export function LayoutLayers({ layout, selected, onSelect }: Props) {
  const layers = useMemo(() => [...new Set(layout.blocks.map((block) => block.position.y))].sort((a, b) => b - a), [layout])
  const [activeLayer, setActiveLayer] = useState(layers[0] ?? 0)
  const [inspected, setInspected] = useState<LayoutBlock>()
  useEffect(() => { if (!layers.includes(activeLayer)) setActiveLayer(layers[0] ?? 0) }, [layers, activeLayer])
  const blocks = layout.blocks.filter((block) => block.position.y === activeLayer)
  const grid = new Map(blocks.map((block) => [`${block.position.x},${block.position.z}`, block]))
  const columns = Math.max(1, layout.bounds.x)

  return (
    <div className="layout-view">
      <div className="layer-tabs">
        {layers.map((layer) => (
          <button key={layer} className={layer === activeLayer ? 'active' : ''} onClick={() => setActiveLayer(layer)}>Y {layer}</button>
        ))}
      </div>
      <div className="layout-grid-wrap">
        <div
          className="layout-grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(25px, 1fr))`,
            aspectRatio: `${layout.bounds.x} / ${layout.bounds.z}`,
          }}
        >
          {Array.from({ length: layout.bounds.x * layout.bounds.z }, (_, index) => {
            const x = index % layout.bounds.x
            const z = Math.floor(index / layout.bounds.x)
            const block = grid.get(`${x},${z}`)
            const name = block ? shortName(block.block) : ''
            const highlighted = Boolean(block && selected && block.implements.includes(selected))
            return (
              <button
                key={`${x},${z}`}
                className={`layout-cell ${block ? `occupied ${name}` : ''} ${highlighted ? 'highlighted' : ''}`}
                title={block ? `${block.id}\n${block.block}\n${block.implements.join(', ')}` : `(${x}, ${activeLayer}, ${z})`}
                onClick={() => {
                  if (!block) return
                  setInspected(block)
                  onSelect(block.implements[0])
                }}
              >
                {block ? <><b>{labels[name] ?? name.slice(0, 2).toUpperCase()}</b><small>{x},{z}</small></> : <small>{x},{z}</small>}
              </button>
            )
          })}
        </div>
      </div>
      <BlockInspector block={inspected ?? blocks.find((block) => selected && block.implements.includes(selected))} />
    </div>
  )
}
