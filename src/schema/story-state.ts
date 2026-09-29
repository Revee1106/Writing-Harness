import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'

/**
 * Story State Schema —— 需求规格 §17（唯一版本）；Story 5。
 *
 * 关键约束：
 * - **运行时投影**，不复制 Blueprint 的 CONFIRMED 内容（§17 首段）；
 * - **不持久化 timeline**：Scene 顺序只读 `/scenes/*.yaml → order`（§17.1 / Story 5）；
 * - **不实现 `story_state.characters`**（v0.1 已删除 `characters[].notes`，Story 5 明确不实现该集合）；
 * - `knowledge_state` 不复制 truth，只保存 `blueprint_ref` 与运行时可见状态（§13 / Story 5）；
 * - `occurred` 使用 tagged union + 确定性 ID（§18.1），ID 形态：
 *   `OCC_K_<knowledge_id>_<scene_id>` / `OCC_REL_<relationship_id>_<scene_id>`；
 * - OQ-13 裁决：`state_rebuild_conflicts[]` 项含 `resolution_note: string | null`；
 * - OQ-06 裁决：occurred payload 用 `knowledge_ref` / `relationship_ref`，
 *   而 `knowledge_state[].blueprint_ref` / `relationship_state[].blueprint_ref` 保持不变（指向同一 ID）。
 */

export const STORY_STATE_SCHEMA_VERSION = '0.1'

export const OPEN_QUESTION_STATES = ['open', 'resolved'] as const
export const openQuestionStateSchema = z.enum(OPEN_QUESTION_STATES)

/** §17：open_questions.resolution_ref 使用 `{type: blueprint_item | scene, ref_id}`。 */
export const resolutionRefSchema = z
  .strictObject({
    type: z.enum(['blueprint_item', 'scene']),
    ref_id: z.string().min(1),
  })
  .superRefine((ref, ctx) => {
    if (ref.type === 'scene' && !ID_PATTERNS.scene.test(ref.ref_id)) {
      ctx.addIssue({ code: 'custom', path: ['ref_id'], message: `type=scene 的 ref_id 必须是 scene-###（收到 ${ref.ref_id}）` })
    }
    if (ref.type === 'blueprint_item' && !ID_PATTERNS.blueprintItem.test(ref.ref_id) && !ID_PATTERNS.keyKnowledge.test(ref.ref_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref_id'],
        message: `type=blueprint_item 的 ref_id 必须是 BP_* 或 K###（收到 ${ref.ref_id}）`,
      })
    }
  })

export const openQuestionProjectionSchema = z
  .strictObject({
    seed_ref: z.string().regex(ID_PATTERNS.seedQuestion, 'seed_ref 必须形如 SEED_Q001'),
    value: z.string().min(1),
    state: openQuestionStateSchema,
    /** 未解决时为 null（§17 只给了 resolved 时的结构）。 */
    resolution_ref: resolutionRefSchema.nullable(),
  })
  .superRefine((question, ctx) => {
    if (question.state === 'resolved' && question.resolution_ref === null) {
      ctx.addIssue({ code: 'custom', path: ['resolution_ref'], message: 'state=resolved 时必须给出 resolution_ref' })
    }
    if (question.state === 'open' && question.resolution_ref !== null) {
      ctx.addIssue({ code: 'custom', path: ['resolution_ref'], message: 'state=open 时必须省略 resolution_ref（置为 null）' })
    }
  })

export const knowledgeStateSchema = z.strictObject({
  blueprint_ref: z.string().regex(ID_PATTERNS.keyKnowledge, 'blueprint_ref 必须是 K###'),
  known_by: z.record(z.string().regex(ID_PATTERNS.character, 'known_by 的 key 必须是 CH_* 角色 ID'), z.boolean()),
  reader_knows: z.boolean(),
  occurred_reveal: z.boolean(),
  last_updated_scene: z.string().regex(ID_PATTERNS.scene, 'last_updated_scene 必须是 scene-###').nullable(),
})

export const relationshipStateSchema = z.strictObject({
  blueprint_ref: z.string().regex(ID_PATTERNS.relationship, 'blueprint_ref 必须是 REL_*'),
  state: z.string().min(1),
  last_updated_scene: z.string().regex(ID_PATTERNS.scene, 'last_updated_scene 必须是 scene-###').nullable(),
})

export const FORESHADOWING_STATES = ['planned', 'setup_written', 'paid_off'] as const
export const foreshadowingStateSchema = z.strictObject({
  blueprint_ref: z.string().regex(ID_PATTERNS.blueprintItem, 'blueprint_ref 必须是 BP_*'),
  resolved_setup_scene: z.string().regex(ID_PATTERNS.scene, 'resolved_setup_scene 必须是 scene-###').nullable(),
  resolved_payoff_scene: z.string().regex(ID_PATTERNS.scene, 'resolved_payoff_scene 必须是 scene-###').nullable(),
  state: z.enum(FORESHADOWING_STATES),
})

/** OQ-13 裁决：重建冲突（ORPHANED 不删除，重建继续）。 */
export const stateRebuildConflictSchema = z.strictObject({
  id: z.string().regex(/^SRC_\d{3}$/, 'state rebuild conflict ID 必须形如 SRC_001'),
  type: z.literal('ORPHANED'),
  ref_type: z.enum(['knowledge', 'relationship', 'foreshadowing', 'scene', 'seed_question']),
  ref_id: z.string().min(1),
  blueprint_version: z.number().int().min(1),
  message: z.string().min(1),
  /** OQ-13：允许记录用户处理说明；null 表示未处理（未处理时禁止 Context Compile，§17.3）。 */
  resolution_note: z.string().nullable(),
})

const occurredBaseShape = {
  scene_id: z.string().regex(ID_PATTERNS.scene, 'scene_id 必须是 scene-###'),
  status: z.literal('OCCURRED'),
  source: z.literal('final_text'),
  source_ref: z.string().min(1),
}

/** §18.1 + Story 10 B：knowledge_reveal → payload.knowledge_ref（+ revealed_to）。 */
export const knowledgeRevealSchema = z.strictObject({
  ...occurredBaseShape,
  id: z.string().regex(ID_PATTERNS.occurredKnowledge, 'ID 必须形如 OCC_K_<knowledge_id>_<scene_id>'),
  type: z.literal('knowledge_reveal'),
  payload: z.strictObject({
    knowledge_ref: z.string().regex(ID_PATTERNS.keyKnowledge, 'payload.knowledge_ref 必须是 K###'),
    revealed_to: z.array(z.string().regex(ID_PATTERNS.character, 'revealed_to 元素必须是 CH_* 角色 ID')),
  }),
})

/** §18.1 + Story 10 B：relationship_change → payload.relationship_ref + from_state / to_state。 */
export const relationshipChangeSchema = z.strictObject({
  ...occurredBaseShape,
  id: z.string().regex(ID_PATTERNS.occurredRelationship, 'ID 必须形如 OCC_REL_<relationship_id>_<scene_id>'),
  type: z.literal('relationship_change'),
  payload: z.strictObject({
    relationship_ref: z.string().regex(ID_PATTERNS.relationship, 'payload.relationship_ref 必须是 REL_*'),
    from_state: z.string().min(1),
    to_state: z.string().min(1),
  }),
})

export const occurredSchema = z.discriminatedUnion('type', [knowledgeRevealSchema, relationshipChangeSchema])
export type Occurred = z.infer<typeof occurredSchema>

export const storyStateSchema = z.strictObject({
  schema_version: z.literal(STORY_STATE_SCHEMA_VERSION),
  blueprint_version: z.number().int().min(1),
  confirmed_scenes: z.array(z.string().regex(ID_PATTERNS.scene, 'confirmed_scenes 元素必须是 scene-###')),
  occurred: z.array(occurredSchema),
  knowledge_state: z.array(knowledgeStateSchema),
  relationship_state: z.array(relationshipStateSchema),
  open_questions: z.array(openQuestionProjectionSchema),
  foreshadowing_state: z.array(foreshadowingStateSchema),
  state_rebuild_conflicts: z.array(stateRebuildConflictSchema),
})
export type StoryState = z.infer<typeof storyStateSchema>

export class StoryStateValidationError extends Error {
  override readonly name = 'StoryStateValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`story_state.yaml 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateStoryState(value: unknown): StoryState {
  const parsed = storyStateSchema.safeParse(value)
  if (!parsed.success) {
    throw new StoryStateValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  // 结构性约束：ID 唯一 / confirmed_scenes 去重 / occurred 确定性 ID 幂等
  const detail: string[] = []
  const occurredIds = parsed.data.occurred.map((entry) => entry.id)
  if (new Set(occurredIds).size !== occurredIds.length) {
    detail.push('occurred 的 ID 必须唯一（确定性 ID 的 upsert 语义，§18.1）')
  }
  const knowledgeRefs = parsed.data.knowledge_state.map((entry) => entry.blueprint_ref)
  if (new Set(knowledgeRefs).size !== knowledgeRefs.length) detail.push('knowledge_state 的 blueprint_ref 必须唯一')
  const relationshipRefs = parsed.data.relationship_state.map((entry) => entry.blueprint_ref)
  if (new Set(relationshipRefs).size !== relationshipRefs.length) detail.push('relationship_state 的 blueprint_ref 必须唯一')
  const foreshadowingRefs = parsed.data.foreshadowing_state.map((entry) => entry.blueprint_ref)
  if (new Set(foreshadowingRefs).size !== foreshadowingRefs.length) detail.push('foreshadowing_state 的 blueprint_ref 必须唯一')
  const conflictIds = parsed.data.state_rebuild_conflicts.map((entry) => entry.id)
  if (new Set(conflictIds).size !== conflictIds.length) detail.push('state_rebuild_conflicts 的 ID 必须唯一')
  if (new Set(parsed.data.confirmed_scenes).size !== parsed.data.confirmed_scenes.length) {
    detail.push('confirmed_scenes 不允许重复')
  }
  if (detail.length > 0) throw new StoryStateValidationError(detail)
  return deepFreeze(parsed.data) as StoryState
}

/** §18.1 的确定性 ID 生成。 */
export function occurredKnowledgeId(knowledgeId: string, sceneId: string): string {
  return `OCC_K_${knowledgeId}_${sceneId}`
}

export function occurredRelationshipId(relationshipId: string, sceneId: string): string {
  return `OCC_REL_${relationshipId}_${sceneId}`
}
