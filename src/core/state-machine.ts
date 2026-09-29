import { deepFreeze } from './freeze.ts'
import type { StatusItem } from './item.ts'
import type { Source, Status } from './status.ts'

/**
 * 状态机 —— 架构设计 §7「状态机」；需求规格 §6、§32；Story 1「功能」第 5 条。
 *
 * 合法流转（架构设计 §7，封闭集）：
 * ```text
 * USER_GIVEN  └── 保持 USER_GIVEN
 * PROPOSED    └── Gate 2 用户确认 → CONFIRMED
 * CONFIRMED   └── Gate 3 后正文实际发生 → OCCURRED
 * ```
 *
 * 禁止流转（架构设计 §7，6 条）+ Story 1 附加守卫 G1（OQ-22，从原则 2 推导）：
 * ```text
 * F1 PROPOSED → CONFIRMED（无 Gate 2）
 * F2 PROPOSED → OCCURRED
 * F3 Scene 使用 → 自动升级
 * F4 Writer 使用 → 自动升级
 * F5 Draft 出现 → 自动升级
 * F6 OCCURRED → 自动覆盖 CONFIRMED
 * G1 PROPOSED → USER_GIVEN（非文档明文，从原则 2 推导）
 * ```
 *
 * U1：文档未定义的迁移一律拒绝（OQ-23 严格解读，依据架构设计 §33.5 + 需求规格 §33）。
 */

/**
 * 触发器命名（D8 裁决）。前两个是 Gate 证据，中间三个是"使用"事件，最后一个是终稿事实提取。
 * 架构设计 §7 的 F3/F4/F5 在文档里是描述性文字（"Scene 使用""Writer 使用""Draft 出现"），
 * 这里给它们可执行标识符。
 */
export const TRANSITION_TRIGGERS = [
  'GATE2_CONFIRM',
  'GATE3_CONFIRM',
  'SCENE_BREAKDOWN_REFERENCE',
  'WRITER_REFERENCE',
  'DRAFT_CONTAINS',
  'STATE_EXTRACTOR',
] as const
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number]

/** "使用"类触发器：它们不构成任何状态迁移依据。 */
export const USAGE_TRIGGERS = ['SCENE_BREAKDOWN_REFERENCE', 'WRITER_REFERENCE', 'DRAFT_CONTAINS'] as const
export type UsageTrigger = (typeof USAGE_TRIGGERS)[number]

export function isUsageTrigger(trigger: TransitionTrigger): trigger is UsageTrigger {
  return (USAGE_TRIGGERS as readonly string[]).includes(trigger)
}

export type AllowedRuleId = 'A1' | 'A2' | 'A3'
export type ForbiddenRuleId = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'G1' | 'U1'
export type DecisionRuleId = AllowedRuleId | 'NOOP' | ForbiddenRuleId

export interface AllowedTransition {
  readonly id: AllowedRuleId
  readonly from: Status
  readonly to: Status
  readonly trigger: TransitionTrigger | null
  readonly docRef: string
  readonly description: string
}

/** 架构设计 §7「合法流转」的三条正向规则。 */
export const ALLOWED_TRANSITIONS: readonly AllowedTransition[] = [
  {
    id: 'A1',
    from: 'USER_GIVEN',
    to: 'USER_GIVEN',
    trigger: null,
    docRef: '架构设计 §7；需求规格 §6.2',
    description: 'USER_GIVEN 保持自身：最高优先级，不允许 Harness 自动覆盖',
  },
  {
    id: 'A2',
    from: 'PROPOSED',
    to: 'CONFIRMED',
    trigger: 'GATE2_CONFIRM',
    docRef: '需求规格 §5.2；架构设计 §7',
    description: 'Gate 2 是 PROPOSED → CONFIRMED 的唯一正常升级入口',
  },
  {
    id: 'A3',
    from: 'CONFIRMED',
    to: 'OCCURRED',
    trigger: 'GATE3_CONFIRM',
    docRef: '需求规格 §6.5；架构设计 §7',
    description: 'OCCURRED 只能在 Gate 3 之后，由用户确认过的正文实际发生产生',
  },
]

export interface ForbiddenStatusPairRule {
  readonly kind: 'status-pair'
  readonly id: 'F1' | 'F2' | 'F6' | 'G1'
  readonly from: Status
  readonly to: Status
  /** 该禁止项的唯一豁免触发器（仅 F1 有：Gate 2 确认）。 */
  readonly unlessTrigger: TransitionTrigger | null
  readonly docRef: string
  readonly description: string
}

export interface ForbiddenUsageRule {
  readonly kind: 'usage'
  readonly id: 'F3' | 'F4' | 'F5'
  readonly trigger: UsageTrigger
  readonly docRef: string
  readonly description: string
}

export type ForbiddenRule = ForbiddenStatusPairRule | ForbiddenUsageRule

/** 架构设计 §7「禁止流转」6 条 + Story 1 附加守卫 G1（OQ-22）。共 7 条，1:1 对应文档文字。 */
export const FORBIDDEN_TRANSITIONS: readonly ForbiddenRule[] = [
  {
    kind: 'status-pair',
    id: 'F1',
    from: 'PROPOSED',
    to: 'CONFIRMED',
    unlessTrigger: 'GATE2_CONFIRM',
    docRef: '架构设计 §7「禁止流转」第 1 条；需求规格 §5.2',
    description: 'PROPOSED → CONFIRMED（无 Gate 2）',
  },
  {
    kind: 'status-pair',
    id: 'F2',
    from: 'PROPOSED',
    to: 'OCCURRED',
    unlessTrigger: null,
    docRef: '架构设计 §7「禁止流转」第 2 条',
    description: 'PROPOSED → OCCURRED',
  },
  {
    kind: 'usage',
    id: 'F3',
    trigger: 'SCENE_BREAKDOWN_REFERENCE',
    docRef: '架构设计 §7「禁止流转」第 3 条；需求规格 §4 / §6.3',
    description: 'Scene 使用 → 自动升级',
  },
  {
    kind: 'usage',
    id: 'F4',
    trigger: 'WRITER_REFERENCE',
    docRef: '架构设计 §7「禁止流转」第 4 条；需求规格 §6.3',
    description: 'Writer 使用 → 自动升级',
  },
  {
    kind: 'usage',
    id: 'F5',
    trigger: 'DRAFT_CONTAINS',
    docRef: '架构设计 §7「禁止流转」第 5 条；需求规格 §6.3「出现在 Draft 中，仍然不会自动升级」',
    description: 'Draft 出现 → 自动升级',
  },
  {
    kind: 'status-pair',
    id: 'F6',
    from: 'OCCURRED',
    to: 'CONFIRMED',
    unlessTrigger: null,
    docRef: '架构设计 §7「禁止流转」第 6 条；需求规格 §6.5',
    description: 'OCCURRED → 自动覆盖 CONFIRMED',
  },
  {
    kind: 'status-pair',
    id: 'G1',
    from: 'PROPOSED',
    to: 'USER_GIVEN',
    unlessTrigger: null,
    docRef: '需求规格 §3 原则 2（可以提案，不能伪装）；OQ-22',
    description: 'PROPOSED → USER_GIVEN（非文档明文，从原则 2 推导）',
  },
]

const U1_DOC_REF = '架构设计 §33.5（Author Control）+ §7 合法流转封闭集；需求规格 §33；OQ-23'

export interface TransitionRequest {
  readonly from: Status
  readonly to: Status
  readonly trigger: TransitionTrigger
}

export type TransitionDecision =
  | { readonly ok: true; readonly ruleId: AllowedRuleId | 'NOOP'; readonly docRef: string; readonly reason: string }
  | { readonly ok: false; readonly ruleId: ForbiddenRuleId; readonly docRef: string; readonly reason: string }

function allowed(rule: AllowedTransition, reason: string): TransitionDecision {
  return { ok: true, ruleId: rule.id, docRef: rule.docRef, reason }
}

function rejected(ruleId: ForbiddenRuleId, docRef: string, reason: string): TransitionDecision {
  return { ok: false, ruleId, docRef, reason }
}

/**
 * 纯函数裁决：`(from, to, trigger) → 允许 / 拒绝 + 规则 ID`。
 * 表驱动测试直接消费本函数与 `FORBIDDEN_TRANSITIONS`，无需通过文件系统。
 */
export function evaluateTransition({ from, to, trigger }: TransitionRequest): TransitionDecision {
  // F3/F4/F5：使用行为不构成任何状态迁移依据（需求规格 §6.3、§32 原则 1/4）
  const usageRule = FORBIDDEN_TRANSITIONS.find(
    (rule): rule is ForbiddenUsageRule => rule.kind === 'usage' && rule.trigger === trigger,
  )
  if (usageRule) {
    return rejected(
      usageRule.id,
      usageRule.docRef,
      `${usageRule.description}：${trigger} 是"使用"事件，只能通过 recordUsage() 记录，不能作为状态迁移触发器`,
    )
  }

  // A1：USER_GIVEN 保持自身；任何其他目标都不是文档定义的迁移
  if (from === 'USER_GIVEN') {
    if (to === 'USER_GIVEN') {
      const a1 = ALLOWED_TRANSITIONS[0] as AllowedTransition
      return allowed(a1, 'USER_GIVEN 保持 USER_GIVEN：最高优先级，不允许 Harness 自动覆盖')
    }
    const a1 = ALLOWED_TRANSITIONS[0] as AllowedTransition
    return rejected(
      'U1',
      a1.docRef,
      `USER_GIVEN 只能保持自身，不允许迁移为 ${to}（需求规格 §6.2：不允许 Harness 自动覆盖）`,
    )
  }

  // 同状态幂等（例如终稿重跑 State Extractor、Blueprint 再次确认）
  if (from === to) {
    return { ok: true, ruleId: 'NOOP', docRef: '架构设计 §7', reason: `状态未变化（${from}），按幂等处理` }
  }

  // G1：PROPOSED → USER_GIVEN 无条件禁止；其余指向 USER_GIVEN 的迁移文档未定义
  if (to === 'USER_GIVEN') {
    if (from === 'PROPOSED') {
      const g1 = FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'G1') as ForbiddenStatusPairRule
      return rejected(
        'G1',
        g1.docRef,
        'PROPOSED → USER_GIVEN：Harness 补出的内容不得伪装为用户已确定的内容（需求规格 §3 原则 2；OQ-22）',
      )
    }
    return rejected('U1', U1_DOC_REF, `文档未定义任何指向 USER_GIVEN 的迁移（收到 ${from} → USER_GIVEN）`)
  }

  if (from === 'PROPOSED' && to === 'OCCURRED') {
    const f2 = FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F2') as ForbiddenStatusPairRule
    return rejected('F2', f2.docRef, 'PROPOSED → OCCURRED：推演不会产生事实（需求规格 §3 原则 4）')
  }

  if (from === 'OCCURRED' && to === 'CONFIRMED') {
    const f6 = FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F6') as ForbiddenStatusPairRule
    return rejected('F6', f6.docRef, 'OCCURRED 不得自动反向覆盖 CONFIRMED（需求规格 §6.5）')
  }

  if (from === 'PROPOSED' && to === 'CONFIRMED') {
    const a2 = ALLOWED_TRANSITIONS[1] as AllowedTransition
    if (trigger === 'GATE2_CONFIRM') {
      return allowed(a2, 'Gate 2 用户确认：PROPOSED → CONFIRMED')
    }
    const f1 = FORBIDDEN_TRANSITIONS.find((rule) => rule.id === 'F1') as ForbiddenStatusPairRule
    return rejected('F1', f1.docRef, `PROPOSED → CONFIRMED 必须携带 GATE2_CONFIRM 证据，收到 "${trigger}"`)
  }

  if (from === 'CONFIRMED' && to === 'OCCURRED') {
    const a3 = ALLOWED_TRANSITIONS[2] as AllowedTransition
    if (trigger === 'GATE3_CONFIRM') {
      return allowed(a3, 'Gate 3 终稿确认：正文实际发生 → OCCURRED')
    }
    return rejected('U1', a3.docRef, `CONFIRMED → OCCURRED 必须携带 GATE3_CONFIRM 证据，收到 "${trigger}"`)
  }

  return rejected('U1', U1_DOC_REF, `文档未定义的迁移：${from} → ${to}（触发器 ${trigger}）`)
}

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError'
  readonly ruleId: ForbiddenRuleId
  readonly from: Status
  readonly to: Status
  readonly trigger: TransitionTrigger
  readonly docRef: string

  constructor(decision: Extract<TransitionDecision, { ok: false }>, request: TransitionRequest) {
    super(`非法状态流转 [${decision.ruleId}] ${request.from} → ${request.to} (trigger=${request.trigger})：${decision.reason}｜出处：${decision.docRef}`)
    this.ruleId = decision.ruleId
    this.from = request.from
    this.to = request.to
    this.trigger = request.trigger
    this.docRef = decision.docRef
  }
}

export interface TransitionContext {
  readonly trigger: TransitionTrigger
}

/**
 * 迁移后 source 的取值（解读 I-1）：需求规格 §7 的 source 枚举本身就包含
 * `blueprint`（Gate 2 确认）与 `final_text`（终稿事实）两个值。
 */
export const SOURCE_AFTER_TRANSITION: Partial<Record<AllowedRuleId, Source>> = {
  A2: 'blueprint',
  A3: 'final_text',
}

/**
 * **唯一**允许改变 status 的入口。非法的流转一律抛 `IllegalTransitionError`。
 * 返回的新对象为冻结对象；非 USER_GIVEN 的 origin 会被清除（需求规格 §7.1）。
 */
export function transitionStatus(item: StatusItem, to: Status, ctx: TransitionContext): StatusItem {
  const request: TransitionRequest = { from: item.status, to, trigger: ctx.trigger }
  const decision = evaluateTransition(request)
  if (!decision.ok) {
    throw new IllegalTransitionError(decision, request)
  }
  if (decision.ruleId === 'NOOP' || decision.ruleId === 'A1') {
    return item
  }
  const nextSource = SOURCE_AFTER_TRANSITION[decision.ruleId] ?? item.source
  return deepFreeze({ ...item, status: to, source: nextSource, origin: undefined }) as StatusItem
}

/**
 * 记录"被使用"（Scene Breakdown 引用 / Writer 引用 / Draft 出现）。
 *
 * 需求规格 §6.3：被使用、被引用、出现在 Draft 中、"被多次使用也不会自动升级"。
 * 因此本函数**返回同一引用**，调用方不可能通过它拿到任何升级路径（架构设计 §7 F3/F4/F5）。
 *
 * 冻结边界（Story 2 加固）：返回值一律经过 `deepFreeze` —— 对已经冻结的项是零成本无操作，
 * 对手工构造、尚未经过 parse/validate 边界的项则补上冻结，避免"使用过后仍可被改写"。
 */
export function recordUsage(item: StatusItem, trigger: TransitionTrigger): StatusItem {
  if (!isUsageTrigger(trigger)) {
    throw new TypeError(
      `recordUsage() 只接受"使用"类触发器（${USAGE_TRIGGERS.join(' / ')}），收到 "${trigger}"；状态迁移请使用 transitionStatus()`,
    )
  }
  return deepFreeze(item) as StatusItem
}
