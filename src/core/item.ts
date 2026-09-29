import { z } from 'zod'
import { deepFreeze } from './freeze.ts'
import { resolvableRefSchema, type SemanticIssue } from './source-ref.ts'
import {
  USER_GIVEN_SOURCE_ORIGIN,
  originSchema,
  sourceSchema,
  statusSchema,
  type Origin,
  type Source,
  type Status,
} from './status.ts'

/**
 * 通用状态数据结构 —— 需求规格 §7 / 架构设计 §7；Story 1「功能」第 2 条。
 *
 * ```yaml
 * id:
 * value:
 * status:
 * source:
 * source_ref:
 * origin: raw_seed | gate1_confirmation | null   # 仅 USER_GIVEN 有意义
 * ```
 *
 * OQ-03 裁决：通用状态项使用**单数** `source_ref`（可为 null；若存在必须是
 * 可解析的 `{type, ref_id}` 结构或稳定 ID 字符串）；Blueprint 类项使用**复数** `source_refs[]`。
 */
export const statusItemShape = {
  id: z.string().min(1),
  value: z.string(),
  status: statusSchema,
  source: sourceSchema,
  source_ref: resolvableRefSchema.nullish(),
  origin: originSchema.nullish(),
} as const

/**
 * 纯函数语义校验（需求规格 §7.1；OQ-24 严格解读）：
 * 1. `status=USER_GIVEN` 时 source 只能是 `user` / `user_gate1`；
 * 2. `status=USER_GIVEN` 时必须记录与 source 配对的 origin；
 * 3. 其他状态必须省略 origin 或置为 null。
 */
export function checkStatusItemSemantics(item: {
  status: Status
  source: Source
  origin?: Origin | null | undefined
}): SemanticIssue[] {
  const issues: SemanticIssue[] = []
  if (item.status === 'USER_GIVEN') {
    if (item.source !== 'user' && item.source !== 'user_gate1') {
      issues.push({
        path: ['source'],
        message: `status=USER_GIVEN 的 source 只能是 user / user_gate1，收到 "${item.source}"（需求规格 §7 / §7.1）`,
      })
    } else {
      const expected = USER_GIVEN_SOURCE_ORIGIN[item.source]
      if (item.origin === null || item.origin === undefined) {
        issues.push({
          path: ['origin'],
          message: `status=USER_GIVEN 必须记录 origin=${expected}（需求规格 §7.1）`,
        })
      } else if (item.origin !== expected) {
        issues.push({
          path: ['origin'],
          message: `source=${item.source} 必须搭配 origin=${expected}，收到 origin=${item.origin}（需求规格 §7.1；OQ-24）`,
        })
      }
    }
  } else if (item.origin !== null && item.origin !== undefined) {
    issues.push({
      path: ['origin'],
      message: `origin 仅对 USER_GIVEN 有意义；status=${item.status} 必须省略 origin 或置为 null（需求规格 §7.1；OQ-24）`,
    })
  }
  return issues
}

export const statusItemSchema = z.strictObject(statusItemShape).superRefine((item, ctx) => {
  for (const issue of checkStatusItemSemantics(item)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [...issue.path] })
  }
})

export type StatusItem = z.infer<typeof statusItemSchema>

/**
 * 推荐的构造入口：zod 校验 → 深度冻结。
 * 冻结之后，任何"顺手改一下 status"的代码都会在严格模式下直接抛错（解读 I-2）。
 */
export function parseStatusItem(value: unknown): StatusItem {
  return deepFreeze(statusItemSchema.parse(value)) as StatusItem
}
