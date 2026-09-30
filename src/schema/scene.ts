import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import {
  OBSERVABLE_HINT_TAGS,
  SCENE_TYPES,
  TONE_TAGS,
  observableHintTagList,
  sceneTypeList,
} from '../core/scene-types.ts'
import { STRUCTURE_IDS } from './blueprint.ts'

/**
 * Scene Schema —— 需求规格 §14（唯一版本）；Story 5。
 *
 * ```yaml
 * schema_version: "0.1"
 * scene_id / order / pov / scene_type / purpose / target_length
 * narrative_role_ref: BP_STR_TURN
 * characters / location / start_state / conflict / turn / end_state
 * tone: [conflict, restraint]       # OQ-47：必填，至少 1 个（OBH 与 Style Sample 匹配用）
 * allowed_reveals: []              # 由 Structure Resolver 写入，不由模型输出
 * director_notes: []               # OQ-11 裁决的结构
 * referenced_blueprint_items: []
 * proposed_additions: []           # 永久 PROPOSED / source=scene_breakdown（OQ-14）
 * ```
 */

export const SCENE_SCHEMA_VERSION = '0.1'

/** OQ-11 裁决：`{id: DIR_<source>_NNN, instruction, source}`；`source=blueprint` 时携带 `blueprint_ref`。 */
export const DIRECTOR_NOTE_SOURCES = ['user', 'blueprint', 'scene'] as const
export const directorNoteIdSchema = z
  .string()
  .regex(/^DIR_(USER|BLUEPRINT|SCENE)_\d{3}$/, 'director note ID 必须形如 DIR_USER_001 / DIR_BLUEPRINT_001 / DIR_SCENE_001')

export const directorNoteSchema = z
  .strictObject({
    id: directorNoteIdSchema,
    instruction: z.string().min(1),
    source: z.enum(DIRECTOR_NOTE_SOURCES),
    blueprint_ref: z
      .string()
      .regex(ID_PATTERNS.blueprintItemRef, 'blueprint_ref 必须是真实存在的 Blueprint 项 ID（BP_* / K### / CH_* / OBH_* / REL_*）')
      .optional(),
  })
  .superRefine((note, ctx) => {
    const expectedPrefix = `DIR_${note.source.toUpperCase()}_`
    if (!note.id.startsWith(expectedPrefix)) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: `director note 的 ID 前缀必须与 source 一致：source=${note.source} 时必须是 ${expectedPrefix}NNN（OQ-11）`,
      })
    }
    if (note.source === 'blueprint' && note.blueprint_ref === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['blueprint_ref'],
        message: 'source=blueprint 的 director note 必须携带 blueprint_ref（OQ-11）',
      })
    }
    if (note.source !== 'blueprint' && note.blueprint_ref !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['blueprint_ref'],
        message: '只有 source=blueprint 的 director note 才允许携带 blueprint_ref（OQ-11）',
      })
    }
  })
export type DirectorNote = z.infer<typeof directorNoteSchema>

/** OQ-14 裁决：Scene 新增内容永久保持 PROPOSED / scene_breakdown，不回写。 */
export const sceneAdditionSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.proposalAddition, 'Scene 新增项 ID 必须形如 ADD_001（每个 Scene 内独立编号）'),
  value: z.string().min(1),
  status: z.literal('PROPOSED'),
  source: z.literal('scene_breakdown'),
})
export type SceneAddition = z.infer<typeof sceneAdditionSchema>

export const sceneSchema = z
  .strictObject({
    schema_version: z.literal(SCENE_SCHEMA_VERSION),
    scene_id: z.string().regex(ID_PATTERNS.scene, 'scene_id 必须形如 scene-001'),
    order: z.number().int().min(1),
    pov: z.string().regex(ID_PATTERNS.character, 'scene.pov 必须是 CH_* 角色 ID'),
    scene_type: z.enum(SCENE_TYPES, {
      error: () => ({ message: `scene_type 必须是 ${sceneTypeList()}（OQ-36 裁决）` }),
    }),
    /**
     * OQ-47 裁决：Scene 新增必填字段 `tone`（至少 1 个，取自 OQ-41 的八值枚举），
     * 由 `scene_breakdown@0.1` 的 LLM 输出，**不从 Scene 文本推断**。
     * OBH 匹配 = Scene 的 `scene_type ∪ tone` 与 hint 的 `applicable_scene_types` 求交集，非空即加载。
     */
    tone: z
      .array(z.enum(TONE_TAGS, { error: () => ({ message: `tone 取值必须是 ${TONE_TAGS.join(' / ')}（OQ-41 / OQ-47）` }) }))
      .min(1, 'tone 至少要有 1 个取值（OQ-47 裁决）'),
    purpose: z.string().min(1),
    target_length: z.number().int().positive(),
    /**
     * 需求规格 §14 / 架构设计 §14（OQ-42 复议 / OQ-62，解读 I-82 / I-83）：
     * **只接受 structure 位置（`BP_STR_*`）**。arc 是否被覆盖不在 Scene 上表达，
     * 由 Coverage Check 按"直接引用 **或** 其映射的 structure 位置已被覆盖"判定（I-38）。
     */
    narrative_role_ref: z
      .string()
      .refine(
        (value) => /^BP_STR_[A-Z]+$/.test(value),
        'narrative_role_ref 必须是 structure 位置（BP_STR_*）；arc 覆盖由 Coverage Check 按映射判定（OQ-42 复议）',
      ),
    characters: z.array(z.string().regex(ID_PATTERNS.character, 'characters 元素必须是 CH_* 角色 ID')),
    location: z.string().min(1),
    start_state: z.string().min(1),
    conflict: z.string().min(1),
    turn: z.string().min(1),
    end_state: z.string().min(1),
    /** §15：只允许引用 key_knowledge.id，且由 Structure Resolver 生成（不由模型输出）。 */
    allowed_reveals: z.array(z.string().regex(ID_PATTERNS.keyKnowledge, 'allowed_reveals 只能引用 K### Key Knowledge ID')),
    director_notes: z.array(directorNoteSchema),
    /**
     * 必须引用真实存在的 Blueprint 项（§16 blueprint reference integrity）。
     * 形态为 Blueprint 项 ID 的并集：BP_* / K### / CH_* / OBH_* / REL_*；
     * "是否真实存在"由 Coverage Check 对照 Blueprint 校验（§16）。
     */
    referenced_blueprint_items: z.array(
      z.string().regex(ID_PATTERNS.blueprintItemRef, '必须是 BP_* / K### / CH_* / OBH_* / REL_* 形态的 Blueprint 项 ID'),
    ),
    proposed_additions: z.array(sceneAdditionSchema),
  })
  .superRefine((scene, ctx) => {
    if (!(Object.values(STRUCTURE_IDS) as string[]).includes(scene.narrative_role_ref)) {
      ctx.addIssue({
        code: 'custom',
        path: ['narrative_role_ref'],
        message: `未知的 narrative_role_ref：${scene.narrative_role_ref}`,
      })
    }
    const ids = scene.proposed_additions.map((addition) => addition.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['proposed_additions'], message: 'proposed_additions 的 ID 在同一 Scene 内必须唯一' })
    }
    const noteIds = scene.director_notes.map((note) => note.id)
    if (new Set(noteIds).size !== noteIds.length) {
      ctx.addIssue({ code: 'custom', path: ['director_notes'], message: 'director_notes 的 ID 必须唯一' })
    }
  })
export type Scene = z.infer<typeof sceneSchema>

export class SceneValidationError extends Error {
  override readonly name = 'SceneValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`Scene 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateScene(value: unknown): Scene {
  const parsed = sceneSchema.safeParse(value)
  if (!parsed.success) {
    throw new SceneValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data) as Scene
}

/** OBH 标签校验（OQ-36 / OQ-41：scene_type ∪ tone 联合白名单）。 */
export function isAllowedObservableHintTag(value: string): boolean {
  return OBSERVABLE_HINT_TAGS.includes(value)
}

export function observableHintTagErrorMessage(): string {
  return `applicable_scene_types 只能是 scene_type ∪ tone 的联合白名单：${observableHintTagList()}（OQ-36 / OQ-41）`
}
