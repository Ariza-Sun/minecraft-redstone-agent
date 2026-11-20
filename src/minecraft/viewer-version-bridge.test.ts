import { EventEmitter } from 'node:events'
import type { Bot } from 'mineflayer'
import { describe, expect, it, vi } from 'vitest'
import prismarineBlock from 'prismarine-block'
import prismarineChunk from 'prismarine-chunk'
import { Vec3 } from 'vec3'
import { createViewerBotBridge, createViewerStateTranslator, serializeViewerColumn } from './viewer-version-bridge'

type TestChunk = {
  sections: Array<unknown>
  setBlockStateId(position: Vec3, stateId: number): number
  getBlockStateId(position: Vec3): number
  getBlock(position: Vec3): { name: string }
  toJson(): string
}

type TestChunkConstructor = {
  new(options: { minY: number; worldHeight: number }): TestChunk
  fromJson(json: string): TestChunk
}

describe('viewer version bridge', () => {
  it('hides system bots in initial entities and live updates while preserving players and the real world', () => {
    const builder = { id: 1, username: 'builder' }
    const observer = { id: 2, username: 'MICA_v_1234abcd' }
    const student = { id: 3, username: 'student' }
    const bot = Object.assign(new EventEmitter(), {
      version: '1.20.4', username: observer.username, world: {},
      entities: { 1: builder, 2: observer, 3: student },
    })
    const view = createViewerBotBridge(bot as unknown as Bot, '1.20.1', ['builder'])
    expect(Object.keys(view.entities)).toEqual(['3'])
    expect(Object.keys(bot.entities)).toEqual(['1', '2', '3'])
    for (const event of ['entitySpawn', 'entityMoved', 'entityGone'] as const) {
      const listener = vi.fn()
      view.on(event, listener)
      bot.emit(event, builder)
      bot.emit(event, observer)
      bot.emit(event, student)
      expect(listener.mock.calls).toEqual([[student]])
      view.removeListener(event, listener)
      expect(bot.listenerCount(event)).toBe(0)
    }
  })

  it('preserves a positive-Y direct-palette section across Viewer JSON transport', () => {
    const SourceChunk = prismarineChunk('1.20.4') as unknown as TestChunkConstructor
    const RenderChunk = prismarineChunk('1.20.1') as unknown as TestChunkConstructor
    const source = new SourceChunk({ minY: -64, worldHeight: 384 })
    source.setBlockStateId(new Vec3(3, 71, 2), 9)
    source.setBlockStateId(new Vec3(3, 72, 2), 1)

    // Match the global/direct palette representation received from the live
    // server. prismarine-chunk currently loses this section on fromJson().
    const section = source.sections[8] as unknown as {
      data: { convertToDirect(bits: number): unknown }
    }
    section.data = section.data.convertToDirect(15) as typeof section.data
    expect(SourceChunk.fromJson(source.toJson()).getBlockStateId(new Vec3(3, 71, 2))).toBe(0)

    const roundTripped = RenderChunk.fromJson(serializeViewerColumn(
      source as unknown as Parameters<typeof serializeViewerColumn>[0],
      '1.20.4',
      '1.20.1',
    ))
    expect(roundTripped.getBlock(new Vec3(3, 71, 2)).name).toBe('grass_block')
    expect(roundTripped.getBlock(new Vec3(3, 72, 2)).name).toBe('stone')
  })

  it('translates state ids by block name and properties between patch versions', () => {
    const SourceBlock = prismarineBlock('1.20.4')
    const RenderBlock = prismarineBlock('1.20.1')
    const source = SourceBlock.fromProperties('repeater', {
      powered: 'false',
      locked: 'false',
      facing: 'north',
      delay: 1,
    }, 0)
    const translated = createViewerStateTranslator('1.20.4', '1.20.1')(source.stateId)
    const rendered = RenderBlock.fromStateId(translated, 0)

    expect(rendered.name).toBe('repeater')
    expect(rendered.getProperties()).toEqual(source.getProperties())
    expect(translated).not.toBe(source.stateId)
  })
})
