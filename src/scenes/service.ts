import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { hashContractInput } from '../core/hash.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { extractYamlBlock } from '../interpreter/schema.ts'
import { dumpYaml, readYamlFile, writeYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { SCENE_SCHEMA_VERSION, validateScene, type DirectorNote, type Scene } from '../schema/scene.ts'
import type { Blueprint } from '../schema/blueprint.ts'
import type { SeedFile } from '../schema/seed.ts'
import type { StoryState } from '../schema/story-state.ts'
import { loadBlueprint, loadSeed } from '../project/project.ts'
import type { LLMProvider } from '../providers/types.ts'
import { SCENE_TYPES } from '../core/scene-types.ts'
import { applyAllowedReveals, resolveStructure, sortScenesByOrder, type StructureResolution } from './resolver.ts'
import { runCoverageCheck, validateCoverageReport, type CoverageReport } from './coverage.ts'
import { initStoryState, rebuildStoryState } from './state.ts'
import { StoryStateValidationError, validateStoryState } from '../schema/story-state.ts'

/**
 * Scene Breakdown 服务 —— 需求规格 §14、§16、§17；Story 5。
 *
 * 流程：读取 blueprint（+ seed） → 调 `scene_breakdown@0.1` → 分配 scene_id / order
 *      → Structure Resolver 生成 allowed_reveals 与 foreshadowing 解析结果
 *      → 校验 Scene → 写 `/scenes/scene-NNN.yaml` → 初始化 / 重建 `story_state.yaml`
 *      → 运行 Coverage Check 写 `/reports/coverage.yaml`。
 *
 * 重跑（OQ-17）：必须显式触发（`rerun: true`），覆盖 `/scenes/*.yaml`；
 * `confirmed_scenes` 不变；消失的 scene_id → ORPHANED 冲突。
 */

export const SCENE_BREAKDOWN_CONTRACT_ID = 'scene_breakdown'
export const SCENE_BREAKDOWN_CONTRACT_VERSION = '0.1'

const rawSceneSchema = z.strictObject({
  pov: z.string().min(1),
  scene_type: z.enum(SCENE_TYPES),
  purpose: z.string().min(1),
  target_length: z.number().int().positive(),
  narrative_role_ref: z.string().min(1),
  characters: z.array(z.string().min(1)),
  location: z.string().min(1),
  start_state: z.string().min(1),
  conflict: z.string().min(1),
  turn: z.string().min(1),
  end_state: z.string().min(1),
  referenced_blueprint_items: z.array(z.string().min(1)).optional(),
  director_notes: z.array(z.string().min(1)).optional(),
  proposed_additions: z.array(z.string().min(1)).optional(),
})

const rawBreakdownOutputSchema = z.strictObject({
  scenes: z.array(rawSceneSchema).min(1),
})
export type RawBreakdownOutput = z.infer<typeof rawBreakdownOutputSchema>

export class SceneBreakdownOutputError extends Error {
  override readonly name = 'SceneBreakdownOutputError'
  readonly detail: readonly string[]
  readonly rawOutput: string
  constructor(detail: readonly string[], rawOutput: string) {
    super(`Scene Breakdown 输出不符合契约：\n- ${detail.join('\n- ')}`)
    this.detail = detail
    this.rawOutput = rawOutput
  }
}

export class SceneBreakdownPreconditionError extends Error {
  override readonly name = 'SceneBreakdownPreconditionError'
  constructor(message: string) {
    super(message)
  }
}

export class SceneRerunRequiredError extends Error {
  override readonly name = 'SceneRerunRequiredError'
  constructor(count: number) {
    super(
      `项目已有 ${count} 个 Scene 文件；重跑 Scene Breakdown 必须显式触发（--rerun）：\n- 会覆盖 /scenes/*.yaml\n- confirmed_scenes 不变\n- 消失的 scene_id 会产生 ORPHANED 冲突（OQ-17）`,
    )
  }
}

export interface SceneBreakdownOptions {
  readonly paths: ProjectPaths
  readonly provider: LLMProvider
  /** 用户补充的 director note（§22 的降级路径；source=user）。 */
  readonly userNotes?: Readonly<Record<string, readonly string[]>> | undefined
  readonly rerun?: boolean | undefined
  readonly now?: Date | undefined
  readonly dryRun?: boolean | undefined
}

export interface SceneBreakdownResult {
  readonly scenes: readonly Scene[]
  readonly state: StoryState
  readonly coverage: CoverageReport
  readonly resolution: StructureResolution
  readonly rawOutput: string
  readonly prompt: string
  readonly inputSha256: string
  readonly provider: string
  readonly model: string
  readonly written: boolean
  readonly rerun: boolean
  readonly previousState: StoryState | null
  readonly paths: { readonly scenesDir: string; readonly storyState: string; readonly coverage: string }
}

/** 构造 Prompt Contract 的结构化输入（同时决定 recorded fixture 的查找键）。 */
export function buildSceneBreakdownInput(
  blueprint: Blueprint,
  options: { readonly userNotes?: Readonly<Record<string, readonly string[]>> | undefined } = {},
): Readonly<Record<string, unknown>> {
  return {
    blueprint: {
      schema_version: blueprint.schema_version,
      blueprint_version: blueprint.blueprint_version,
      meta: blueprint.meta,
      premise: blueprint.premise,
      theme: blueprint.theme,
      characters: blueprint.characters,
      core_conflict: blueprint.core_conflict,
      arc: blueprint.arc,
      structure: blueprint.structure,
      key_knowledge: blueprint.key_knowledge,
      foreshadowing: blueprint.foreshadowing,
      style_direction: blueprint.style_direction,
      seed_fidelity: blueprint.seed_fidelity,
    },
    constraints: {
      target_length: blueprint.meta.target_length,
      pov: [...blueprint.meta.pov],
      scene_types: [...SCENE_TYPES],
      structure_positions: Object.values(blueprint.structure).map((item) => item.id),
    },
    user_notes: Object.entries(options.userNotes ?? {}).map(([sceneKey, notes]) => ({ scene: sceneKey, notes })),
  }
}

export function parseRawBreakdownOutput(rawOutput: string): RawBreakdownOutput {
  let parsed: unknown
  try {
    parsed = parseYaml(extractYamlBlock(rawOutput))
  } catch (error) {
    throw new SceneBreakdownOutputError([`YAML 解析失败：${(error as Error).message}`], rawOutput)
  }
  const result = rawBreakdownOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new SceneBreakdownOutputError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      rawOutput,
    )
  }
  return result.data
}

/** 把模型输出装配成 Scene（分配 scene_id / order / allowed_reveals / director_notes / proposed_additions）。 */
export function assembleScenes(
  raw: RawBreakdownOutput,
  blueprint: Blueprint,
  userNotes: Readonly<Record<string, readonly string[]>> = {},
): Scene[] {
  // OQ-11 的 DIR_<source>_NNN 在整个项目内唯一（Manifest 的 overrides.director_surface_ref 需要一对一引用）
  let sceneNoteSequence = 0
  let userNoteSequence = 0
  return raw.scenes.map((scene, index) => {
    const sceneId = `scene-${String(index + 1).padStart(3, '0')}`
    const directorNotes: DirectorNote[] = (scene.director_notes ?? []).map((instruction) => {
      sceneNoteSequence += 1
      return {
        id: `DIR_SCENE_${String(sceneNoteSequence).padStart(3, '0')}`,
        instruction,
        source: 'scene' as const,
      }
    })
    const notes = userNotes[sceneId] ?? []
    for (const instruction of notes) {
      userNoteSequence += 1
      directorNotes.push({
        id: `DIR_USER_${String(userNoteSequence).padStart(3, '0')}`,
        instruction,
        source: 'user' as const,
      })
    }
    return validateScene({
      schema_version: SCENE_SCHEMA_VERSION,
      scene_id: sceneId,
      order: index + 1,
      pov: scene.pov,
      scene_type: scene.scene_type,
      purpose: scene.purpose,
      target_length: scene.target_length,
      narrative_role_ref: scene.narrative_role_ref,
      characters: [...new Set(scene.characters)],
      location: scene.location,
      start_state: scene.start_state,
      conflict: scene.conflict,
      turn: scene.turn,
      end_state: scene.end_state,
      allowed_reveals: [],
      director_notes: directorNotes,
      referenced_blueprint_items: [...new Set(scene.referenced_blueprint_items ?? [])],
      proposed_additions: (scene.proposed_additions ?? []).map((value, additionIndex) => ({
        id: `ADD_${String(additionIndex + 1).padStart(3, '0')}`,
        value,
        status: 'PROPOSED' as const,
        source: 'scene_breakdown' as const,
      })),
    })
  })
}

export function loadScenes(paths: ProjectPaths): Scene[] {
  if (!existsSync(paths.scenesDir)) return []
  return readdirSync(paths.scenesDir)
    .filter((name) => /^scene-\d{3}\.yaml$/.test(name))
    .sort()
    .map((name) => validateScene(readYamlFile(join(paths.scenesDir, name))))
}

export function loadStoryState(paths: ProjectPaths): StoryState | null {
  if (!existsSync(paths.storyState)) return null
  return validateStoryState(readYamlFile(paths.storyState))
}

export function loadCoverageReport(paths: ProjectPaths): CoverageReport | null {
  if (!existsSync(paths.coverageReport)) return null
  return validateCoverageReport(readYamlFile(paths.coverageReport))
}

export async function runSceneBreakdown(options: SceneBreakdownOptions): Promise<SceneBreakdownResult> {
  const { paths } = options
  if (!existsSync(paths.blueprint)) {
    throw new SceneBreakdownPreconditionError(`找不到 ${paths.blueprint}；请先完成 Gate 2（harness gate2）`)
  }
  const blueprint = loadBlueprint(paths)
  const seed: SeedFile = loadSeed(paths)
  const existing = loadScenes(paths)
  const rerun = options.rerun ?? false
  if (existing.length > 0 && !rerun) {
    throw new SceneRerunRequiredError(existing.length)
  }

  const contract = loadPromptContract(SCENE_BREAKDOWN_CONTRACT_ID, SCENE_BREAKDOWN_CONTRACT_VERSION)
  const input = buildSceneBreakdownInput(blueprint, { userNotes: options.userNotes })
  const prompt = renderPrompt(contract, {
    blueprint: dumpYaml(input.blueprint).trimEnd(),
    constraints: dumpYaml(input.constraints).trimEnd(),
  })

  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出符合约定的 YAML，不输出解释。',
    temperature: 0,
  })

  const raw = parseRawBreakdownOutput(response.text)
  const assembled = assembleScenes(raw, blueprint, options.userNotes)

  // Structure Resolver：allowed_reveals 只由解析结果生成（§15）
  const resolution = resolveStructure(blueprint, assembled)
  const scenes = applyAllowedReveals(assembled, resolution)

  const previousState = loadStoryState(paths)
  const stateResult =
    previousState === null
      ? { state: initStoryState({ blueprint, scenes, seed }), newConflicts: [] }
      : rebuildStoryState({ blueprint, scenes, seed, previous: previousState })

  const coverageResult = runCoverageCheck({
    blueprint,
    scenes,
    generatedAt: (options.now ?? new Date()).toISOString(),
  })

  const dryRun = options.dryRun ?? false
  if (!dryRun) {
    if (rerun && existsSync(paths.scenesDir)) {
      for (const name of readdirSync(paths.scenesDir)) {
        if (/^scene-\d{3}\.yaml$/.test(name)) rmSync(join(paths.scenesDir, name))
      }
    }
    for (const scene of scenes) {
      writeYamlFile(join(paths.scenesDir, `${scene.scene_id}.yaml`), scene)
    }
    writeYamlFile(paths.storyState, stateResult.state)
    writeYamlFile(paths.coverageReport, coverageResult.report)
  }

  return {
    scenes: sortScenesByOrder(scenes),
    state: stateResult.state,
    coverage: coverageResult.report,
    resolution,
    rawOutput: response.text,
    prompt,
    inputSha256: hashContractInput(contract.id, contract.version, input),
    provider: response.provider,
    model: response.model,
    written: !dryRun,
    rerun,
    previousState,
    paths: { scenesDir: paths.scenesDir, storyState: paths.storyState, coverage: paths.coverageReport },
  }
}

export { StoryStateValidationError }
