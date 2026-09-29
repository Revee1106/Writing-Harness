import { ARC_IDS, ARC_KEYS, STRUCTURE_IDS, STRUCTURE_KEYS, type Blueprint } from '../schema/blueprint.ts'
import type { Scene } from '../schema/scene.ts'
import type { SeedFile } from '../schema/seed.ts'
import {
  STORY_STATE_SCHEMA_VERSION,
  occurredKnowledgeId,
  occurredRelationshipId,
  validateStoryState,
  type Occurred,
  type StoryState,
} from '../schema/story-state.ts'
import { resolveStructure, sortScenesByOrder } from './resolver.ts'
import { deepFreeze } from '../core/freeze.ts'

/**
 * Story State 初始化与重建 —— 需求规格 §17（含 §17.1 初始化、§17.3 Blueprint Version 重建）；Story 5。
 *
 * - 运行时投影：不复制 Blueprint 的 CONFIRMED 内容；
 * - 不持久化 timeline：Scene 顺序只读 `/scenes/*.yaml → order`；
 * - 不实现 `story_state.characters`；
 * - `occurred` 使用确定性 ID，重跑按 ID upsert（§18.1 / Story 5 验收 9）。
 */

export interface InitStoryStateInput {
  readonly blueprint: Blueprint
  readonly scenes: readonly Scene[]
  readonly seed: SeedFile
}

export function initStoryState(input: InitStoryStateInput): StoryState {
  const { blueprint, scenes, seed } = input
  const resolution = resolveStructure(blueprint, scenes)

  const state: StoryState = {
    schema_version: STORY_STATE_SCHEMA_VERSION,
    blueprint_version: blueprint.blueprint_version,
    confirmed_scenes: [],
    occurred: [],
    knowledge_state: blueprint.key_knowledge.map((knowledge) => ({
      blueprint_ref: knowledge.id,
      known_by: { ...knowledge.known_by },
      reader_knows: knowledge.reader_knows,
      occurred_reveal: false,
      last_updated_scene: null,
    })),
    relationship_state: blueprint.characters.flatMap((character) =>
      character.relationships.map((relationship) => ({
        blueprint_ref: relationship.id,
        state: relationship.state,
        last_updated_scene: null,
      })),
    ),
    open_questions: seed.story_seed.open_questions.map((question) => ({
      seed_ref: question.id,
      value: question.value,
      state: 'open' as const,
      resolution_ref: null,
    })),
    foreshadowing_state: resolution.foreshadowing.map((item) => ({
      blueprint_ref: item.foreshadowing_id,
      resolved_setup_scene: item.resolved_setup_scene,
      resolved_payoff_scene: item.resolved_payoff_scene,
      state: 'planned' as const,
    })),
    state_rebuild_conflicts: [],
  }
  return validateStoryState(state)
}

export interface RebuildStoryStateInput {
  readonly blueprint: Blueprint
  readonly scenes: readonly Scene[]
  readonly seed: SeedFile
  /** 上一个版本的 State：`occurred` 与 `confirmed_scenes` 会被保留（§17.3）。 */
  readonly previous: StoryState | null
}

export interface RebuildStoryStateResult {
  readonly state: StoryState
  /** 本次重建新产生的 ORPHANED 冲突（不删除，重建继续）。 */
  readonly newConflicts: readonly StoryState['state_rebuild_conflicts'][number][]
}

/**
 * §17.3 Blueprint Version 重建：
 * 1. `occurred` / `confirmed_scenes` 保留；
 * 2. 运行时投影从新 Blueprint / 新 Scene Resolution 重新初始化；
 * 3. `occurred` 按 `Scene.order` 重放（同一 Scene 内按数组物理顺序）；
 * 4. 引用失效产生 ORPHANED `state_rebuild_conflict`（不删除，重建继续）；
 * 5. 未处理 ORPHANED 时禁止 Context Compile（由 `assertNoUnresolvedOrphans()` 承担）。
 */
export function rebuildStoryState(input: RebuildStoryStateInput): RebuildStoryStateResult {
  const fresh = initStoryState({ blueprint: input.blueprint, scenes: input.scenes, seed: input.seed })
  const previous = input.previous
  if (previous === null) {
    return { state: fresh, newConflicts: [] }
  }

  const sceneOrder = new Map(sortScenesByOrder(input.scenes).map((scene) => [scene.scene_id, scene.order]))
  const knownKnowledge = new Set(input.blueprint.key_knowledge.map((knowledge) => knowledge.id))
  const knownRelationships = new Set(
    input.blueprint.characters.flatMap((character) => character.relationships.map((relationship) => relationship.id)),
  )

  const conflicts: StoryState['state_rebuild_conflicts'][number][] = [...previous.state_rebuild_conflicts]
  const nextConflictId = (): string => `SRC_${String(conflicts.length + 1).padStart(3, '0')}`

  // occurred 按 Scene.order 重放；同一 Scene 内按数组物理顺序
  const replayable = previous.occurred
    .map((entry, index) => ({ entry, index, order: sceneOrder.get(entry.scene_id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.order === b.order ? a.index - b.index : a.order - b.order))

  const replayed: Occurred[] = []
  const knowledgeState = new Map(
    fresh.knowledge_state.map((entry) => [entry.blueprint_ref, { ...entry, known_by: { ...entry.known_by } }]),
  )
  const relationshipState = new Map(fresh.relationship_state.map((entry) => [entry.blueprint_ref, { ...entry }]))
  const knownScenes = new Set(input.scenes.map((scene) => scene.scene_id))

  for (const { entry } of replayable) {
    if (!knownScenes.has(entry.scene_id)) {
      conflicts.push({
        id: nextConflictId(),
        type: 'ORPHANED',
        ref_type: 'scene',
        ref_id: entry.scene_id,
        blueprint_version: input.blueprint.blueprint_version,
        message: `occurred ${entry.id} 引用的 Scene ${entry.scene_id} 在新版本中已不存在（不删除该 occurred，重建继续；§17.3）`,
        resolution_note: null,
      })
      continue
    }
    if (entry.type === 'knowledge_reveal') {
      if (!knownKnowledge.has(entry.payload.knowledge_ref)) {
        conflicts.push({
          id: nextConflictId(),
          type: 'ORPHANED',
          ref_type: 'knowledge',
          ref_id: entry.payload.knowledge_ref,
          blueprint_version: input.blueprint.blueprint_version,
          message: `occurred ${entry.id} 引用的 Key Knowledge ${entry.payload.knowledge_ref} 在新 Blueprint 中已不存在`,
          resolution_note: null,
        })
        continue
      }
      for (const characterId of entry.payload.revealed_to) {
        const projection = knowledgeState.get(entry.payload.knowledge_ref)
        if (projection !== undefined && characterId in projection.known_by) {
          projection.known_by[characterId] = true
        }
      }
      const projection = knowledgeState.get(entry.payload.knowledge_ref)
      if (projection !== undefined) {
        projection.occurred_reveal = true
        projection.last_updated_scene = entry.scene_id
      }
    } else {
      if (!knownRelationships.has(entry.payload.relationship_ref)) {
        conflicts.push({
          id: nextConflictId(),
          type: 'ORPHANED',
          ref_type: 'relationship',
          ref_id: entry.payload.relationship_ref,
          blueprint_version: input.blueprint.blueprint_version,
          message: `occurred ${entry.id} 引用的 relationship ${entry.payload.relationship_ref} 在新 Blueprint 中已不存在`,
          resolution_note: null,
        })
        continue
      }
      const projection = relationshipState.get(entry.payload.relationship_ref)
      if (projection !== undefined) {
        projection.state = entry.payload.to_state
        projection.last_updated_scene = entry.scene_id
      }
    }
    replayed.push(entry)
  }

  // confirmed_scenes 保留（§17.3），但已消失的 Scene 记为 ORPHANED
  const confirmedScenes: string[] = []
  for (const sceneId of previous.confirmed_scenes) {
    if (knownScenes.has(sceneId)) {
      confirmedScenes.push(sceneId)
    } else {
      conflicts.push({
        id: nextConflictId(),
        type: 'ORPHANED',
        ref_type: 'scene',
        ref_id: sceneId,
        blueprint_version: input.blueprint.blueprint_version,
        message: `confirmed_scenes 中的 ${sceneId} 在新版本中已不存在（保留历史记录，同时产生 ORPHANED；§17.3）`,
        resolution_note: null,
      })
      confirmedScenes.push(sceneId)
    }
  }

  const state = validateStoryState({
    ...fresh,
    confirmed_scenes: confirmedScenes,
    occurred: replayed,
    knowledge_state: [...knowledgeState.values()],
    relationship_state: [...relationshipState.values()],
    state_rebuild_conflicts: conflicts,
  })
  return { state, newConflicts: conflicts.slice(previous.state_rebuild_conflicts.length) }
}

/** §17.3：未处理 ORPHANED 时禁止 Context Compile。 */
export function unresolvedOrphans(state: StoryState): StoryState['state_rebuild_conflicts'] {
  return state.state_rebuild_conflicts.filter((conflict) => conflict.resolution_note === null)
}

export class UnresolvedOrphanError extends Error {
  override readonly name = 'UnresolvedOrphanError'
  constructor(ids: readonly string[]) {
    super(
      `存在未处理的 ORPHANED 重建冲突（${ids.join(', ')}）：处理前禁止 Context Compile（需求规格 §17.3）`,
    )
  }
}

export function assertNoUnresolvedOrphans(state: StoryState): void {
  const orphans = unresolvedOrphans(state)
  if (orphans.length > 0) {
    throw new UnresolvedOrphanError(orphans.map((conflict) => conflict.id))
  }
}

// ---------------------------------------------------------------------------
// OCCURRED（§18.1；Story 5 只要求"确定性 ID + 可重跑不重复"）
// ---------------------------------------------------------------------------

export interface KnowledgeRevealInput {
  readonly knowledge_ref: string
  readonly scene_id: string
  readonly revealed_to: readonly string[]
  readonly source_ref: string
}

export interface RelationshipChangeInput {
  readonly relationship_ref: string
  readonly scene_id: string
  readonly from_state: string
  readonly to_state: string
  readonly source_ref: string
}

export function makeKnowledgeReveal(input: KnowledgeRevealInput): Occurred {
  return {
    id: occurredKnowledgeId(input.knowledge_ref, input.scene_id),
    type: 'knowledge_reveal',
    scene_id: input.scene_id,
    status: 'OCCURRED',
    source: 'final_text',
    source_ref: input.source_ref,
    payload: { knowledge_ref: input.knowledge_ref, revealed_to: [...input.revealed_to] },
  }
}

export function makeRelationshipChange(input: RelationshipChangeInput): Occurred {
  return {
    id: occurredRelationshipId(input.relationship_ref, input.scene_id),
    type: 'relationship_change',
    scene_id: input.scene_id,
    status: 'OCCURRED',
    source: 'final_text',
    source_ref: input.source_ref,
    payload: {
      relationship_ref: input.relationship_ref,
      from_state: input.from_state,
      to_state: input.to_state,
    },
  }
}

/** §18.1：重跑按 ID upsert（不生成重复记录）。 */
export function upsertOccurred(state: StoryState, entries: readonly Occurred[]): StoryState {
  const byId = new Map(state.occurred.map((entry) => [entry.id, entry]))
  for (const entry of entries) {
    byId.set(entry.id, entry)
  }
  const sceneOrder = new Map<string, number>()
  const orderOf = (sceneId: string): number => sceneOrder.get(sceneId) ?? Number.MAX_SAFE_INTEGER
  const merged = [...byId.values()].sort((a, b) => {
    const diff = orderOf(a.scene_id) - orderOf(b.scene_id)
    return diff !== 0 ? diff : a.id.localeCompare(b.id)
  })
  return validateStoryState({ ...state, occurred: merged })
}

export function freezeStoryState(state: StoryState): StoryState {
  return deepFreeze(state) as StoryState
}

export { STRUCTURE_IDS, STRUCTURE_KEYS, ARC_IDS, ARC_KEYS }
