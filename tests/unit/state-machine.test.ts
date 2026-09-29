import { describe, expect, it } from 'vitest'
import { parseStatusItem, type StatusItem } from '../../src/core/item.ts'
import { STATUS, type Status } from '../../src/core/status.ts'
import {
  ALLOWED_TRANSITIONS,
  FORBIDDEN_TRANSITIONS,
  IllegalTransitionError,
  SOURCE_AFTER_TRANSITION,
  TRANSITION_TRIGGERS,
  USAGE_TRIGGERS,
  evaluateTransition,
  isUsageTrigger,
  recordUsage,
  transitionStatus,
  type ForbiddenUsageRule,
  type TransitionTrigger,
} from '../../src/core/state-machine.ts'

/**
 * 状态机表驱动测试（Story 1 验收 6 + 验收增强第 2 条）。
 * 架构设计 §7「禁止流转」6 条 → F1–F6；Story 1 附加守卫 G1（OQ-22）。
 */

function makeItem(status: Status): StatusItem {
  const common = { id: 'ITEM_001', value: '待裁决的内容' }
  if (status === 'USER_GIVEN') {
    return parseStatusItem({ ...common, status, source: 'user', origin: 'raw_seed' })
  }
  if (status === 'PROPOSED') {
    return parseStatusItem({ ...common, status, source: 'harness' })
  }
  if (status === 'CONFIRMED') {
    return parseStatusItem({ ...common, status, source: 'blueprint' })
  }
  return parseStatusItem({ ...common, status, source: 'final_text' })
}

describe('规则表与文档 1:1 对应', () => {
  it('禁止流转表恰好 7 条：F1–F6 + G1', () => {
    expect(FORBIDDEN_TRANSITIONS.map((rule) => rule.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'G1'])
  })

  it('F1–F6 与《架构设计》§7 的 6 条禁止流转逐条对应', () => {
    const f1 = FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F1')
    expect(f1).toMatchObject({ kind: 'status-pair', from: 'PROPOSED', to: 'CONFIRMED', unlessTrigger: 'GATE2_CONFIRM' })
    expect(FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F2')).toMatchObject({ from: 'PROPOSED', to: 'OCCURRED' })
    expect(FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F6')).toMatchObject({ from: 'OCCURRED', to: 'CONFIRMED' })
    expect((FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F3') as ForbiddenUsageRule).trigger).toBe(
      'SCENE_BREAKDOWN_REFERENCE',
    )
    expect((FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F4') as ForbiddenUsageRule).trigger).toBe('WRITER_REFERENCE')
    expect((FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F5') as ForbiddenUsageRule).trigger).toBe('DRAFT_CONTAINS')
  })

  it('G1 为非文档明文守卫，从原则 2 推导（OQ-22）', () => {
    const g1 = FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'G1')
    expect(g1).toMatchObject({ kind: 'status-pair', from: 'PROPOSED', to: 'USER_GIVEN', unlessTrigger: null })
    expect(g1?.docRef).toContain('原则 2')
  })

  it('每条规则都引用了文档出处', () => {
    for (const rule of FORBIDDEN_TRANSITIONS) {
      expect(rule.docRef.length).toBeGreaterThan(0)
      expect(rule.description.length).toBeGreaterThan(0)
    }
    for (const rule of ALLOWED_TRANSITIONS) {
      expect(rule.docRef.length).toBeGreaterThan(0)
    }
  })

  it('触发器命名与 D8 裁决一致，且"使用"类触发器被正确识别', () => {
    expect(TRANSITION_TRIGGERS).toEqual([
      'GATE2_CONFIRM',
      'GATE3_CONFIRM',
      'SCENE_BREAKDOWN_REFERENCE',
      'WRITER_REFERENCE',
      'DRAFT_CONTAINS',
      'STATE_EXTRACTOR',
    ])
    expect(USAGE_TRIGGERS).toEqual(['SCENE_BREAKDOWN_REFERENCE', 'WRITER_REFERENCE', 'DRAFT_CONTAINS'])
    expect(isUsageTrigger('DRAFT_CONTAINS')).toBe(true)
    expect(isUsageTrigger('GATE2_CONFIRM')).toBe(false)
  })
})

describe('表驱动：每条禁止流转都必须被拦截', () => {
  const statusPairRuleIds = ['F1', 'F2', 'F6', 'G1'] as const

  for (const rule of FORBIDDEN_TRANSITIONS) {
    if (rule.kind === 'status-pair') {
      it(`${rule.id} 拦截 ${rule.description}`, () => {
        // 选择一个不构成豁免的触发器：F1 的豁免是 GATE2_CONFIRM，其余规则无豁免，
        // 因此统一使用 STATE_EXTRACTOR（终稿事实提取，不构成任何"自动升级"路径）
        const trigger: TransitionTrigger = 'STATE_EXTRACTOR'
        const decision = evaluateTransition({ from: rule.from, to: rule.to, trigger })
        expect(decision.ok).toBe(false)
        if (!decision.ok) {
          expect(decision.ruleId).toBe(rule.id)
          expect(decision.docRef).toBe(rule.docRef)
        }
      })

      it(`${rule.id} 通过 transitionStatus 抛 IllegalTransitionError`, () => {
        const item = makeItem(rule.from)
        let caught: unknown
        try {
          transitionStatus(item, rule.to, { trigger: 'STATE_EXTRACTOR' })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(IllegalTransitionError)
        expect((caught as IllegalTransitionError).ruleId).toBe(rule.id)
        expect(item.status).toBe(rule.from)
      })
    } else {
      it(`${rule.id} 拦截「${rule.description}」：使用事件不能触发迁移`, () => {
        const decision = evaluateTransition({ from: 'PROPOSED', to: 'CONFIRMED', trigger: rule.trigger })
        expect(decision.ok).toBe(false)
        if (!decision.ok) expect(decision.ruleId).toBe(rule.id)
      })

      it(`${rule.id} 对应的"使用"不会改变状态（recordUsage 返回同一引用）`, () => {
        for (const status of STATUS) {
          const item = makeItem(status)
          const after = recordUsage(item, rule.trigger)
          expect(after).toBe(item)
          expect(after.status).toBe(item.status)
        }
      })
    }
  }

  it('status-pair 规则集合与内联断言一致', () => {
    expect(
      FORBIDDEN_TRANSITIONS.filter((rule) => rule.kind === 'status-pair').map((rule) => rule.id),
    ).toEqual([...statusPairRuleIds])
  })
})

describe('合法流转（架构设计 §7 / 需求规格 §5.2、§6.5）', () => {
  it('A1：USER_GIVEN 保持 USER_GIVEN', () => {
    const decision = evaluateTransition({ from: 'USER_GIVEN', to: 'USER_GIVEN', trigger: 'STATE_EXTRACTOR' })
    expect(decision).toMatchObject({ ok: true, ruleId: 'A1' })
    const item = makeItem('USER_GIVEN')
    expect(transitionStatus(item, 'USER_GIVEN', { trigger: 'STATE_EXTRACTOR' })).toBe(item)
  })

  it('A2：PROPOSED + GATE2_CONFIRM → CONFIRMED，且 source 变为 blueprint（需求规格 §7 枚举）', () => {
    const decision = evaluateTransition({ from: 'PROPOSED', to: 'CONFIRMED', trigger: 'GATE2_CONFIRM' })
    expect(decision).toMatchObject({ ok: true, ruleId: 'A2' })
    const next = transitionStatus(makeItem('PROPOSED'), 'CONFIRMED', { trigger: 'GATE2_CONFIRM' })
    expect(next.status).toBe('CONFIRMED')
    expect(next.source).toBe(SOURCE_AFTER_TRANSITION.A2)
    expect(next.source).toBe('blueprint')
    expect(next.origin).toBeUndefined()
  })

  it('A3：CONFIRMED + GATE3_CONFIRM → OCCURRED，且 source 变为 final_text', () => {
    const decision = evaluateTransition({ from: 'CONFIRMED', to: 'OCCURRED', trigger: 'GATE3_CONFIRM' })
    expect(decision).toMatchObject({ ok: true, ruleId: 'A3' })
    const next = transitionStatus(makeItem('CONFIRMED'), 'OCCURRED', { trigger: 'GATE3_CONFIRM' })
    expect(next.status).toBe('OCCURRED')
    expect(next.source).toBe('final_text')
  })

  it('CONFIRMED → OCCURRED 缺少 Gate 3 证据时被拒绝（U1）', () => {
    const decision = evaluateTransition({ from: 'CONFIRMED', to: 'OCCURRED', trigger: 'STATE_EXTRACTOR' })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.ruleId).toBe('U1')
      expect(decision.reason).toContain('GATE3_CONFIRM')
    }
  })
})

describe('穷举 4×4 状态矩阵：除允许集外一律拒绝', () => {
  const allowedByGate2 = new Set(['A1', 'A2', 'NOOP'])

  for (const from of STATUS) {
    for (const to of STATUS) {
      it(`${from} → ${to}（触发器 GATE2_CONFIRM）`, () => {
        const decision = evaluateTransition({ from, to, trigger: 'GATE2_CONFIRM' })
        const same = from === to
        if (from === 'USER_GIVEN' && to === 'USER_GIVEN') {
          expect(decision).toMatchObject({ ok: true, ruleId: 'A1' })
          return
        }
        if (from === 'PROPOSED' && to === 'CONFIRMED') {
          expect(decision).toMatchObject({ ok: true, ruleId: 'A2' })
          return
        }
        if (same) {
          expect(decision).toMatchObject({ ok: true, ruleId: 'NOOP' })
          return
        }
        expect(decision.ok, `${from} → ${to} 不应被允许`).toBe(false)
        if (!decision.ok) {
          expect(allowedByGate2.has(decision.ruleId)).toBe(false)
          expect(['F1', 'F2', 'F6', 'G1', 'U1']).toContain(decision.ruleId)
        }
      })
    }
  }

  it('任何触发器组合下，只有 A1/A2/A3/NOOP 会返回 ok', () => {
    for (const from of STATUS) {
      for (const to of STATUS) {
        for (const trigger of TRANSITION_TRIGGERS) {
          const decision = evaluateTransition({ from, to, trigger })
          if (decision.ok) {
            expect(['A1', 'A2', 'A3', 'NOOP']).toContain(decision.ruleId)
          } else {
            expect(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'G1', 'U1']).toContain(decision.ruleId)
          }
        }
      }
    }
  })
})

describe('原则 1 / 原则 4 的 Story 1 子集：使用不会升级（需求规格 §32）', () => {
  it('PROPOSED 项经 Scene Breakdown / Writer / Draft 使用后仍为 PROPOSED', () => {
    let item = makeItem('PROPOSED')
    item = recordUsage(item, 'SCENE_BREAKDOWN_REFERENCE')
    item = recordUsage(item, 'WRITER_REFERENCE')
    item = recordUsage(item, 'DRAFT_CONTAINS')
    expect(item.status).toBe('PROPOSED')
    expect(item.source).toBe('harness')
    expect(item.origin).toBeUndefined()
  })

  it('反复使用（被多次使用）同样不会升级（需求规格 §6.3）', () => {
    const item = makeItem('PROPOSED')
    for (let i = 0; i < 10; i += 1) {
      expect(recordUsage(item, 'WRITER_REFERENCE').status).toBe('PROPOSED')
    }
  })

  it('recordUsage 拒绝非"使用"类触发器，强制走 transitionStatus', () => {
    const item = makeItem('PROPOSED')
    expect(() => recordUsage(item, 'GATE2_CONFIRM')).toThrow(TypeError)
    expect(() => recordUsage(item, 'STATE_EXTRACTOR')).toThrow(/只接受"使用"类触发器/)
  })

  it('transitionStatus 拒绝"使用"类触发器（F3/F4/F5 可执行）', () => {
    const usageToRule = {
      SCENE_BREAKDOWN_REFERENCE: 'F3',
      WRITER_REFERENCE: 'F4',
      DRAFT_CONTAINS: 'F5',
    } as const
    for (const [trigger, ruleId] of Object.entries(usageToRule)) {
      let caught: unknown
      try {
        transitionStatus(makeItem('PROPOSED'), 'CONFIRMED', { trigger: trigger as TransitionTrigger })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(IllegalTransitionError)
      expect((caught as IllegalTransitionError).ruleId).toBe(ruleId)
    }
  })

  it('OCCURRED 不得反向自动覆盖 CONFIRMED（需求规格 §6.5 / F6）', () => {
    const occurred = makeItem('OCCURRED')
    expect(() => transitionStatus(occurred, 'CONFIRMED', { trigger: 'STATE_EXTRACTOR' })).toThrow(/F6/)
    expect(occurred.status).toBe('OCCURRED')
  })

  it('迁移返回的是新的冻结对象，原对象不被修改', () => {
    const proposed = makeItem('PROPOSED')
    const confirmed = transitionStatus(proposed, 'CONFIRMED', { trigger: 'GATE2_CONFIRM' })
    expect(proposed.status).toBe('PROPOSED')
    expect(confirmed).not.toBe(proposed)
    expect(Object.isFrozen(confirmed)).toBe(true)
  })
})

describe('裁决优先级显式断言（Story 2 加固）', () => {
  /**
   * 实现顺序（src/core/state-machine.ts evaluateTransition）：
   * ① 使用类触发器 → F3/F4/F5
   * ② from=USER_GIVEN：to=USER_GIVEN → A1，否则 U1
   * ③ from===to → NOOP
   * ④ to=USER_GIVEN：from=PROPOSED → G1，否则 U1
   * ⑤ PROPOSED→OCCURRED → F2
   * ⑥ OCCURRED→CONFIRMED → F6
   * ⑦ PROPOSED→CONFIRMED：GATE2 → A2，否则 F1
   * ⑧ CONFIRMED→OCCURRED：GATE3 → A3，否则 U1
   * ⑨ 其余 → U1
   * 本组用例把上述优先级钉死，避免以后调整分支顺序时静默改变裁决结果。
   */
  it('① 使用类触发器优先于 F1：PROPOSED→CONFIRMED 带使用触发器返回 F3/F4/F5', () => {
    const expected = {
      SCENE_BREAKDOWN_REFERENCE: 'F3',
      WRITER_REFERENCE: 'F4',
      DRAFT_CONTAINS: 'F5',
    } as const
    for (const [trigger, ruleId] of Object.entries(expected)) {
      const decision = evaluateTransition({
        from: 'PROPOSED',
        to: 'CONFIRMED',
        trigger: trigger as TransitionTrigger,
      })
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.ruleId).toBe(ruleId)
    }
  })

  it('② 先于 ③：USER_GIVEN→USER_GIVEN 返回 A1（合法规则）而不是 NOOP', () => {
    const decision = evaluateTransition({ from: 'USER_GIVEN', to: 'USER_GIVEN', trigger: 'GATE2_CONFIRM' })
    expect(decision).toMatchObject({ ok: true, ruleId: 'A1' })
  })

  it('② 先于 ④/⑤/⑥：USER_GIVEN 指向前三种状态一律 U1', () => {
    for (const to of ['PROPOSED', 'CONFIRMED', 'OCCURRED'] as const) {
      const decision = evaluateTransition({ from: 'USER_GIVEN', to, trigger: 'GATE2_CONFIRM' })
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.ruleId).toBe('U1')
    }
  })

  it('③ 先于 ⑦：PROPOSED→PROPOSED 带 GATE2_CONFIRM 返回 NOOP 而不是 A2/F1', () => {
    expect(evaluateTransition({ from: 'PROPOSED', to: 'PROPOSED', trigger: 'GATE2_CONFIRM' })).toMatchObject({
      ok: true,
      ruleId: 'NOOP',
    })
  })

  it('④ 先于 ⑨：PROPOSED→USER_GIVEN 返回 G1 而不是泛化的 U1', () => {
    const decision = evaluateTransition({ from: 'PROPOSED', to: 'USER_GIVEN', trigger: 'GATE2_CONFIRM' })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.ruleId).toBe('G1')
  })

  it('⑤ 先于 ⑦：PROPOSED→OCCURRED 带 GATE3_CONFIRM 仍返回 F2（有 Gate 3 也不能从 PROPOSED 直达事实）', () => {
    const decision = evaluateTransition({ from: 'PROPOSED', to: 'OCCURRED', trigger: 'GATE3_CONFIRM' })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.ruleId).toBe('F2')
  })

  it('⑦ 内部：PROPOSED→CONFIRMED 只有 GATE2_CONFIRM 放行，其余触发器一律 F1', () => {
    expect(evaluateTransition({ from: 'PROPOSED', to: 'CONFIRMED', trigger: 'GATE2_CONFIRM' })).toMatchObject({
      ok: true,
      ruleId: 'A2',
    })
    for (const trigger of ['GATE3_CONFIRM', 'STATE_EXTRACTOR'] as const) {
      const decision = evaluateTransition({ from: 'PROPOSED', to: 'CONFIRMED', trigger })
      expect(decision.ok).toBe(false)
      if (!decision.ok) expect(decision.ruleId).toBe('F1')
    }
  })

  it('⑧ 内部：CONFIRMED→OCCURRED 只有 GATE3_CONFIRM 放行，否则 U1 且原因点名 Gate 3', () => {
    expect(evaluateTransition({ from: 'CONFIRMED', to: 'OCCURRED', trigger: 'GATE3_CONFIRM' })).toMatchObject({
      ok: true,
      ruleId: 'A3',
    })
    const decision = evaluateTransition({ from: 'CONFIRMED', to: 'OCCURRED', trigger: 'GATE2_CONFIRM' })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.ruleId).toBe('U1')
      expect(decision.reason).toContain('GATE3_CONFIRM')
    }
  })
})

describe('recordUsage 的冻结边界（Story 2 加固）', () => {
  it('使用后返回的对象一定是冻结的（即使传入的是手工构造、未冻结的项）', () => {
    const handBuilt = {
      id: 'ITEM_009',
      value: '手工构造的 PROPOSED 项',
      status: 'PROPOSED',
      source: 'harness',
    } as StatusItem
    expect(Object.isFrozen(handBuilt)).toBe(false)
    const after = recordUsage(handBuilt, 'WRITER_REFERENCE')
    expect(after).toBe(handBuilt)
    expect(Object.isFrozen(after)).toBe(true)
    expect(() => {
      ;(after as { status: string }).status = 'CONFIRMED'
    }).toThrow(TypeError)
    expect(after.status).toBe('PROPOSED')
  })

  it('已冻结的项保持同一引用（零成本无操作）', () => {
    const item = makeItem('PROPOSED')
    expect(Object.isFrozen(item)).toBe(true)
    expect(recordUsage(item, 'DRAFT_CONTAINS')).toBe(item)
  })
})
