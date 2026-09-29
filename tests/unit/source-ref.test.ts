import { describe, expect, it } from 'vitest'
import {
  SOURCE_REF_TYPES,
  checkSourceRefSemantics,
  isStructuredSourceRef,
  resolvableRefSchema,
  sourceRefKey,
  sourceRefSchema,
  type ResolvableRef,
} from '../../src/core/source-ref.ts'

describe('source_refs 统一结构（需求规格 §7.2 / §9.3）', () => {
  it('四种 type 与文档一致', () => {
    expect(SOURCE_REF_TYPES).toEqual(['seed', 'proposal', 'user_edit', 'blueprint_gate2'])
  })

  it('type=seed 指向 Seed item ID', () => {
    expect(sourceRefSchema.safeParse({ type: 'seed', ref_id: 'SEED_F001' }).success).toBe(true)
    expect(sourceRefSchema.safeParse({ type: 'seed', ref_id: 'SEED_A003' }).success).toBe(true)
    expect(sourceRefSchema.safeParse({ type: 'seed', ref_id: 'SEED_Q002' }).success).toBe(true)
    expect(sourceRefSchema.safeParse({ type: 'seed', ref_id: 'PROP_A.core_premise' }).success).toBe(false)
  })

  it('type=proposal 使用 <proposal_id>.<field_path>（需求规格 §9.3）', () => {
    expect(sourceRefSchema.safeParse({ type: 'proposal', ref_id: 'PROP_A.core_premise' }).success).toBe(true)
    expect(sourceRefSchema.safeParse({ type: 'proposal', ref_id: 'PROP_B.seed_fidelity.preserved' }).success).toBe(true)
    expect(sourceRefSchema.safeParse({ type: 'proposal', ref_id: 'PROP_A' }).success).toBe(false)
    expect(sourceRefSchema.safeParse({ type: 'proposal', ref_id: '随便写的' }).success).toBe(false)
  })

  it('type=user_edit / blueprint_gate2 只要求非空（深层可解析性受 OQ-10 阻塞）', () => {
    expect(sourceRefSchema.safeParse({ type: 'user_edit', ref_id: 'EDIT_001' }).success).toBe(true)
    expect(sourceRefSchema.safeParse({ type: 'blueprint_gate2', ref_id: 'GATE2_001' }).success).toBe(true)
    expect(sourceRefSchema.safeParse({ type: 'user_edit', ref_id: '' }).success).toBe(false)
  })

  it('拒绝文档未定义的 type 与多余字段', () => {
    expect(sourceRefSchema.safeParse({ type: 'scene', ref_id: 'scene-001' }).success).toBe(false)
    expect(sourceRefSchema.safeParse({ type: 'seed', ref_id: 'SEED_F001', note: 'x' }).success).toBe(false)
  })

  it('checkSourceRefSemantics 可单独断言', () => {
    expect(checkSourceRefSemantics({ type: 'seed', ref_id: 'SEED_F001' })).toHaveLength(0)
    expect(checkSourceRefSemantics({ type: 'seed', ref_id: '自由字符串' })).toHaveLength(1)
    expect(checkSourceRefSemantics({ type: 'proposal', ref_id: 'PROP_A' })).toHaveLength(1)
    expect(checkSourceRefSemantics({ type: 'user_edit', ref_id: 'EDIT_001' })).toHaveLength(0)
  })
})

describe('通用项 source_ref 的两种形态（OQ-03 裁决）', () => {
  it('接受结构化 {type, ref_id}', () => {
    expect(resolvableRefSchema.safeParse({ type: 'proposal', ref_id: 'PROP_A.core_premise' }).success).toBe(true)
  })

  it('接受稳定 ID 字符串', () => {
    expect(resolvableRefSchema.safeParse('SEED_F001').success).toBe(true)
    expect(resolvableRefSchema.safeParse('BP_STR_TURN').success).toBe(true)
  })

  it('拒绝无法解析的自由字符串（需求规格 §7.2）', () => {
    const result = resolvableRefSchema.safeParse('这是用户随口说的一句话')
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('不允许使用无法解析的自由字符串')
  })

  it('提供稳定的比较键与结构化判定', () => {
    const structured: ResolvableRef = { type: 'seed', ref_id: 'SEED_F001' }
    const plain: ResolvableRef = 'SEED_F001'
    expect(sourceRefKey(structured)).toBe('seed:SEED_F001')
    expect(sourceRefKey(plain)).toBe('id:SEED_F001')
    expect(isStructuredSourceRef(structured)).toBe(true)
    expect(isStructuredSourceRef(plain)).toBe(false)
  })
})
