import type { Bot } from 'mineflayer'
import prismarineBlock from 'prismarine-block'
import prismarineChunk from 'prismarine-chunk'
import { Vec3 } from 'vec3'

type ChunkColumn = {
  minY: number
  worldHeight: number
  sections: Array<{ solidBlockCount: number }>
  getBlockStateId(position: Vec3): number
  setBlockStateId(position: Vec3, stateId: number): number
  toJson(): string
}

type ChunkConstructor = {
  new(options: { minY: number; worldHeight: number }): ChunkColumn
  fromJson(json: string): ChunkColumn
}

type JsonChunkColumn = {
  sections: string[]
  [key: string]: unknown
}

type BlockLike = {
  stateId: number
  name: string
  getProperties(): Record<string, string | number | boolean>
}

export function createViewerStateTranslator(sourceVersion: string, renderVersion: string) {
  const SourceBlock = prismarineBlock(sourceVersion)
  const RenderBlock = prismarineBlock(renderVersion)
  const cache = new Map<number, number>()

  return (sourceStateId: number): number => {
    const cached = cache.get(sourceStateId)
    if (cached !== undefined) return cached
    const source = SourceBlock.fromStateId(sourceStateId, 0)
    const rendered = RenderBlock.fromProperties(
      source.name,
      source.getProperties() as Record<string, string | number>,
      0,
    )
    if (!rendered) {
      throw new Error(`Viewer ${renderVersion} cannot represent ${source.name} from Minecraft ${sourceVersion}`)
    }
    cache.set(sourceStateId, rendered.stateId)
    return rendered.stateId
  }
}

/**
 * Re-encode a live Minecraft chunk before prismarine-viewer serializes it.
 *
 * prismarine-chunk 1.41.0 drops every state from a direct-palette section in
 * its `fromJson` path. Modern server chunks commonly use that representation,
 * so the browser reconstructs a whole 16-block-high section as air. Building a
 * compact render-version chunk turns the small block vocabulary used by mc-ic
 * into an indirect palette, whose JSON round-trip is reliable.
 */
export function serializeViewerColumn(
  source: ChunkColumn,
  sourceVersion: string,
  renderVersion: string,
): string {
  const RenderChunk = prismarineChunk(renderVersion) as unknown as ChunkConstructor
  const rendered = new RenderChunk({ minY: source.minY, worldHeight: source.worldHeight })
  const translate = createViewerStateTranslator(sourceVersion, renderVersion)

  for (let sectionIndex = 0; sectionIndex < source.sections.length; sectionIndex += 1) {
    if (source.sections[sectionIndex].solidBlockCount === 0) continue
    const sectionY = source.minY + sectionIndex * 16
    for (let y = sectionY; y < sectionY + 16; y += 1) {
      for (let z = 0; z < 16; z += 1) {
        for (let x = 0; x < 16; x += 1) {
          const position = new Vec3(x, y, z)
          const sourceStateId = source.getBlockStateId(position)
          if (sourceStateId !== 0) rendered.setBlockStateId(position, translate(sourceStateId))
        }
      }
    }
  }

  const sourceJson = JSON.parse(source.toJson()) as JsonChunkColumn
  const renderedJson = JSON.parse(rendered.toJson()) as JsonChunkColumn
  // Keep source biomes, light arrays and block entities; only block-state
  // sections need the safe palette representation and state-id translation.
  sourceJson.sections = renderedJson.sections
  return JSON.stringify(sourceJson)
}

function translatedBlock(block: BlockLike, translate: (stateId: number) => number): BlockLike {
  return new Proxy(block, {
    get(target, property, receiver) {
      if (property === 'stateId') return translate(target.stateId)
      return Reflect.get(target, property, receiver)
    },
  })
}

/** Present a render-version-correct world and state stream to prismarine-viewer. */
export function createViewerBotBridge(bot: Bot, renderVersion: string, hiddenUsernames: string[] = []): Bot {
  const translate = createViewerStateTranslator(bot.version, renderVersion)
  const hidden = new Set([bot.username, ...hiddenUsernames])
  const isSystemEntity = (entity: { username?: string }) => entity.username !== undefined
    && (hidden.has(entity.username) || /^MICA_v_[a-f0-9]{8}$/.test(entity.username))
  type Listener = (...args: unknown[]) => unknown
  type UntypedEmitter = {
    on(event: string, listener: Listener): unknown
    removeListener(event: string, listener: Listener): unknown
  }
  const listenerWrappers = new WeakMap<Listener, Listener>()
  const viewerWorld = new Proxy(bot.world, {
    get(target, property) {
      if (property === 'getColumnAt') {
        return (position: Vec3) => {
          const column = target.getColumnAt(position) as unknown as ChunkColumn | undefined
          if (!column) return column
          return new Proxy(column, {
            get(columnTarget, columnProperty, receiver) {
              if (columnProperty === 'toJson') {
                return () => serializeViewerColumn(columnTarget, bot.version, renderVersion)
              }
              const value = Reflect.get(columnTarget, columnProperty, receiver)
              return typeof value === 'function' ? value.bind(columnTarget) : value
            },
          })
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return new Proxy(bot, {
    get(target, property) {
      if (property === 'version') return renderVersion
      if (property === 'world') return viewerWorld
      if (property === 'entities') {
        return Object.fromEntries(Object.entries(target.entities).filter(([, entity]) => !isSystemEntity(entity)))
      }
      if (property === 'on' || property === 'addListener') {
        return (event: string, listener: Listener) => {
          const emitter = target as unknown as UntypedEmitter
          if (['entitySpawn', 'entityMoved', 'entityGone'].includes(event)) {
            const wrapped: Listener = (...args) => {
              if (!isSystemEntity(args[0] as { username?: string })) return listener(...args)
            }
            listenerWrappers.set(listener, wrapped)
            return emitter.on(event, wrapped)
          }
          if (event !== 'blockUpdate') return emitter.on(event, listener)
          const wrapped: Listener = (oldBlock: unknown, newBlock: unknown) => (
            listener(oldBlock, translatedBlock(newBlock as BlockLike, translate))
          )
          listenerWrappers.set(listener, wrapped)
          return emitter.on(event, wrapped)
        }
      }
      if (property === 'off' || property === 'removeListener') {
        return (event: string, listener: Listener) => {
          const emitter = target as unknown as UntypedEmitter
          return emitter.removeListener(event, listenerWrappers.get(listener) ?? listener)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    },
  })
}
