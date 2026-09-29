import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { hashContractInput } from '../core/hash.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { extractYamlBlock } from '../interpreter/schema.ts'
import { dumpYaml, readTextFile, writeTextFile, writeYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { loadBlueprint } from '../project/project.ts'
import { loadScenes, loadStoryState } from '../scenes/service.ts'
import { sortScenesByOrder } from '../scenes/resolver.ts'
import { makeKnowledgeReveal, makeRelationshipChange } from '../scenes/state.ts'
import { validateStoryState, type Occurred, type StoryState } from '../schema/story-state.ts'
import type { Blueprint } from '../schema/blueprint.ts'
import type { Scene } from '../schema/scene.ts'
import type { LinterProvider } from '../providers/types.ts'

/**
 * Gate 3 + State Extractor —— 需求规格 §5.3、§6.5、§18；架构设计 §18；Story 10。
 *
 * 流程（Story 10 起始会裁决）：
 * 1. `final.md` = 各 Scene Draft 按 `order` 拼接、**空行分隔、无标题、无元数据**；
 * 2. Gate 3 = **整篇一次性确认**（逐场确认属于 Story 9 的 Rewrite 范畴）；
 * 3. 确认后**全部 Scene 一次性写入** `confirmed_scenes`，`drafts/scene-NNN.md` **保留不删除**；
 * 4. State Extractor 提取候选 → Harness 结构校验 + 与计划/投影比对 → 冲突由用户裁决；
 * 5. OCCURRED 用确定性 ID upsert；同步更新 `knowledge_state` / `relationship_state` /
 *    `foreshadowing_state`（§18.4），并产生 high warning（payoff 已确认但 setup 未确认）。
 */

export const STATE_EXTRACTOR_CONTRACT_ID = 'state_extractor'
export const STATE_EXTRACTOR_CONTRACT_VERSION = '0.1'

export class Gate3Error extends Error {
  override readonly name = 'Gate3Error'
  constructor(message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Gate 3：final.md 拼接
// ---------------------------------------------------------------------------

/**
 * 按 order 拼接 drafts，空行分隔；不含标题、元数据、分隔符。
 *
 * 缺少 Draft（或 Draft 为空白）时**抛错而不是静默跳过**：
 * 静默跳过会让 final.md 少一场而 Gate 3 仍认为"整篇已确认"（P1/P4 的审计要求）。
 */
export function assembleFinalDraft(scenes: readonly Scene[], texts: Readonly<Record<string, string>>): string {
  const ordered = sortScenesByOrder(scenes)
  const missing = ordered
    .filter((scene) => (texts[scene.scene_id] ?? '').trim() === '')
    .map((scene) => scene.scene_id)
  if (missing.length > 0) {
    throw new Gate3Error(`缺少 Draft（或 Draft 为空）：${missing.join(', ')}；请先执行 harness write`)
  }
  return ordered.map((scene) => (texts[scene.scene_id] ?? '').replace(/\s+$/u, '')).join('\n\n')
}

export interface AssembleFinalResult {
  readonly finalText: string
  readonly sceneCount: number
  readonly missingSceneIds: readonly string[]
}

export function assembleFinalFromProject(paths: ProjectPaths): AssembleFinalResult {
  const scenes = sortScenesByOrder(loadScenes(paths))
  const texts: Record<string, string> = {}
  const missing: string[] = []
  for (const scene of scenes) {
    const file = join(paths.draftsDir, `${scene.scene_id}.md`)
    if (!existsSync(file)) {
      missing.push(scene.scene_id)
      continue
    }
    texts[scene.scene_id] = readTextFile(file)
  }
  return {
    finalText: assembleFinalDraft(scenes, texts),
    sceneCount: scenes.length,
    missingSceneIds: missing,
  }
}

// ---------------------------------------------------------------------------
// State Extractor 的候选契约
// ---------------------------------------------------------------------------

const rawCandidateSchema = z.strictObject({
  knowledge_reveals: z.array(
    z.strictObject({
      knowledge_ref: z.string().regex(/^K\d{3}$/, 'knowledge_ref 必须形如 K001'),
      scene_id: z.string().regex(/^scene-\d{3}$/, 'scene_id 必须形如 scene-001'),
      revealed_to: z.array(z.string().regex(/^CH_[A-Z0-9_]+$/)),
      evidence: z.string().min(1),
    }),
  ),
  relationship_changes: z.array(
    z.strictObject({
      relationship_ref: z.string().regex(/^REL_[A-Z0-9_]+$/),
      scene_id: z.string().regex(/^scene-\d{3}$/),
      from_state: z.string().min(1),
      to_state: z.string().min(1),
      evidence: z.string().min(1),
    }),
  ),
})
export type RawExtraction = z.infer<typeof rawCandidateSchema>

export class StateExtractorOutputError extends Error {
  override readonly name = 'StateExtractorOutputError'
  readonly detail: readonly string[]
  readonly rawOutput: string
  constructor(detail: readonly string[], rawOutput: string) {
    super(`State Extractor 输出不符合契约：\n- ${detail.join('\n- ')}`)
    this.detail = detail
    this.rawOutput = rawOutput
  }
}

export function parseExtraction(rawOutput: string): RawExtraction {
  let parsed: unknown
  try {
    parsed = parseYaml(extractYamlBlock(rawOutput))
  } catch (error) {
    throw new StateExtractorOutputError([`YAML 解析失败：${(error as Error).message}`], rawOutput)
  }
  const result = rawCandidateSchema.safeParse(parsed)
  if (!result.success) {
    throw new StateExtractorOutputError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      rawOutput,
    )
  }
  return result.data
}

export interface ExtractorPlan {
  readonly knowledge: readonly { readonly id: string; readonly truth: string; readonly reveal_to: readonly string[] }[]
  readonly relationships: readonly { readonly id: string; readonly state: string }[]
}

export function buildStateExtractorInput(
  blueprint: Blueprint,
  scenes: readonly Scene[],
  state: StoryState,
  texts: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  return {
    plan: {
      knowledge: blueprint.key_knowledge.map((knowledge) => ({
        id: knowledge.id,
        truth: knowledge.truth,
        reveal_to: [...knowledge.reveal_to],
      })),
      relationships: blueprint.characters.flatMap((character) =>
        character.relationships.map((relationship) => ({
          id: relationship.id,
          kind: relationship.kind,
          baseline_state: relationship.state,
        })),
      ),
    },
    projection: {
      confirmed_scenes: [...state.confirmed_scenes],
      knowledge_state: state.knowledge_state.map((entry) => ({
        blueprint_ref: entry.blueprint_ref,
        known_by: { ...entry.known_by },
        occurred_reveal: entry.occurred_reveal,
      })),
      relationship_state: state.relationship_state.map((entry) => ({
        blueprint_ref: entry.blueprint_ref,
        state: entry.state,
      })),
    },
    scenes: sortScenesByOrder(scenes).map((scene) => ({
      scene_id: scene.scene_id,
      order: scene.order,
      allowed_reveals: [...scene.allowed_reveals],
      text: texts[scene.scene_id] ?? '',
    })),
  }
}

// ---------------------------------------------------------------------------
// 候选 → OCCURRED（Harness 校验 + 冲突判定）
// ---------------------------------------------------------------------------

export interface OccurredConflict {
  readonly id: string
  readonly type: 'OCCURRED_CONFLICT'
  readonly ref_type: 'knowledge' | 'relationship' | 'scene' | 'foreshadowing' | 'seed_question'
  readonly ref_id: string
  readonly blueprint_version: number
  readonly message: string
  readonly resolution_note: string | null
}

export interface ExtractionComparison {
  readonly occurred: readonly Occurred[]
  readonly conflicts: readonly OccurredConflict[]
  readonly lowSeverity: readonly { readonly code: string; readonly message: string; readonly evidence: Record<string, unknown> }[]
}

let conflictSequence = 0
function nextConflictId(offset: number): string {
  conflictSequence += 1
  return `SRC_${String(offset + conflictSequence).padStart(3, '0')}`
}

/** 供测试重置编号（不参与运行时语义）。 */
export function resetConflictSequence(): void {
  conflictSequence = 0
}

/**
 * 比对规则（Story 10 起始会裁决 2）：
 * - `revealed_to` == Blueprint `reveal_to` → 正常；
 * - ⊊（真子集） → 正常 + `low_severity_log: {code: "revealed_to_narrower_than_plan"}`；
 * - ⊋（真超集） → **conflict**；
 * - 无交集 → **conflict**。
 * - `relationship_change.from_state` 从 `relationship_state` 读；候选若给出不同的 from_state → **conflict**。
 */
export function compareExtraction(
  extraction: RawExtraction,
  blueprint: Blueprint,
  state: StoryState,
  options: { readonly sourceRef: string; readonly conflictOffset: number },
): ExtractionComparison {
  const occurred: Occurred[] = []
  const conflicts: OccurredConflict[] = []
  const lowSeverity: { code: string; message: string; evidence: Record<string, unknown> }[] = []

  for (const candidate of extraction.knowledge_reveals) {
    const knowledge = blueprint.key_knowledge.find((item) => item.id === candidate.knowledge_ref)
    if (knowledge === undefined) {
      conflicts.push({
        id: nextConflictId(options.conflictOffset),
        type: 'OCCURRED_CONFLICT',
        ref_type: 'knowledge',
        ref_id: candidate.knowledge_ref,
        blueprint_version: blueprint.blueprint_version,
        message: `State Extractor 报出了不存在的 Key Knowledge：${candidate.knowledge_ref}`,
        resolution_note: null,
      })
      continue
    }
    const plan = new Set(knowledge.reveal_to)
    const actual = candidate.revealed_to
    const actualSet = new Set(actual)
    const isSubset = actual.every((id) => plan.has(id))
    const isSuperset = knowledge.reveal_to.every((id) => actualSet.has(id))
    const intersects = actual.some((id) => plan.has(id))

    if (actual.length === 0 || intersects === false) {
      conflicts.push({
        id: nextConflictId(options.conflictOffset),
        type: 'OCCURRED_CONFLICT',
        ref_type: 'knowledge',
        ref_id: knowledge.id,
        blueprint_version: blueprint.blueprint_version,
        message: `正文实际揭示对象 [${actual.join(', ')}] 与 Blueprint 计划 [${knowledge.reveal_to.join(', ')}] 没有交集：请选择修改正文或修改 Blueprint（不自动改动计划）`,
        resolution_note: null,
      })
      continue
    }
    if (!isSubset && isSuperset === false) {
      conflicts.push({
        id: nextConflictId(options.conflictOffset),
        type: 'OCCURRED_CONFLICT',
        ref_type: 'knowledge',
        ref_id: knowledge.id,
        blueprint_version: blueprint.blueprint_version,
        message: `正文实际揭示对象 [${actual.join(', ')}] 既不是计划的子集也不是超集：[${knowledge.reveal_to.join(', ')}]`,
        resolution_note: null,
      })
      continue
    }
    if (isSubset && !isSuperset) {
      lowSeverity.push({
        code: 'revealed_to_narrower_than_plan',
        message: `${knowledge.id} 实际只揭示给了 [${actual.join(', ')}]，窄于计划 [${knowledge.reveal_to.join(', ')}]（正常，仅记录）`,
        evidence: { knowledge_ref: knowledge.id, plan: [...knowledge.reveal_to], actual: [...actual] },
      })
    }
    if (!isSubset) {
      conflicts.push({
        id: nextConflictId(options.conflictOffset),
        type: 'OCCURRED_CONFLICT',
        ref_type: 'knowledge',
        ref_id: knowledge.id,
        blueprint_version: blueprint.blueprint_version,
        message: `正文实际揭示对象 [${actual.join(', ')}] 超出 Blueprint 计划 [${knowledge.reveal_to.join(', ')}]`,
        resolution_note: null,
      })
      continue
    }
    occurred.push(
      makeKnowledgeReveal({
        knowledge_ref: knowledge.id,
        scene_id: candidate.scene_id,
        revealed_to: actual,
        source_ref: options.sourceRef,
      }),
    )
  }

  for (const candidate of extraction.relationship_changes) {
    const projection = state.relationship_state.find((entry) => entry.blueprint_ref === candidate.relationship_ref)
    if (projection === undefined) {
      conflicts.push({
        id: nextConflictId(options.conflictOffset),
        type: 'OCCURRED_CONFLICT',
        ref_type: 'relationship',
        ref_id: candidate.relationship_ref,
        blueprint_version: blueprint.blueprint_version,
        message: `State Extractor 报出了 baseline 中不存在的关系：${candidate.relationship_ref}`,
        resolution_note: null,
      })
      continue
    }
    // from_state 以运行时投影为准；候选给出不同值 → conflict
    const fromState = projection.state
    if (candidate.from_state !== fromState) {
      conflicts.push({
        id: nextConflictId(options.conflictOffset),
        type: 'OCCURRED_CONFLICT',
        ref_type: 'relationship',
        ref_id: candidate.relationship_ref,
        blueprint_version: blueprint.blueprint_version,
        message: `关系变化的 from_state="${candidate.from_state}" 与当前 relationship_state（"${fromState}"）不一致：请裁决（Harness 以投影为准，不自动改写正文）`,
        resolution_note: null,
      })
      continue
    }
    occurred.push(
      makeRelationshipChange({
        relationship_ref: candidate.relationship_ref,
        scene_id: candidate.scene_id,
        from_state: fromState,
        to_state: candidate.to_state,
        source_ref: options.sourceRef,
      }),
    )
  }

  return { occurred, conflicts, lowSeverity }
}

// ---------------------------------------------------------------------------
// 应用 OCCURRED 到 Story State（§18.4）
// ---------------------------------------------------------------------------

export interface ApplyOccurredResult {
  readonly state: StoryState
  readonly foreshadowingWarnings: readonly string[]
}

export function applyOccurredToState(
  state: StoryState,
  occurred: readonly Occurred[],
  conflicts: readonly OccurredConflict[],
  scenes: readonly Scene[],
): ApplyOccurredResult {
  const byId = new Map(state.occurred.map((entry) => [entry.id, entry]))
  for (const entry of occurred) byId.set(entry.id, entry)
  const orderOf = new Map(scenes.map((scene) => [scene.scene_id, scene.order]))
  const merged = [...byId.values()].sort((a, b) => {
    const diff = (orderOf.get(a.scene_id) ?? Number.MAX_SAFE_INTEGER) - (orderOf.get(b.scene_id) ?? Number.MAX_SAFE_INTEGER)
    return diff !== 0 ? diff : a.id.localeCompare(b.id)
  })

  const knowledgeState = state.knowledge_state.map((entry) => ({ ...entry, known_by: { ...entry.known_by } }))
  const relationshipState = state.relationship_state.map((entry) => ({ ...entry }))
  for (const entry of occurred) {
    if (entry.type === 'knowledge_reveal') {
      const projection = knowledgeState.find((candidate) => candidate.blueprint_ref === entry.payload.knowledge_ref)
      if (projection === undefined) continue
      for (const characterId of entry.payload.revealed_to) {
        if (characterId in projection.known_by) projection.known_by[characterId] = true
      }
      projection.occurred_reveal = true
      projection.last_updated_scene = entry.scene_id
    } else {
      const projection = relationshipState.find((candidate) => candidate.blueprint_ref === entry.payload.relationship_ref)
      if (projection === undefined) continue
      projection.state = entry.payload.to_state
      projection.last_updated_scene = entry.scene_id
    }
  }

  // §18.4：foreshadowing_state 按 Scene 顺序推进；payoff 已确认但 setup 未确认 → high warning，不自动跳状态
  const confirmed = new Set(state.confirmed_scenes)
  const foreshadowingWarnings: string[] = []
  const foreshadowingState = state.foreshadowing_state.map((entry) => {
    let next = { ...entry }
    if (next.resolved_setup_scene !== null && confirmed.has(next.resolved_setup_scene)) {
      if (next.state === 'planned') next = { ...next, state: 'setup_written' as const }
    }
    if (next.resolved_payoff_scene !== null && confirmed.has(next.resolved_payoff_scene)) {
      if (next.state === 'planned') {
        foreshadowingWarnings.push(
          `${next.blueprint_ref} 的 payoff Scene（${next.resolved_payoff_scene}）已确认，但其 setup Scene（${String(next.resolved_setup_scene)}）尚未确认：不自动跳状态（需求规格 §18.4，high warning）`,
        )
      } else {
        next = { ...next, state: 'paid_off' as const }
      }
    }
    return next
  })

  const existingIds = new Set(state.state_rebuild_conflicts.map((conflict) => conflict.id))
  let index = state.state_rebuild_conflicts.length
  const addedConflicts = conflicts.map((conflict) => {
    index += 1
    let id = conflict.id
    while (existingIds.has(id)) {
      index += 1
      id = `SRC_${String(index).padStart(3, '0')}`
    }
    existingIds.add(id)
    return { ...conflict, id }
  })

  return {
    state: validateStoryState({
      ...state,
      occurred: merged,
      knowledge_state: knowledgeState,
      relationship_state: relationshipState,
      foreshadowing_state: foreshadowingState,
      state_rebuild_conflicts: [...state.state_rebuild_conflicts, ...addedConflicts],
    }),
    foreshadowingWarnings,
  }
}

// ---------------------------------------------------------------------------
// Gate 3 服务
// ---------------------------------------------------------------------------

export interface RunGate3Options {
  readonly paths: ProjectPaths
  readonly provider: LinterProvider
  /** 必须显式确认（整篇一次性）。 */
  readonly confirm: boolean
  readonly now?: Date | undefined
  readonly dryRun?: boolean | undefined
}

export interface Gate3Result {
  readonly finalText: string
  readonly finalPath: string
  readonly sceneCount: number
  readonly missingSceneIds: readonly string[]
  readonly confirmedScenes: readonly string[]
  readonly occurred: readonly Occurred[]
  readonly conflicts: readonly OccurredConflict[]
  readonly lowSeverity: readonly { readonly code: string; readonly message: string; readonly evidence: Record<string, unknown> }[]
  readonly foreshadowingWarnings: readonly string[]
  readonly state: StoryState
  readonly prompt: string
  readonly inputSha256: string
  readonly provider: string
  readonly model: string
  readonly written: boolean
}

export async function runGate3(options: RunGate3Options): Promise<Gate3Result> {
  const { paths } = options
  const assembled = assembleFinalFromProject(paths)
  if (assembled.missingSceneIds.length > 0) {
    throw new Gate3Error(`缺少 Draft：${assembled.missingSceneIds.join(', ')}；请先执行 harness write`)
  }
  if (assembled.finalText.trim() === '') throw new Gate3Error('final.md 为空，无法确认')
  if (!options.confirm) {
    throw new Gate3Error('Gate 3 需要显式确认：请加 --confirm（整篇一次性确认，逐场确认属于 Story 9 的 Rewrite 范畴）')
  }

  const blueprint = loadBlueprint(paths)
  const scenes = loadScenes(paths)
  const state = loadStoryState(paths)
  if (state === null) throw new Gate3Error(`找不到 ${paths.storyState}；请先执行 harness breakdown`)
  const texts: Record<string, string> = {}
  for (const scene of scenes) {
    const file = join(paths.draftsDir, `${scene.scene_id}.md`)
    if (existsSync(file)) texts[scene.scene_id] = readTextFile(file)
  }
  const contract = loadPromptContract(STATE_EXTRACTOR_CONTRACT_ID, STATE_EXTRACTOR_CONTRACT_VERSION)
  const input = buildStateExtractorInput(blueprint, scenes, state, texts)
  const prompt = renderPrompt(contract, {
    plan: dumpYaml(input.plan).trimEnd(),
    projection: dumpYaml(input.projection).trimEnd(),
    scenes: sortScenesByOrder(scenes)
      .map((scene) => `### ${scene.scene_id}\n${texts[scene.scene_id] ?? ''}`)
      .join('\n\n'),
  })

  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出严格 YAML（knowledge_reveals / relationship_changes 两个键），不输出解释。',
    temperature: 0,
  })
  const extraction = parseExtraction(response.text)

  // Gate 3：全部 Scene 一次性写入 confirmed_scenes
  const confirmedScenes = sortScenesByOrder(scenes).map((scene) => scene.scene_id)
  const confirmedState = validateStoryState({ ...state, confirmed_scenes: confirmedScenes })

  resetConflictSequence()
  const comparison = compareExtraction(extraction, blueprint, confirmedState, {
    sourceRef: 'drafts/final.md',
    conflictOffset: confirmedState.state_rebuild_conflicts.length,
  })
  const applied = applyOccurredToState(confirmedState, comparison.occurred, comparison.conflicts, scenes)

  const foreshadowingWarnings = applied.foreshadowingWarnings
  const finalPath = join(paths.draftsDir, 'final.md')
  const dryRun = options.dryRun ?? false
  if (!dryRun) {
    writeTextFile(finalPath, `${assembled.finalText}\n`)
    writeYamlFile(paths.storyState, applied.state, {
      headerComments: [
        'Gate 3 已确认：confirmed_scenes 一次性写入；occurred 由 State Extractor 提取（确定性 ID，可重跑）',
        `State Extractor：${STATE_EXTRACTOR_CONTRACT_ID}@${STATE_EXTRACTOR_CONTRACT_VERSION}`,
      ],
    })
  }
  return {
    finalText: assembled.finalText,
    finalPath,
    sceneCount: scenes.length,
    missingSceneIds: [],
    confirmedScenes,
    occurred: comparison.occurred,
    conflicts: comparison.conflicts,
    lowSeverity: comparison.lowSeverity,
    foreshadowingWarnings,
    state: applied.state,
    prompt,
    inputSha256: hashContractInput(contract.id, contract.version, input),
    provider: response.provider,
    model: response.model,
    written: !dryRun,
  }
}

export function loadFinalDraft(paths: ProjectPaths): string | null {
  const file = join(paths.draftsDir, 'final.md')
  return existsSync(file) ? readTextFile(file) : null
}

export function listDraftFiles(paths: ProjectPaths): string[] {
  if (!existsSync(paths.draftsDir)) return []
  return readdirSync(paths.draftsDir).sort()
}
