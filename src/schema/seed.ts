import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { checkStatusItemSemantics, statusItemShape } from '../core/item.ts'
import { resolvableRefSchema } from '../core/source-ref.ts'
import { originSchema } from '../core/status.ts'

/**
 * `seed.yaml` Schema —— 需求规格 §8.1 / §8.2 / §8.3；架构设计 §4 / §5；Story 1。
 *
 * 与文档示例的三处差异（均已裁决，见 docs/DECISIONS.md / docs/OPEN-QUESTIONS.md）：
 * 1. 顶层新增 `schema_version`（OQ-09 裁决），与 blueprint/scene/state/manifest 对齐；
 * 2. `gate1_status` 增加初值 `pending`（OQ-05 裁决 / D5）；
 * 3. `ambiguous` 与 `open_questions` 项**不带 status**（OQ-04 裁决 / D4）。
 */

export const SEED_SCHEMA_VERSION = '0.1'

/**
 * Gate 1 状态。需求规格 §8.1 原文注释为 `confirmed | skipped | partial`（均为 Gate 1 之后的结果），
 * 加上 Story 1 必须落盘、但 Gate 1 尚未发生的初值（OQ-05 / D5）。
 */
export const GATE1_STATUSES = ['pending', 'confirmed', 'skipped', 'partial'] as const
export const gate1StatusSchema = z.enum(GATE1_STATUSES)

/** 需求规格 §8.1：原始 Seed 中直接抽取、`status=USER_GIVEN` / `source=user` / `origin=raw_seed` 的锚点。 */
export const fixedByUserItemSchema = z
  .strictObject({
    ...statusItemShape,
    id: z.string().regex(ID_PATTERNS.seedAnchorFixed, 'Seed 锚点 ID 必须形如 SEED_F001（需求规格 §8.1）'),
    status: z.literal('USER_GIVEN'),
    origin: originSchema,
  })
  .superRefine((item, ctx) => {
    for (const issue of checkStatusItemSemantics(item)) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: [...issue.path] })
    }
  })
export type FixedByUserItem = z.infer<typeof fixedByUserItemSchema>

/**
 * 需求规格 §8.1 `ambiguous`：Interpreter 判定的模糊项。
 * OQ-04 裁决：这是 Interpreter 的中间态，不属于四状态模型 —— 用 `source: interpreter` 标注，**不设 status**。
 */
export const ambiguousItemSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.seedAmbiguous, '模糊项 ID 必须形如 SEED_A001（OQ-04 裁决）'),
  value: z.string().min(1),
  source: z.literal('interpreter'),
  source_ref: resolvableRefSchema.nullish(),
})
export type AmbiguousItem = z.infer<typeof ambiguousItemSchema>

/**
 * 需求规格 §8.3：Open Question 的 ID 在 seed.yaml 中稳定；
 * `SEED_Q*` 不承载 status（其 open/resolved 生命周期属于 Story State 的投影）。
 */
export const openQuestionItemSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.seedQuestion, 'Open Question ID 必须形如 SEED_Q001（需求规格 §8.3）'),
  value: z.string().min(1),
  source: z.literal('interpreter'),
  source_ref: resolvableRefSchema.nullish(),
})
export type OpenQuestionItem = z.infer<typeof openQuestionItemSchema>

export const storySeedSchema = z.strictObject({
  /** 需求规格 §8.1：保留 raw input（Story 1 验收 2/3：可保存、且原话原样保留）。 */
  raw_input: z.string(),
  /**
   * 需求规格 §8.2：Seed Interpreter 首次产出后立即冻结，
   * `= 当时所有 origin=raw_seed 的 fixed_by_user.id`；Gate 1 后不重算。
   */
  raw_seed_anchor_ids: z.array(z.string().regex(ID_PATTERNS.seedAnchorFixed, 'Seed 锚点 ID 必须形如 SEED_F001')),
  gate1_status: gate1StatusSchema,
  fixed_by_user: z.array(fixedByUserItemSchema),
  ambiguous: z.array(ambiguousItemSchema),
  open_questions: z.array(openQuestionItemSchema),
})
export type StorySeed = z.infer<typeof storySeedSchema>

export const seedFileSchema = z.strictObject({
  schema_version: z.literal(SEED_SCHEMA_VERSION),
  story_seed: storySeedSchema,
})
export type SeedFile = z.infer<typeof seedFileSchema>

export interface SeedInvariantIssue {
  readonly code: string
  readonly message: string
}

/**
 * `seed.yaml` 不变量（需求规格 §8.2 / §5.1；解读 I-8）。
 * 违反时拒绝写入，而不是静默修正 —— 这是"不存在自动状态升级 / anchor 漂移"的结构性保证。
 */
export function checkSeedInvariants(seed: StorySeed): SeedInvariantIssue[] {
  const issues: SeedInvariantIssue[] = []
  const anchors = new Set(seed.raw_seed_anchor_ids)

  for (const item of seed.fixed_by_user) {
    if (item.origin === 'raw_seed' && !anchors.has(item.id)) {
      issues.push({
        code: 'ANCHOR_NOT_FROZEN',
        message: `fixed_by_user ${item.id} 的 origin=raw_seed，但不在 raw_seed_anchor_ids 中；首次 Interpreter 后必须立即冻结（需求规格 §8.2）`,
      })
    }
    if (item.origin === 'gate1_confirmation' && anchors.has(item.id)) {
      issues.push({
        code: 'GATE1_ITEM_IN_ANCHOR_SET',
        message: `${item.id} 是 Gate 1 提升项（origin=gate1_confirmation），不得加入 raw_seed_anchor_ids；Gate 1 升降级不改变评估分母（需求规格 §8.2 / §10.1）`,
      })
    }
  }

  if (seed.gate1_status === 'pending' && seed.fixed_by_user.some((item) => item.source === 'user_gate1')) {
    issues.push({
      code: 'GATE1_ITEMS_BEFORE_GATE1',
      message: 'gate1_status=pending 时不得存在 source=user_gate1 的项：该来源只能由 Gate 1 用户主动提升产生（需求规格 §5.1）',
    })
  }

  return issues
}

export class SeedValidationError extends Error {
  override readonly name = 'SeedValidationError'
  readonly detail: readonly string[]

  constructor(detail: readonly string[]) {
    super(`seed.yaml 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}

/** zod 校验 → 不变量校验 → 深度冻结。写入与读取都必须经过这里。 */
export function validateSeedFile(value: unknown): SeedFile {
  const parsed = seedFileSchema.safeParse(value)
  if (!parsed.success) {
    throw new SeedValidationError(formatZodIssues(parsed.error))
  }
  const seed = parsed.data
  const invariantIssues = checkSeedInvariants(seed.story_seed)
  if (invariantIssues.length > 0) {
    throw new SeedValidationError(invariantIssues.map((issue) => `${issue.code}: ${issue.message}`))
  }
  return deepFreeze(seed) as SeedFile
}

/** 新建项目的空 seed：raw_input 可原样写入，其余结构保持空集合，等待 Story 2 的 Interpreter。 */
export function createEmptySeed(rawInput: string): SeedFile {
  return {
    schema_version: SEED_SCHEMA_VERSION,
    story_seed: {
      raw_input: rawInput,
      raw_seed_anchor_ids: [],
      gate1_status: 'pending',
      fixed_by_user: [],
      ambiguous: [],
      open_questions: [],
    },
  }
}
