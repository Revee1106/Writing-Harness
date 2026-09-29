import { z } from 'zod'
import { ID_PATTERNS, isStableId } from './ids.ts'
import { PROPOSAL_FIELD_PATHS, parseProposalFieldPath } from './proposal-field-paths.ts'

/**
 * Blueprint `source_refs` 统一结构 —— 需求规格 §7.2 / §9.3；架构设计 §7。
 *
 * ```yaml
 * source_refs:
 *   - type: seed | proposal | user_edit | blueprint_gate2
 *     ref_id: SEED_F001
 * ```
 *
 * 约束（需求规格 §7.2）：不允许使用无法解析的自由字符串作为 source ref。
 * - `type=seed`            → ref_id 指向 Seed item ID（SEED_F / SEED_A / SEED_Q）
 * - `type=proposal`        → ref_id 采用 `<proposal_id>.<field_path>`（§9.3）
 * - `type=user_edit`       → 指向 Gate 2 用户编辑记录 ID（深层可解析性受 OQ-10 阻塞）
 * - `type=blueprint_gate2` → 指向本次 Blueprint 确认动作 ID（同上）
 */
export const SOURCE_REF_TYPES = ['seed', 'proposal', 'user_edit', 'blueprint_gate2'] as const
export type SourceRefType = (typeof SOURCE_REF_TYPES)[number]

export interface SemanticIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
}

/** 纯函数形式的 source_ref 语义校验（供 schema 与单元测试共用）。 */
export function checkSourceRefSemantics(ref: { type: SourceRefType; ref_id: string }): SemanticIssue[] {
  const issues: SemanticIssue[] = []
  switch (ref.type) {
    case 'seed':
      if (!ID_PATTERNS.seedItem.test(ref.ref_id)) {
        issues.push({
          path: ['ref_id'],
          message: `type=seed 的 ref_id 必须指向 Seed item ID（SEED_F/SEED_A/SEED_Q + 3 位数字），收到 "${ref.ref_id}"（需求规格 §7.2）`,
        })
      }
      break
    case 'proposal': {
      if (!ID_PATTERNS.proposalFieldPath.test(ref.ref_id)) {
        issues.push({
          path: ['ref_id'],
          message: `type=proposal 的 ref_id 必须为 "<proposal_id>.<field_path>"，例如 PROP_A.core_premise，收到 "${ref.ref_id}"（需求规格 §9.3）`,
        })
        break
      }
      // 需求规格 §9.3："ref_id 必须可解析到真实 Proposal 和字段路径"。
      // 字段路径受白名单约束（Story 3 提议，见 core/proposal-field-paths.ts / OQ-31）。
      if (parseProposalFieldPath(ref.ref_id) === null) {
        const fieldPath = ref.ref_id.slice(ref.ref_id.indexOf('.') + 1)
        issues.push({
          path: ['ref_id'],
          message: `type=proposal 的字段路径 "${fieldPath}" 不在白名单内；允许的路径：${PROPOSAL_FIELD_PATHS.join(' / ')}`,
        })
      }
      break
    }
    case 'user_edit':
    case 'blueprint_gate2':
      // Story 1 只要求非空；记录载体与深层可解析性由 OQ-10 在 Story 4 收口。
      break
  }
  return issues
}

export const sourceRefSchema = z
  .strictObject({
    type: z.enum(SOURCE_REF_TYPES),
    ref_id: z.string().min(1),
  })
  .superRefine((ref, ctx) => {
    for (const issue of checkSourceRefSemantics(ref)) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: [...issue.path] })
    }
  })
export type SourceRef = z.infer<typeof sourceRefSchema>

/**
 * 通用状态项 `source_ref` 的第二形态（OQ-03 裁决）：
 * 单数 `source_ref` 既可以是结构化 `{type, ref_id}`，也可以是稳定 ID 字符串。
 * 任何无法解析的自由字符串都会被拒绝（需求规格 §7.2）。
 */
export const stableIdSchema = z
  .string()
  .min(1)
  .refine(isStableId, '必须是可解析的稳定 ID（需求规格 §7.2 不允许使用无法解析的自由字符串作为 source ref）')

export const resolvableRefSchema = z.union([sourceRefSchema, stableIdSchema])
export type ResolvableRef = z.infer<typeof resolvableRefSchema>

export function isStructuredSourceRef(ref: ResolvableRef): ref is SourceRef {
  return typeof ref === 'object' && ref !== null
}

/** 稳定比较键，便于去重与测试断言。 */
export function sourceRefKey(ref: ResolvableRef): string {
  return isStructuredSourceRef(ref) ? `${ref.type}:${ref.ref_id}` : `id:${ref}`
}
