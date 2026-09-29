import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { takeLastNonWhitespaceCodePoints } from '../core/text.ts'
import { TONE_TAGS } from '../core/scene-types.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { loadBlueprint, loadSeed } from '../project/project.ts'
import type { Blueprint } from '../schema/blueprint.ts'
import type { Scene } from '../schema/scene.ts'
import type { SeedFile } from '../schema/seed.ts'
import type { StoryState } from '../schema/story-state.ts'
import type { ProjectConfig } from '../schema/project-config.ts'
import {
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  validateContextManifest,
  type ContextManifest,
  type ExclusionReason,
} from '../schema/context-manifest.ts'
import {
  createEmptyStyleProfile,
  sampleTextForWriter,
  validateStyleProfile,
  type StyleProfile,
  type StyleSample,
} from '../schema/style-profile.ts'
import { validateProjectConfig } from '../schema/project-config.ts'
import { readYamlFile } from '../io/yaml.ts'
import { loadScenes, loadStoryState } from '../scenes/service.ts'
import { assertNoUnresolvedOrphans } from '../scenes/state.ts'
import { sortScenesByOrder } from '../scenes/resolver.ts'

/**
 * Context Compiler + POV Filter —— 需求规格 §19–§23；架构设计 §19–§24；Story 6。
 *
 * **数据源白名单**（§20.1 / 架构设计 §20）——只允许读取：
 * ```text
 * blueprint.yaml / story_state.yaml / 当前 scene / 项目配置 / style samples / 必需的 Draft Context
 * ```
 * **绝不读取 `proposals.yaml`**：未确认 Proposal 通过数据源物理隔离，而不是靠"识别并过滤"。
 *
 * 输出：`writer_context` + `context_manifest`（§21）。
 */

export class ContextCompileError extends Error {
  override readonly name = 'ContextCompileError'
  constructor(message: string) {
    super(message)
  }
}

export interface CompileContextOptions {
  readonly paths: ProjectPaths
  readonly sceneId: string
  /** 用户在 Compiler 降级路径补充的 director note（§22；source=user_override）。 */
  readonly userNotes?: readonly string[] | undefined
}

export interface WriterContextCharacter {
  readonly id: string
  readonly name: string
  readonly role: string
  /** 只有当前 POV 可见时才包含内心状态（desire / fear / contradiction / voice_hint）。 */
  readonly inner_state?: {
    readonly desire: string
    readonly fear: string
    readonly contradiction: string
    readonly voice_hint: string
  } | undefined
  readonly observable_behavior_hints: readonly { readonly id: string; readonly value: string }[]
  readonly relationships: readonly {
    readonly id: string
    readonly target: string
    readonly kind: string
    readonly state: string
  }[]
}

export interface WriterContext {
  readonly scene_id: string
  readonly blueprint_version: number
  readonly pov: string
  readonly scene: {
    readonly scene_id: string
    readonly order: number
    readonly scene_type: string
    readonly purpose: string
    readonly target_length: number
    readonly narrative_role_ref: string
    readonly location: string
    readonly start_state: string
    readonly conflict: string
    readonly turn: string
    readonly end_state: string
  }
  readonly characters: readonly WriterContextCharacter[]
  readonly premise: string
  readonly theme: readonly string[]
  readonly core_conflict: string
  readonly structure_context: Readonly<Record<string, string | null>>
  readonly arc_context: Readonly<Record<string, string | null>>
  /** 只有本场允许 reveal 的真相（§15.6）。 */
  readonly allowed_reveals: readonly {
    readonly id: string
    readonly truth: string
    readonly reveal_to: readonly string[]
    readonly reveal_to_reader: boolean
  }[]
  /** 当前 POV 在本场开场时已知的 Key Knowledge（§17.2 planned_knowledge_view）。 */
  readonly known_knowledge_ids: readonly string[]
  readonly style_direction: { readonly narration: string; readonly dialogue: string; readonly rhythm: string }
  readonly style_samples: readonly { readonly sample_id: string; readonly text: string; readonly matched_on: readonly string[] }[]
  readonly director_surface: readonly { readonly id: string; readonly instruction: string; readonly source: string }[]
  readonly draft_context: { readonly scene_id: string; readonly text: string; readonly counted_code_points: number } | null
}

export interface CompileContextResult {
  readonly writerContext: WriterContext
  readonly manifest: ContextManifest
  /** POV 在本场开场的知识视图（§17.2；临时计算，不持久化）。 */
  readonly plannedKnowledgeView: Readonly<Record<string, boolean>>
}

/** §23.1 Style Sample 匹配降级顺序。 */
export const STYLE_MATCH_ORDER = ['pov+scene_type+tone', 'pov+scene_type', 'pov', 'none'] as const
export type StyleMatchLevel = (typeof STYLE_MATCH_ORDER)[number]

/**
 * Scene 的 tone 标签集合。
 *
 * 说明（OQ-47，dsh 提议待复核）：§14 的 Scene Schema **没有** tone 字段，
 * 但 §11.3（OBH）与 §23.1（Style Sample）都要按 `scene_type ∪ tone` 匹配。
 * 在"不新增 Schema 字段"的前提下，这里把 tone 判定为"Scene 自身文本中出现的标签词"：
 * 逐条扫描 `purpose` / `conflict` / `turn` / `start_state` / `end_state` / `location` 与 director notes，
 * 命中 `TONE_TAGS` 的标签即视为该场景的 tone。
 */
export function sceneToneTags(scene: Scene): string[] {
  const haystack = [
    scene.purpose,
    scene.conflict,
    scene.turn,
    scene.start_state,
    scene.end_state,
    scene.location,
    ...scene.director_notes.map((note) => note.instruction),
  ].join(' ')
  return TONE_TAGS.filter((tag) => haystack.includes(tag))
}

/** 当前场景的匹配标签集合：scene_type ∪ tone（OQ-36 / OQ-41）。 */
export function sceneMatchTags(scene: Scene): string[] {
  return [...new Set([scene.scene_type, ...sceneToneTags(scene)])]
}

/** §23.1：按降级顺序挑选最多 2～3 个样本。 */
export function selectStyleSamples(
  profile: StyleProfile,
  scene: Scene,
): { readonly samples: readonly StyleSample[]; readonly matchedOn: readonly string[]; readonly level: StyleMatchLevel } {
  const tones = sceneToneTags(scene)
  const levels: Array<{ level: StyleMatchLevel; matchedOn: string[]; predicate: (sample: StyleSample) => boolean }> = [
    {
      level: 'pov+scene_type+tone',
      matchedOn: ['pov', 'scene_type', 'tone'],
      predicate: (sample) =>
        sample.tags.pov === scene.pov && sample.tags.scene_type === scene.scene_type && tones.includes(sample.tags.tone),
    },
    {
      level: 'pov+scene_type',
      matchedOn: ['pov', 'scene_type'],
      predicate: (sample) => sample.tags.pov === scene.pov && sample.tags.scene_type === scene.scene_type,
    },
    { level: 'pov', matchedOn: ['pov'], predicate: (sample) => sample.tags.pov === scene.pov },
  ]
  for (const candidate of levels) {
    const matches = profile.samples.filter(candidate.predicate)
    if (matches.length > 0) {
      return { samples: matches.slice(0, 3), matchedOn: candidate.matchedOn, level: candidate.level }
    }
  }
  return { samples: [], matchedOn: [], level: 'none' }
}

/** §19.1 Draft Context：当前 Scene 之前最近的"相同 POV" Scene Draft，只取末尾 N 个非空白码点。 */
export function selectDraftContext(
  options: { readonly paths: ProjectPaths; readonly scene: Scene; readonly scenes: readonly Scene[]; readonly maxChars: number },
): { readonly scene_id: string; readonly text: string; readonly counted_code_points: number } | null {
  const { paths, scene, scenes, maxChars } = options
  const previous = sortScenesByOrder(scenes).filter(
    (candidate) => candidate.order < scene.order && candidate.pov === scene.pov,
  )
  // 从最近的一个往前找，取第一个存在 Draft 文件的
  for (const candidate of [...previous].reverse()) {
    const file = join(paths.draftsDir, `${candidate.scene_id}.md`)
    if (!existsSync(file)) continue
    const raw = readFileSync(file, 'utf8')
    const truncated = takeLastNonWhitespaceCodePoints(raw, maxChars)
    if (truncated.text.trim() === '') continue
    return { scene_id: candidate.scene_id, text: truncated.text, counted_code_points: truncated.countedCodePoints }
  }
  return null
}

function loadStyleProfile(paths: ProjectPaths): StyleProfile {
  if (!existsSync(paths.styleProfile)) return createEmptyStyleProfile()
  return validateStyleProfile(readYamlFile(paths.styleProfile))
}

export interface PlannedKnowledgeView {
  readonly knowledgeId: string
  readonly povKnows: boolean
  readonly source: 'confirmed_state' | 'planned'
}

/**
 * §17.2 planned_knowledge_view：当前 Scene 开始时，POV 是否已经知道 Kx。
 * - 相关 reveal Scene 已 confirmed → 用 `knowledge_state.known_by`；
 * - 尚未 confirmed → 用 Blueprint 初始 known_by + resolved reveal Scene.order + reveal_to + current Scene.order 推导；
 * - **当前 Scene 本身是 reveal Scene 时，开场仍视为未 reveal**。
 */
export function computePlannedKnowledgeView(
  blueprint: Blueprint,
  scenes: readonly Scene[],
  state: StoryState,
  scene: Scene,
): PlannedKnowledgeView[] {
  const orderedScenes = sortScenesByOrder(scenes)
  const orderOf = new Map(orderedScenes.map((candidate) => [candidate.scene_id, candidate.order]))
  return blueprint.key_knowledge.map((knowledge) => {
    const projection = state.knowledge_state.find((entry) => entry.blueprint_ref === knowledge.id)
    const revealScene = orderedScenes.find((candidate) => candidate.allowed_reveals.includes(knowledge.id))
    const revealConfirmed = revealScene !== undefined && state.confirmed_scenes.includes(revealScene.scene_id)

    if (revealConfirmed) {
      return {
        knowledgeId: knowledge.id,
        povKnows: projection?.known_by[scene.pov] ?? knowledge.known_by[scene.pov] ?? false,
        source: 'confirmed_state' as const,
      }
    }
    // 尚未 confirmed：用初始 known_by + 计划揭示位置推导（本场是 reveal 场时，开场仍视为未 reveal）
    const initial = knowledge.known_by[scene.pov] ?? false
    if (initial) {
      return { knowledgeId: knowledge.id, povKnows: true, source: 'planned' as const }
    }
    if (revealScene === undefined || !knowledge.reveal_to.includes(scene.pov)) {
      return { knowledgeId: knowledge.id, povKnows: false, source: 'planned' as const }
    }
    const revealOrder = orderOf.get(revealScene.scene_id) ?? Number.MAX_SAFE_INTEGER
    const knows = revealOrder < scene.order
    return { knowledgeId: knowledge.id, povKnows: knows, source: 'planned' as const }
  })
}

function relationshipsFor(blueprint: Blueprint, characterId: string): WriterContextCharacter['relationships'] {
  const character = blueprint.characters.find((candidate) => candidate.id === characterId)
  return (character?.relationships ?? []).map((relationship) => ({
    id: relationship.id,
    target: relationship.target,
    kind: relationship.kind,
    state: relationship.state,
  }))
}

export function compileContext(options: CompileContextOptions): CompileContextResult {
  const { paths, sceneId } = options
  if (!existsSync(paths.blueprint)) {
    throw new ContextCompileError(`找不到 ${paths.blueprint}；请先完成 Gate 2`)
  }
  const blueprint = loadBlueprint(paths)
  const scenes = loadScenes(paths)
  const scene = scenes.find((candidate) => candidate.scene_id === sceneId)
  if (scene === undefined) {
    throw new ContextCompileError(`找不到 ${sceneId}（可用：${scenes.map((candidate) => candidate.scene_id).join(' / ')}）`)
  }
  const state = loadStoryState(paths)
  if (state === null) {
    throw new ContextCompileError(`找不到 ${paths.storyState}；请先执行 harness breakdown`)
  }
  // §17.3：未处理 ORPHANED 时禁止 Context Compile
  assertNoUnresolvedOrphans(state)

  const seed: SeedFile = loadSeed(paths)
  // 数据源白名单：项目配置只用于读取 draft_context.max_chars
  const config: ProjectConfig = validateProjectConfig(readYamlFile(paths.projectConfig))
  const profile = loadStyleProfile(paths)
  void seed

  const plannedView = computePlannedKnowledgeView(blueprint, scenes, state, scene)
  const matchTags = sceneMatchTags(scene)

  const includedSensitive: ContextManifest['included_sensitive'][number][] = []
  const excludedSensitive: ContextManifest['excluded_sensitive'][number][] = []

  // ---- 角色与 POV 过滤（架构设计 §21：物理执行，不依赖 Prompt 自律） ----
  const sceneCharacters = new Set<string>([scene.pov, ...scene.characters])
  const characters: WriterContextCharacter[] = []
  for (const character of blueprint.characters) {
    if (!sceneCharacters.has(character.id)) continue
    const innerVisible = character.inner_state_pov_visible.includes(scene.pov)
    const hints = character.observable_behavior_hints
      .filter((hint) => hint.applicable_scene_types.some((tag) => matchTags.includes(tag)))
      .map((hint) => ({ id: hint.id, value: hint.value }))
    characters.push({
      id: character.id,
      name: character.name,
      role: character.role,
      inner_state: innerVisible
        ? {
            desire: character.desire,
            fear: character.fear,
            contradiction: character.contradiction,
            voice_hint: character.voice_hint,
          }
        : undefined,
      observable_behavior_hints: hints,
      relationships: relationshipsFor(blueprint, character.id).filter((relationship) =>
        sceneCharacters.has(relationship.target),
      ),
    })
    if (innerVisible) {
      includedSensitive.push({
        id: character.id,
        type: 'key_knowledge',
        source_ref: `blueprint.characters.${character.id}.inner_state`,
        reason: '当前 POV 可以看到该角色的内心状态（inner_state_pov_visible 命中）',
      })
    } else {
      // 非当前 POV 角色的完整内心：物理不进入 Writer Context
      excludedSensitive.push({
        id: `${character.id}.inner_state`,
        type: 'future_content',
        source_ref: `blueprint.characters.${character.id}`,
        reason: 'non_pov_inner_state',
      })
    }
  }
  // 未出场角色的内心也必须隔离（同属 non_pov_inner_state）
  for (const character of blueprint.characters) {
    if (sceneCharacters.has(character.id)) continue
    excludedSensitive.push({
      id: `${character.id}.inner_state`,
      type: 'future_content',
      source_ref: `blueprint.characters.${character.id}`,
      reason: 'non_pov_inner_state',
    })
  }

  // ---- Key Knowledge：allowed_reveals 只决定"本场是否允许 reveal" ----
  const allowedReveals = blueprint.key_knowledge
    .filter((knowledge) => scene.allowed_reveals.includes(knowledge.id))
    .map((knowledge) => ({
      id: knowledge.id,
      truth: knowledge.truth,
      reveal_to: [...knowledge.reveal_to],
      reveal_to_reader: knowledge.reveal_to_reader,
    }))
  for (const knowledge of blueprint.key_knowledge) {
    if (scene.allowed_reveals.includes(knowledge.id)) {
      includedSensitive.push({
        id: knowledge.id,
        type: 'key_knowledge',
        source_ref: `blueprint.key_knowledge.${knowledge.id}`,
        reason: '本场 allowed_reveals 命中：允许在本场发生该 reveal（§15.5 / §15.6）',
      })
      continue
    }
    const view = plannedView.find((candidate) => candidate.knowledgeId === knowledge.id)
    excludedSensitive.push({
      id: knowledge.id,
      type: 'key_knowledge',
      source_ref: `blueprint.key_knowledge.${knowledge.id}`,
      reason: view?.povKnows === true ? 'user_override' : 'not_revealed_yet',
    })
  }

  // ---- Foreshadowing：幕后解释不进 Context ----
  for (const item of blueprint.foreshadowing) {
    excludedSensitive.push({
      id: item.id,
      type: 'foreshadowing',
      source_ref: `blueprint.foreshadowing.${item.id}`,
      reason: 'foreshadowing_backstage',
    })
  }

  // ---- Director Surface（Story 6 起始会裁决的组装规则） ----
  const directorSurface: ContextManifest['director_surface'][number][] = []
  for (const note of scene.director_notes) {
    directorSurface.push({
      id: note.id,
      source_ref: note.source === 'blueprint' && note.blueprint_ref !== undefined
        ? `scene.${scene.scene_id}.director_notes.${note.id}->${note.blueprint_ref}`
        : `scene.${scene.scene_id}.director_notes.${note.id}`,
      instruction: note.instruction,
      source: note.source === 'user' ? 'user_override' : note.source,
    })
  }
  // Blueprint style_direction 整体一条（不拆 key_knowledge.truth / proposed_additions）
  directorSurface.push({
    id: 'DIR_BLUEPRINT_001',
    source_ref: `blueprint.style_direction.${blueprint.style_direction.id}`,
    instruction: `叙述：${blueprint.style_direction.narration}；对白：${blueprint.style_direction.dialogue}；节奏：${blueprint.style_direction.rhythm}`,
    source: 'blueprint',
  })

  const overrides: ContextManifest['overrides'][number][] = []
  const userNotes = options.userNotes ?? []
  userNotes.forEach((note, index) => {
    const id = `DIR_USER_${String(index + 1).padStart(3, '0')}`
    directorSurface.push({
      id,
      source_ref: `user_note.${scene.scene_id}.${id}`,
      instruction: note,
      source: 'user_override',
    })
    overrides.push({
      id: `OVR_${String(index + 1).padStart(3, '0')}`,
      director_surface_ref: id,
      note,
      source: 'user',
    })
  })
  // 已在 Scene 上持久化的用户 note（source=user）同样按 user_override 进 overrides
  for (const entry of directorSurface.filter((candidate) => candidate.source === 'user_override' && candidate.id.startsWith('DIR_USER_'))) {
    if (overrides.some((override) => override.director_surface_ref === entry.id)) continue
    overrides.push({
      id: `OVR_${String(overrides.length + 1).padStart(3, '0')}`,
      director_surface_ref: entry.id,
      note: entry.instruction,
      source: 'user',
    })
  }

  // ---- Style Samples（§23.1 降级） ----
  const selection = selectStyleSamples(profile, scene)
  const styleSamples = selection.samples.map((sample) => ({
    sample_id: sample.sample_id,
    text: sampleTextForWriter(sample),
    matched_on: selection.matchedOn,
  }))

  // ---- Draft Context（§19.1） ----
  const draftContext = selectDraftContext({
    paths,
    scene,
    scenes,
    maxChars: config.draft_context.max_chars,
  })

  const writerContext: WriterContext = {
    scene_id: scene.scene_id,
    blueprint_version: blueprint.blueprint_version,
    pov: scene.pov,
    scene: {
      scene_id: scene.scene_id,
      order: scene.order,
      scene_type: scene.scene_type,
      purpose: scene.purpose,
      target_length: scene.target_length,
      narrative_role_ref: scene.narrative_role_ref,
      location: scene.location,
      start_state: scene.start_state,
      conflict: scene.conflict,
      turn: scene.turn,
      end_state: scene.end_state,
    },
    characters,
    premise: blueprint.premise.value,
    theme: [blueprint.theme.primary, ...blueprint.theme.secondary]
      .map((item) => item.value)
      .filter((value): value is string => value !== null),
    core_conflict: blueprint.core_conflict.value,
    structure_context: Object.fromEntries(
      Object.entries(blueprint.structure).map(([key, item]) => [item.id, item.value]),
    ),
    arc_context: Object.fromEntries(Object.entries(blueprint.arc).map(([key, item]) => [item.id, item.value])),
    allowed_reveals: allowedReveals,
    known_knowledge_ids: plannedView.filter((view) => view.povKnows).map((view) => view.knowledgeId),
    style_direction: {
      narration: blueprint.style_direction.narration,
      dialogue: blueprint.style_direction.dialogue,
      rhythm: blueprint.style_direction.rhythm,
    },
    style_samples: styleSamples,
    director_surface: directorSurface.map((entry) => ({
      id: entry.id,
      instruction: entry.instruction,
      source: entry.source,
    })),
    draft_context: draftContext,
  }

  const manifest = validateContextManifest({
    schema_version: CONTEXT_MANIFEST_SCHEMA_VERSION,
    scene_id: scene.scene_id,
    blueprint_version: blueprint.blueprint_version,
    pov: scene.pov,
    included_sensitive: includedSensitive,
    excluded_sensitive: excludedSensitive,
    director_surface: directorSurface,
    style_samples: styleSamples.map((sample) => ({ sample_id: sample.sample_id, matched_on: [...sample.matched_on] })),
    future_content_exposed: false,
    unconfirmed_proposal_exposed: false,
    overrides,
  })

  return {
    writerContext,
    manifest,
    plannedKnowledgeView: Object.fromEntries(plannedView.map((view) => [view.knowledgeId, view.povKnows])),
  }
}

/** Compile 一批 Scene（便于 CLI 与演示）；不写文件，只返回结果。 */
export function compileAllContexts(
  paths: ProjectPaths,
  options: { readonly userNotesByScene?: Readonly<Record<string, readonly string[]>> | undefined } = {},
): readonly CompileContextResult[] {
  return loadScenes(paths).map((scene) =>
    compileContext({ paths, sceneId: scene.scene_id, userNotes: options.userNotesByScene?.[scene.scene_id] }),
  )
}

export type { ExclusionReason }
