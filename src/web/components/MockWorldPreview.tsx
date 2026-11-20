import { useMemo } from 'react'
import type { LayoutBlock, PhysicalLayout, Position } from '@domain/domain'

type Props = {
  layout?: PhysicalLayout
  placed: number
}

type Point = { x: number; y: number }

const VIEWBOX = { width: 720, height: 440 }
const TILE_WIDTH = 58
const TILE_DEPTH = 29
const BLOCK_HEIGHT = 31

const palette: Record<string, { top: string; left: string; right: string; accent: string; label: string }> = {
  stone: { top: '#789087', left: '#40554d', right: '#526960', accent: '#b4c5be', label: 'ST' },
  smooth_stone: { top: '#91a39d', left: '#53665f', right: '#687c74', accent: '#d6e0dc', label: 'ST' },
  lever: { top: '#bd8c4d', left: '#62472c', right: '#805d36', accent: '#ffd28e', label: 'A' },
  redstone_wall_torch: { top: '#e66b72', left: '#762e35', right: '#9d3f47', accent: '#ffd0d2', label: '¬' },
  redstone_torch: { top: '#e66b72', left: '#762e35', right: '#9d3f47', accent: '#ffd0d2', label: '¬' },
  redstone_wire: { top: '#c95058', left: '#64262c', right: '#84323a', accent: '#ffafb3', label: 'RW' },
  redstone_lamp: { top: '#e7ae4e', left: '#765121', right: '#9d702b', accent: '#fff0a9', label: 'Y' },
  repeater: { top: '#dedbd2', left: '#77716b', right: '#969089', accent: '#4c2025', label: 'RP' },
  comparator: { top: '#dedbd2', left: '#77716b', right: '#969089', accent: '#4c2025', label: 'CP' },
}

const fallbackPalette = { top: '#6a8e7e', left: '#354d43', right: '#476357', accent: '#dcebe4', label: 'BK' }

function shortName(block: string): string {
  return block.replace('minecraft:', '')
}

function points(...items: Point[]): string {
  return items.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
}

function projection(layout: PhysicalLayout) {
  const centerX = VIEWBOX.width / 2
  const centerY = 205
  return ({ x, y, z }: Position): Point => ({
    x: centerX + ((x - layout.bounds.x / 2) - (z - layout.bounds.z / 2)) * TILE_WIDTH / 2,
    y: centerY + ((x - layout.bounds.x / 2) + (z - layout.bounds.z / 2)) * TILE_DEPTH / 2 - y * BLOCK_HEIGHT,
  })
}

function GroundGrid({ layout }: { layout: PhysicalLayout }) {
  const project = projection(layout)
  const lines = []

  for (let x = 0; x <= layout.bounds.x; x += 1) {
    lines.push(<line key={`x-${x}`} x1={project({ x, y: 0, z: 0 }).x} y1={project({ x, y: 0, z: 0 }).y} x2={project({ x, y: 0, z: layout.bounds.z }).x} y2={project({ x, y: 0, z: layout.bounds.z }).y} />)
  }
  for (let z = 0; z <= layout.bounds.z; z += 1) {
    lines.push(<line key={`z-${z}`} x1={project({ x: 0, y: 0, z }).x} y1={project({ x: 0, y: 0, z }).y} x2={project({ x: layout.bounds.x, y: 0, z }).x} y2={project({ x: layout.bounds.x, y: 0, z }).y} />)
  }

  const corners = [
    project({ x: 0, y: 0, z: 0 }),
    project({ x: layout.bounds.x, y: 0, z: 0 }),
    project({ x: layout.bounds.x, y: 0, z: layout.bounds.z }),
    project({ x: 0, y: 0, z: layout.bounds.z }),
  ]

  return (
    <g className="mock-ground">
      <polygon points={points(...corners)} />
      {lines}
      <text x={corners[1].x + 12} y={corners[1].y + 3}>+X</text>
      <text x={corners[3].x - 28} y={corners[3].y + 3}>+Z</text>
    </g>
  )
}

function VoxelBlock({ block, layout, ghost }: { block: LayoutBlock; layout: PhysicalLayout; ghost?: boolean }) {
  const project = projection(layout)
  const { x, y, z } = block.position
  const bottom = [
    project({ x, y, z }),
    project({ x: x + 1, y, z }),
    project({ x: x + 1, y, z: z + 1 }),
    project({ x, y, z: z + 1 }),
  ]
  const top = [
    project({ x, y: y + 1, z }),
    project({ x: x + 1, y: y + 1, z }),
    project({ x: x + 1, y: y + 1, z: z + 1 }),
    project({ x, y: y + 1, z: z + 1 }),
  ]
  const name = shortName(block.block)
  const colors = palette[name] ?? fallbackPalette
  const topCenter = {
    x: top.reduce((sum, point) => sum + point.x, 0) / top.length,
    y: top.reduce((sum, point) => sum + point.y, 0) / top.length,
  }

  return (
    <g className={`mock-block ${ghost ? 'ghost' : ''} ${name}`}>
      <title>{`${block.id}\n${block.block}\n(${x}, ${y}, ${z})\n${block.implements.join(' · ')}`}</title>
      <polygon className="face left" points={points(top[3], top[2], bottom[2], bottom[3])} fill={colors.left} />
      <polygon className="face right" points={points(top[1], top[2], bottom[2], bottom[1])} fill={colors.right} />
      <polygon className="face top" points={points(...top)} fill={colors.top} />
      {!ghost && <text x={topCenter.x} y={topCenter.y + 4} fill={colors.accent}>{colors.label}</text>}
    </g>
  )
}

export function MockWorldPreview({ layout, placed }: Props) {
  const ordered = useMemo(() => {
    if (!layout) return []
    return [...layout.blocks].sort((left, right) => {
      const leftDepth = left.position.x + left.position.z
      const rightDepth = right.position.x + right.position.z
      return leftDepth - rightDepth || left.position.y - right.position.y || left.position.x - right.position.x
    })
  }, [layout])

  if (!layout) {
    return (
      <div className="mock-preview-empty">
        <div className="voxel"><i /><i /><i /></div>
        <strong>WAITING FOR LAYOUT</strong>
        <span>确认逻辑设计后，这里会显示方块搭建预览</span>
      </div>
    )
  }

  const placedIds = new Set(layout.blocks.slice(0, Math.max(0, Math.min(placed, layout.blocks.length))).map((block) => block.id))
  const solid = ordered.filter((block) => placedIds.has(block.id))
  const pending = ordered.filter((block) => !placedIds.has(block.id))

  return (
    <div className="mock-world-preview">
      <div className="mock-preview-label"><b>SIMULATED BUILD PREVIEW</b><span>来自 PhysicalLayout · 非 Minecraft 读回</span></div>
      <svg viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`} role="img" aria-label={`模拟方块搭建预览，已放置 ${solid.length}/${layout.blocks.length}`}>
        <defs>
          <filter id="mock-lamp-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <GroundGrid layout={layout} />
        {pending.map((block) => <VoxelBlock key={`ghost-${block.id}`} block={block} layout={layout} ghost />)}
        {solid.map((block) => <VoxelBlock key={block.id} block={block} layout={layout} />)}
      </svg>
      <div className="mock-preview-legend">
        <span><i className="stone" />结构</span>
        <span><i className="input" />输入</span>
        <span><i className="signal" />红石</span>
        <span><i className="output" />输出</span>
      </div>
    </div>
  )
}
