import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'

/**
 * Context Manifest Schema —— 需求规格 §21（唯一版本）；架构设计 §22；Story 6。
 *
 * 关键约束：
 * - `excluded_sensitive[].reason` **必填**，取值锁定为六类枚举（Story 6 起始会裁决）；
 * - 普通非敏感 included facts 不逐条写入；
 * - 用户补充的 director note 进入 `director_surface`（`source: user_override`），
 *   审计来源写入 `overrides`，并通过 `director_surface_ref` 与对应 `director_surface.id` **一对一**引用；
 * - `future_content_exposed` / `unconfirmed_proposal_exposed` 必须为 false。
 */

export const CONTEXT_MANIFEST_SCHEMA_VERSION = '0.1'

/** Story 6 起始会裁决：excluded_sensitive.reason 六类枚举锁定。 */
export const EXCLUSION_REASONS = [
  'not_revealed_yet',
  'future_scene',
  'non_pov_inner_state',
  'unconfirmed_content',
  'foreshadowing_backstage',
  'user_override',
] as const
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

export const INCLUDED_SENSITIVE_TYPES = ['key_knowledge', 'foreshadowing', 'user_override'] as const
export const EXCLUDED_SENSITIVE_TYPES = [
  'key_knowledge',
  'foreshadowing',
  'future_content',
  'unconfirmed_content',
  'user_override',
] as const

/** Story 6 起始会裁决：只有 `source=user_override` 进 `overrides`。 */
export const DIRECTOR_SURFACE_SOURCES = ['blueprint', 'scene', 'user_override'] as const

export const includedSensitiveSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(INCLUDED_SENSITIVE_TYPES),
  source_ref: z.string().min(1),
  reason: z.string().min(1),
})

export const excludedSensitiveSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(EXCLUDED_SENSITIVE_TYPES),
  source_ref: z.string().min(1),
  /** 必填，且必须是六类枚举之一（需求规格 §21）。 */
  reason: z.enum(EXCLUSION_REASONS, {
    error: () => ({ message: `excluded_sensitive.reason 必须是 ${EXCLUSION_REASONS.join(' / ')} 之一（必填）` }),
  }),
})

export const directorSurfaceEntrySchema = z.strictObject({
  id: z.string().regex(/^DIR_(USER|BLUEPRINT|SCENE)_\d{3}$/, 'director_surface.id 必须是 DIR_<source>_NNN'),
  source_ref: z.string().min(1),
  instruction: z.string().min(1),
  source: z.enum(DIRECTOR_SURFACE_SOURCES),
})

export const styleSampleManifestEntrySchema = z.strictObject({
  sample_id: z.string().regex(/^SAMPLE_\d{3}$/, 'sample_id 必须形如 SAMPLE_001'),
  /** 实际命中使用的标签（按 §23.1 的降级顺序）。 */
  matched_on: z.array(z.enum(['pov', 'scene_type', 'tone'])),
})

export const overrideSchema = z.strictObject({
  id: z.string().regex(/^OVR_\d{3}$/, 'override ID 必须形如 OVR_001'),
  director_surface_ref: z.string().regex(/^DIR_USER_\d{3}$/, 'override 只能引用 source=user_override 的 director_surface 条目'),
  note: z.string().min(1),
  source: z.literal('user'),
})

export const contextManifestSchema = z
  .strictObject({
    schema_version: z.literal(CONTEXT_MANIFEST_SCHEMA_VERSION),
    scene_id: z.string().regex(ID_PATTERNS.scene, 'scene_id 必须是 scene-###'),
    blueprint_version: z.number().int().min(1),
    pov: z.string().regex(ID_PATTERNS.character, 'pov 必须是 CH_* 角色 ID'),
    included_sensitive: z.array(includedSensitiveSchema),
    excluded_sensitive: z.array(excludedSensitiveSchema),
    director_surface: z.array(directorSurfaceEntrySchema),
    style_samples: z.array(styleSampleManifestEntrySchema),
    future_content_exposed: z.boolean(),
    unconfirmed_proposal_exposed: z.boolean(),
    overrides: z.array(overrideSchema),
  })
  .superRefine((manifest, ctx) => {
    // overrides 与 director_surface 一对一：每个 overrides 条目都必须指向一条 source=user_override 的指令
    for (const override of manifest.overrides) {
      const target = manifest.director_surface.find((entry) => entry.id === override.director_surface_ref)
      if (target === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['overrides'],
          message: `${override.id}.director_surface_ref=${override.director_surface_ref} 在 director_surface 中不存在（需求规格 §21：一对一引用）`,
        })
        continue
      }
      if (target.source !== 'user_override') {
        ctx.addIssue({
          code: 'custom',
          path: ['overrides'],
          message: `${override.id} 引用了 source=${target.source} 的指令；只有 source=user_override 进 overrides（Story 6 裁决）`,
        })
      }
    }
    // 每条 user_override 指令都必须有且只有一条 overrides 记录（不允许同一条 note 形成两份互不相关的正文内容）
    for (const entry of manifest.director_surface.filter((candidate) => candidate.source === 'user_override')) {
      const matches = manifest.overrides.filter((override) => override.director_surface_ref === entry.id)
      if (matches.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['overrides'],
          message: `${entry.id} 的 overrides 记录数量必须恰好为 1（实际 ${matches.length}）`,
        })
      }
    }
    if (manifest.future_content_exposed) {
      ctx.addIssue({ code: 'custom', path: ['future_content_exposed'], message: 'future_content_exposed 必须为 false（§20.3 / Story 6 验收）' })
    }
    if (manifest.unconfirmed_proposal_exposed) {
      ctx.addIssue({
        code: 'custom',
        path: ['unconfirmed_proposal_exposed'],
        message: 'unconfirmed_proposal_exposed 必须为 false（Proposal 与 Writer 物理隔离，§20.1）',
      })
    }
    const includedIds = manifest.included_sensitive.map((entry) => entry.id)
    if (new Set(includedIds).size !== includedIds.length) {
      ctx.addIssue({ code: 'custom', path: ['included_sensitive'], message: 'included_sensitive 的 id 必须唯一' })
    }
  })
export type ContextManifest = z.infer<typeof contextManifestSchema>

export class ContextManifestValidationError extends Error {
  override readonly name = 'ContextManifestValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`context-manifest 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateContextManifest(value: unknown): ContextManifest {
  const parsed = contextManifestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ContextManifestValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data) as ContextManifest
}
