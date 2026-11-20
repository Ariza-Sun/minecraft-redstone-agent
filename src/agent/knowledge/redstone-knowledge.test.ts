import { describe, expect, it } from 'vitest'
import { REDSTONE_KNOWLEDGE_PROMPT, redstoneKnowledgeBase } from './redstone-knowledge'

describe('general redstone knowledge base', () => {
  it('loads a compact, versioned, cross-task first edition', () => {
    expect(redstoneKnowledgeBase).toMatchObject({
      schemaVersion: 'mc-ic.redstone-knowledge.v1',
      minecraftVersion: '1.20.4',
      scope: 'general_cross_task_knowledge',
    })
    expect(redstoneKnowledgeBase.blockPhysics).toHaveLength(8)
    expect(redstoneKnowledgeBase.circuitImplementations).toHaveLength(7)

    const cards = [...redstoneKnowledgeBase.blockPhysics, ...redstoneKnowledgeBase.circuitImplementations]
    const ids = cards.map((card) => card.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(cards.every((card) => card.minecraftVersion === '1.20.4')).toBe(true)
    expect(ids).toEqual(expect.arrayContaining([
      'physics.lever.attachment_and_input',
      'physics.redstone_wall_torch.attachment_and_inversion',
      'physics.redstone_torch.floor_attachment_and_inversion',
      'physics.redstone_wire.support_and_connectivity',
      'physics.redstone_lamp.power_reception',
      'physics.solid_block.power_conduction',
      'physics.repeater.direction_and_isolation',
      'physics.spatial.face_adjacency_and_occupancy',
      'implementation.not.direct_wall_torch',
      'implementation.and.de_morgan_three_inverters',
      'implementation.or.repeater_isolated_merge',
      'implementation.xor.shared_nor_and_final_inverter',
      'implementation.half_adder.shared_and_xor',
      'implementation.full_adder.two_half_adders',
      'implementation.composition.isolated_gate_lanes',
    ]))
  })

  it('contains no task-specific coordinates, artifact IDs, or validation history', () => {
    const serialized = JSON.stringify(redstoneKnowledgeBase)
    expect(serialized).not.toMatch(/session-/i)
    expect(serialized).not.toMatch(/taskSpecRef|logicDesignRef|layoutValidationHistory|previousLayoutRef/)
    expect(serialized).not.toMatch(/"workspace"|"port"|"implements"/)
    expect(serialized).not.toMatch(/\{\s*"x"\s*:\s*\d/)
  })

  it('renders one unchanged structured block for layout prompts', () => {
    expect(REDSTONE_KNOWLEDGE_PROMPT).toContain('This versioned knowledge is identical across tasks')
    expect(REDSTONE_KNOWLEDGE_PROMPT).toContain('<redstone_knowledge_json>')
    expect(REDSTONE_KNOWLEDGE_PROMPT).toContain('"scope":"general_cross_task_knowledge"')
    expect(REDSTONE_KNOWLEDGE_PROMPT).toContain('implementation.and.de_morgan_three_inverters')
    expect(REDSTONE_KNOWLEDGE_PROMPT).toContain('implementation.xor.shared_nor_and_final_inverter')
    expect(REDSTONE_KNOWLEDGE_PROMPT).toContain('implementation.full_adder.two_half_adders')
  })
})
