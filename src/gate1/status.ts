import { GATE1_STATUSES } from '../schema/seed.ts'

/**
 * `gate1_status` 迁移（Story 2；需求规格 §5.1、§8.1；架构设计 §5）。
 *
 * ```text
 * pending ──┬── confirmed   全部接受（无任何修改）
 *           ├── skipped     跳过 Gate 1（§5.1：跳过需记录 gate1_status=skipped）
 *           └── partial     存在删除 / 提升 / 降级 / 编辑
 * ```
 *
 * 已结束的 Gate 1 不允许再迁移（OQ-27：文档未定义重跑，按严格解读拒绝），
 * 以保证 §8.2 的 anchor 集合与 §5.1 的来源标记不被二次改写。
 */

export const GATE1_OPEN_STATUSES = ['confirmed', 'skipped', 'partial'] as const
export type Gate1OpenStatus = (typeof GATE1_OPEN_STATUSES)[number]
export type Gate1Status = (typeof GATE1_STATUSES)[number]

export type Gate1StatusRuleId = 'G1S-A1' | 'G1S-A2' | 'G1S-A3'

export type Gate1StatusDecision =
  | { readonly ok: true; readonly ruleId: Gate1StatusRuleId; readonly docRef: string; readonly reason: string }
  | { readonly ok: false; readonly ruleId: 'G1S-F1'; readonly docRef: string; readonly reason: string }

const DOC_REF = '需求规格 §5.1 / §8.1；架构设计 §5'

const OPEN_RULES: Readonly<Record<Gate1OpenStatus, { ruleId: Gate1StatusRuleId; reason: string }>> = {
  confirmed: { ruleId: 'G1S-A1', reason: '用户接受全部：gate1_status=confirmed' },
  skipped: { ruleId: 'G1S-A2', reason: '用户跳过 Gate 1：gate1_status=skipped（§5.1）' },
  partial: { ruleId: 'G1S-A3', reason: '用户对分类做了修改：gate1_status=partial' },
}

export function evaluateGate1StatusTransition(from: Gate1Status, to: Gate1Status): Gate1StatusDecision {
  if (from !== 'pending') {
    return {
      ok: false,
      ruleId: 'G1S-F1',
      docRef: DOC_REF,
      reason: `gate1_status 已经是 ${from}，Gate 1 已结束，不允许再次迁移到 ${to}（OQ-27）`,
    }
  }
  if (to === 'pending') {
    return {
      ok: false,
      ruleId: 'G1S-F1',
      docRef: DOC_REF,
      reason: 'pending 只是 Gate 1 之前的初值，不是 Gate 1 的结果状态（OQ-05）',
    }
  }
  const rule = OPEN_RULES[to]
  return { ok: true, ruleId: rule.ruleId, docRef: DOC_REF, reason: rule.reason }
}

export function assertGate1StatusTransition(from: Gate1Status, to: Gate1Status): Gate1StatusRuleId {
  const decision = evaluateGate1StatusTransition(from, to)
  if (!decision.ok) {
    throw new Error(`非法 gate1_status 迁移 [${decision.ruleId}] ${from} → ${to}：${decision.reason}｜出处：${decision.docRef}`)
  }
  return decision.ruleId
}

/** 由已应用的操作推导 Gate 1 结果状态（解读 I-15）。 */
export function deriveGate1Status(operations: readonly { kind: string }[]): Gate1OpenStatus {
  if (operations.length === 0) {
    throw new Error('无法从空操作列表推导 gate1_status：Gate 1 至少需要一个操作')
  }
  if (operations.some((operation) => operation.kind === 'skip')) return 'skipped'
  if (operations.some((operation) => operation.kind === 'accept_all')) return 'confirmed'
  return 'partial'
}
