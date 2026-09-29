import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { SCENE_TYPES, TONE_TAGS, observableHintTagList } from '../core/scene-types.ts'

/**
 * Style Profile —— `project/style/profile.yaml`（需求规格 §23；架构设计 §24；Story 6/7）。
 *
 * 文档只给了标签集合（`pov` / `scene_type` / `tone`）与去实体化建议（§23.2），没有定义文件 Schema。
 * Story 6 起始会裁决（OQ-12）采纳 dsh 提议并补充四条约束：
 * 1. `sample_id` 由 Harness 分配 `SAMPLE_<NNN>`，同项目内不复用；
 * 2. `text` **原样保留**；
 * 3. `de_entity: true` 时 `sanitized_text` 必填；`de_entity: false` 时不得存在；
 * 4. `tags` 的 `pov` / `scene_type` / `tone` 三个都必填。
 */

export const STYLE_PROFILE_SCHEMA_VERSION = '0.1'

export const sampleIdSchema = z.string().regex(/^SAMPLE_\d{3}$/, 'sample_id 必须形如 SAMPLE_001')

export const styleSampleTagsSchema = z.strictObject({
  pov: z.string().regex(ID_PATTERNS.character, 'tags.pov 必须是 CH_* 角色 ID'),
  scene_type: z.enum(SCENE_TYPES, {
    error: () => ({ message: `tags.scene_type 必须是 ${SCENE_TYPES.join(' / ')}` }),
  }),
  tone: z.enum(TONE_TAGS, {
    error: () => ({ message: `tags.tone 必须是 ${TONE_TAGS.join(' / ')}（与 OBH 的 tone 白名单一致，见 ${observableHintTagList()}）` }),
  }),
})

export const styleSampleSchema = z
  .strictObject({
    sample_id: sampleIdSchema,
    tags: styleSampleTagsSchema,
    /** 原文：**原样保留**（裁决第 2 条）。 */
    text: z.string().min(1),
    /** 是否已去实体化（§23.2 建议：人物名 → [CHAR_A] 等）。 */
    de_entity: z.boolean(),
    sanitized_text: z.string().min(1).optional(),
  })
  .superRefine((sample, ctx) => {
    if (sample.de_entity && sample.sanitized_text === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sanitized_text'],
        message: 'de_entity=true 时必须提供 sanitized_text（裁决第 3 条）',
      })
    }
    if (!sample.de_entity && sample.sanitized_text !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sanitized_text'],
        message: 'de_entity=false 时不得存在 sanitized_text（裁决第 3 条）',
      })
    }
  })
export type StyleSample = z.infer<typeof styleSampleSchema>

export const styleProfileSchema = z
  .strictObject({
    schema_version: z.literal(STYLE_PROFILE_SCHEMA_VERSION),
    samples: z.array(styleSampleSchema),
  })
  .superRefine((profile, ctx) => {
    const ids = profile.samples.map((sample) => sample.sample_id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['samples'], message: 'sample_id 在项目内必须唯一且不复用（裁决第 1 条）' })
    }
  })
export type StyleProfile = z.infer<typeof styleProfileSchema>

export class StyleProfileValidationError extends Error {
  override readonly name = 'StyleProfileValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`style/profile.yaml 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateStyleProfile(value: unknown): StyleProfile {
  const parsed = styleProfileSchema.safeParse(value)
  if (!parsed.success) {
    throw new StyleProfileValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data) as StyleProfile
}

export function createEmptyStyleProfile(): StyleProfile {
  return { schema_version: STYLE_PROFILE_SCHEMA_VERSION, samples: [] }
}

/** 裁决第 1 条：`SAMPLE_<NNN>` 由 Harness 分配，同项目内不复用（取既有最大编号 + 1）。 */
export function nextSampleId(profile: StyleProfile): string {
  const max = profile.samples.reduce((accumulator, sample) => {
    const value = Number(sample.sample_id.replace(/^SAMPLE_/, ''))
    return Number.isFinite(value) && value > accumulator ? value : accumulator
  }, 0)
  return `SAMPLE_${String(max + 1).padStart(3, '0')}`
}

/** Writer 只参考句法 / 节奏等表达层信息：有 sanitized_text 时优先使用它（§23.2）。 */
export function sampleTextForWriter(sample: StyleSample): string {
  return sample.de_entity && sample.sanitized_text !== undefined ? sample.sanitized_text : sample.text
}
