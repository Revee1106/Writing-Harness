import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { sourceRefSchema } from '../core/source-ref.ts'
import { CONFLICT_RESOLUTIONS } from './proposal.ts'

/**
 * Gate 2 元数据 —— `blueprint-history/<NNN>.meta.yaml`（OQ-10 用户裁决）。
 *
 * 内容必须包含：
 * - `gate2_action_id: GATE2_<NNN>`（与 `blueprint_version` 一一对应）
 * - `user_edits[].id: EDIT_<NNN>`（跨版本全局递增，见 OQ-38 / 解读 I-29）
 *
 * 定位（解读 I-31）：
 * - 快照本身仍写在 §29/§32 冻结的 `history/blueprint-<NNN>.yaml`；
 * - 本文件写在 `blueprint-history/<NNN>.meta.yaml`，与快照按同一 `<NNN>` 一一对应；
 * - `blueprint.yaml` 内容不受本文件影响（OQ-10 明文「不修改 blueprint.yaml」）。
 */

export const GATE2_META_SCHEMA_VERSION = '0.1'

export const GATE2_MODES = ['single', 'merge', 'manual'] as const
export type Gate2Mode = (typeof GATE2_MODES)[number]

export const gate2ActionIdSchema = z.string().regex(/^GATE2_\d{3}$/, 'gate2_action_id 必须形如 GATE2_001')
export const userEditIdSchema = z.string().regex(/^EDIT_\d{3}$/, 'user_edits[].id 必须形如 EDIT_001')

export const gate2FieldSourceSchema = z.strictObject({
  field: z.string().min(1),
  /** `PROP_A` 之类的 Proposal ID，或 `user`（用户手写）。 */
  from: z.string().min(1),
  /** 该字段在 Blueprint 中的来源引用（结构化，§7.2）。 */
  source_refs: z.array(sourceRefSchema),
})

export const userEditSchema = z.strictObject({
  id: userEditIdSchema,
  field: z.string().min(1),
  value: z.string().min(1),
  source: z.literal('user'),
})

export const conflictResolutionRecordSchema = z.strictObject({
  id: z.string().regex(/^CONF_\d{3}$/, 'conflicts[].id 必须形如 CONF_001'),
  proposal_id: z.string().min(1),
  seed_ref: z.string().min(1),
  resolution: z.enum(CONFLICT_RESOLUTIONS),
})

export const gate2MetaSchema = z.strictObject({
  schema_version: z.literal(GATE2_META_SCHEMA_VERSION),
  blueprint_version: z.number().int().min(1),
  gate2_action_id: gate2ActionIdSchema,
  created_at: z.string().min(1),
  mode: z.enum(GATE2_MODES),
  /** 与 `<NNN>.meta.yaml` 一一对应的快照文件名（相对项目根）。 */
  snapshot: z.string().min(1),
  source_proposal_ids: z.array(z.string().min(1)),
  field_sources: z.array(gate2FieldSourceSchema),
  user_edits: z.array(userEditSchema),
  conflict_resolutions: z.array(conflictResolutionRecordSchema),
})
export type Gate2Meta = z.infer<typeof gate2MetaSchema>

export class Gate2MetaValidationError extends Error {
  override readonly name = 'Gate2MetaValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`Gate 2 元数据校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateGate2Meta(value: unknown): Gate2Meta {
  const parsed = gate2MetaSchema.safeParse(value)
  if (!parsed.success) {
    throw new Gate2MetaValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data) as Gate2Meta
}

export function gate2ActionId(blueprintVersion: number): string {
  return `GATE2_${String(blueprintVersion).padStart(3, '0')}`
}

export function userEditId(sequence: number): string {
  return `EDIT_${String(sequence).padStart(3, '0')}`
}

export function snapshotFileName(blueprintVersion: number): string {
  return `blueprint-${String(blueprintVersion).padStart(3, '0')}.yaml`
}

export function metaFileName(blueprintVersion: number): string {
  return `${String(blueprintVersion).padStart(3, '0')}.meta.yaml`
}
