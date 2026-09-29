import { describe, expect, it } from 'vitest'
import { checkStatusItemSemantics, parseStatusItem, statusItemSchema, type StatusItem } from '../../src/core/item.ts'
import { ORIGINS, SOURCES, STATUS } from '../../src/core/status.ts'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'

function baseProposedItem(): Record<string, unknown> {
  return {
    id: 'ITEM_001',
    value: '男方其实记得纪念日',
    status: 'PROPOSED',
    source: 'harness',
  }
}

describe('四状态枚举（需求规格 §6.1 / §33 冻结）', () => {
  it('恰好四种状态，顺序与文档一致', () => {
    expect(STATUS).toEqual(['USER_GIVEN', 'PROPOSED', 'CONFIRMED', 'OCCURRED'])
  })

  it('source 枚举收编了文档自身使用的 interpreter / scene_breakdown（OQ-02 裁决）', () => {
    expect(SOURCES).toEqual([
      'user',
      'user_gate1',
      'interpreter',
      'harness',
      'blueprint',
      'scene_breakdown',
      'final_text',
    ])
  })

  it('origin 恰好两种取值（需求规格 §7.1）', () => {
    expect(ORIGINS).toEqual(['raw_seed', 'gate1_confirmation'])
  })
})

describe('通用状态数据结构（需求规格 §7 / Story 1 功能第 2 条）', () => {
  it('接受一个合法的 PROPOSED 项', () => {
    const parsed = statusItemSchema.parse(baseProposedItem())
    expect(parsed.status).toBe('PROPOSED')
    expect(parsed.source).toBe('harness')
  })

  it('接受 USER_GIVEN + source=user + origin=raw_seed（原始 Seed 锚点）', () => {
    const parsed = statusItemSchema.parse({
      id: 'SEED_F001',
      value: '妻子已经死亡',
      status: 'USER_GIVEN',
      source: 'user',
      origin: 'raw_seed',
    })
    expect(parsed.origin).toBe('raw_seed')
  })

  it('接受 USER_GIVEN + source=user_gate1 + origin=gate1_confirmation（Gate 1 提升）', () => {
    const parsed = statusItemSchema.parse({
      id: 'SEED_F002',
      value: '真相何时揭晓',
      status: 'USER_GIVEN',
      source: 'user_gate1',
      origin: 'gate1_confirmation',
    })
    expect(parsed.origin).toBe('gate1_confirmation')
  })

  it('拒绝非 USER_GIVEN 携带 origin（需求规格 §7.1；OQ-24 严格解读）', () => {
    const result = statusItemSchema.safeParse({ ...baseProposedItem(), origin: 'raw_seed' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('origin 仅对 USER_GIVEN 有意义')
  })

  it('拒绝 USER_GIVEN 缺失 origin', () => {
    const result = statusItemSchema.safeParse({
      id: 'SEED_F001',
      value: '妻子已经死亡',
      status: 'USER_GIVEN',
      source: 'user',
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('必须记录 origin=raw_seed')
  })

  it('拒绝 source / origin 不配对的组合', () => {
    const result = statusItemSchema.safeParse({
      id: 'SEED_F001',
      value: '妻子已经死亡',
      status: 'USER_GIVEN',
      source: 'user',
      origin: 'gate1_confirmation',
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('必须搭配 origin=raw_seed')
  })

  it('拒绝 USER_GIVEN 使用 harness 之类的来源（不得伪装）', () => {
    const result = statusItemSchema.safeParse({
      id: 'ITEM_002',
      value: '忘记纪念日',
      status: 'USER_GIVEN',
      source: 'harness',
      origin: 'raw_seed',
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('只能是 user / user_gate1')
  })

  it('拒绝文档未定义的字段（不发明平行结构）', () => {
    const result = statusItemSchema.safeParse({ ...baseProposedItem(), confidence: 0.8 })
    expect(result.success).toBe(false)
  })

  it('checkStatusItemSemantics 是可直接断言的纯函数', () => {
    expect(
      checkStatusItemSemantics({ status: 'PROPOSED', source: 'harness', origin: null }).map((issue) => issue.path),
    ).toEqual([])
    expect(checkStatusItemSemantics({ status: 'PROPOSED', source: 'harness', origin: 'raw_seed' })).toHaveLength(1)
    expect(checkStatusItemSemantics({ status: 'USER_GIVEN', source: 'user', origin: undefined })).toHaveLength(1)
    expect(checkStatusItemSemantics({ status: 'USER_GIVEN', source: 'user', origin: 'raw_seed' })).toHaveLength(0)
  })
})

describe('状态 / source 可序列化（Story 1 验收 4）', () => {
  it('YAML 往返后逐字段一致', () => {
    const item = statusItemSchema.parse({
      id: 'SEED_F001',
      value: '妻子已经死亡',
      status: 'USER_GIVEN',
      source: 'user',
      origin: 'raw_seed',
      source_ref: { type: 'seed', ref_id: 'SEED_F001' },
    })
    const text = dumpYaml(item)
    const reloaded = statusItemSchema.parse(loadYaml(text))
    expect(reloaded).toEqual(item)
    expect(text).toContain('origin: raw_seed')
  })

  it('解析结果被深度冻结，无法被顺手改写', () => {
    const item: StatusItem = parseStatusItem(baseProposedItem())
    expect(Object.isFrozen(item)).toBe(true)
    expect(() => {
      ;(item as { status: string }).status = 'CONFIRMED'
    }).toThrow(TypeError)
  })
})
