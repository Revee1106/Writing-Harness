import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hashContractInput } from '../core/hash.ts'
import { countAllCodePoints, countNonWhitespaceCodePoints } from '../core/text.ts'
import { dumpYaml, readTextFile, readYamlFile, writeTextFile, writeYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { REPO_ROOT_FALLBACK } from './repo-root.ts'
import { loadBlueprint, loadProjectConfig, loadProposals, loadSeed } from '../project/project.ts'
import { loadScenes, loadStoryState } from '../scenes/service.ts'
import type { Scene } from '../schema/scene.ts'
import { compileContext } from '../context/compiler.ts'
import { checkProposalDistinctness, computeSeedPreservationRate } from '../schema/proposal.ts'
import { loadLinterReport, runRuleLinter } from '../linter/rule-linter.ts'
import { listDraftFiles } from '../state/gate3.ts'
import { loadElevationPhrases, loadTemplateActions } from '../schema/anti-ai-vocab.ts'
import { resolveLinterThresholds } from '../linter/thresholds.ts'
import {
  checkDialogueRatio,
  checkParagraphEndingElevation,
  checkParagraphLengthVariance,
  checkSentenceLengthVariance,
  checkTemplateActions,
} from '../linter/rules.ts'

/**
 * Story 10 的评估资产（需求规格 §31；《开发 Story 拆分》Story 10 C / D / E）。
 *
 * 裁决边界：
 * - **v0.1 不执行盲测**：只准备"可运行 A/B 对照 + 人工填写模板"（CSV）；
 * - **不自动评分**：CSV 的评分列由人工填写；
 * - 评估记录走 CSV，**不引入任何新 Schema**。
 */

export const EVALUATION_ROOT = join('tests', 'fixtures', 'evaluation')
export const STORY_DEVELOPMENT_DIR = join(EVALUATION_ROOT, 'story-development')
export const ANTI_AI_DIR = join(EVALUATION_ROOT, 'anti-ai')

/** Story Development Test Set 的 CSV 列（Story 10 C 节）。 */
export const STORY_DEVELOPMENT_CSV_COLUMNS = [
  'seed_id',
  'proposal_count',
  'distinctness_ok',
  'proposal_id',
  'seed_preservation_rate',
  'preserved',
  'altered',
  'additions',
  'risks',
  'conflicts',
  'unaccounted_anchors',
] as const

/** Anti-AI A/B 的 CSV 列（Story 10 D 节 + Story 10 起始会裁决 4）。 */
/**
 * `plain_prompt` 契约的输入（Story 10 D 节：Anti-AI A/B 的 A 侧对照）。
 *
 * A 侧刻意**不给** POV 过滤后的上下文与 Style Samples：这就是"普通一次性 Prompt"。
 * fixture 复核与 session 生成共用这一个函数，避免两处漂移。
 */
export function buildPlainPromptInput(scene: Scene): Readonly<Record<string, unknown>> {
  return {
    scene_intent: {
      scene_id: scene.scene_id,
      pov: scene.pov,
      scene_type: scene.scene_type,
      tone: [...scene.tone],
      purpose: scene.purpose,
      location: scene.location,
      start_state: scene.start_state,
      conflict: scene.conflict,
      turn: scene.turn,
      end_state: scene.end_state,
      target_length: scene.target_length,
    },
  }
}

/** Anti-AI A/B 目录下 plain_prompt 的 fixture 文件名：`<projectId>-<sceneId>.yaml`。 */
export function plainPromptFixtureFile(projectId: string, sceneId: string): string {
  return `${projectId}-${sceneId}.yaml`
}

export const ANTI_AI_CSV_COLUMNS = [
  'group_id',
  'text_a_file',
  'text_b_file',
  'rater_id',
  'more_humanlike',
  'more_natural',
  'dialogue_more_natural',
  'characters_more_alive',
  'lower_ai_feel',
  'want_to_continue',
  'notes',
] as const

function csvEscape(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  return [columns.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// C：Story Development Test Set
// ---------------------------------------------------------------------------

export const STORY_DEVELOPMENT_SEED_SET_FILE = join(STORY_DEVELOPMENT_DIR, 'seeds.yaml')

/** Story Development Test Set 的一个 Seed 条目（测试集输入，不属于任何项目）。 */
export interface StoryDevelopmentSeedEntry {
  readonly seed_id: string
  readonly status: 'measured' | 'corpus_only'
  readonly project_id: string | null
  readonly title: string
  readonly text: string
  readonly pov_hint: string
  readonly expectation: {
    readonly proposal_count_min: number
    readonly distinctness_required: boolean
  }
}

export interface StoryDevelopmentSeedSet {
  readonly set_id: string
  readonly seed_count_minimum: number
  readonly seeds: readonly StoryDevelopmentSeedEntry[]
  readonly measuredCount: number
}

/** Seed Schema 对 `story_seed.text` 的长度约束（Story 1 已冻结）。 */
const SEED_TEXT_MAX_CHARS = 500

/**
 * 读取 Story Development Test Set（≥10 Seed）。
 *
 * 这里**刻意重新校验**测试集本身：测试集是评估基准，
 * 比项目状态更容易被无意改坏（Story 10 C 节）。
 */
export function loadStoryDevelopmentSeedSet(repoRoot: string = REPO_ROOT_FALLBACK): StoryDevelopmentSeedSet {
  const file = join(repoRoot, STORY_DEVELOPMENT_SEED_SET_FILE)
  const doc = readYamlFile(file) as {
    set_id?: string
    seed_count_minimum?: number
    seeds?: {
      seed_id?: string
      status?: string
      project_id?: string
      title?: string
      text?: string
      pov_hint?: string
      expectation?: { proposal_count_min?: number; distinctness_required?: boolean }
    }[]
  }
  const set = doc.set_id ?? ''
  const minimum = doc.seed_count_minimum ?? 0
  const rawSeeds = doc.seeds ?? []
  const seeds: StoryDevelopmentSeedEntry[] = rawSeeds.map((entry, index) => {
    const label = entry.seed_id ?? `#${String(index + 1)}`
    const status = entry.status
    if (status !== 'measured' && status !== 'corpus_only') {
      throw new Error(`Story Development Test Set：${label} 的 status 必须是 measured 或 corpus_only`)
    }
    const text = entry.text ?? ''
    if (text.trim() === '') throw new Error(`Story Development Test Set：${label} 缺少 text`)
    if (countAllCodePoints(text) > SEED_TEXT_MAX_CHARS) {
      throw new Error(`Story Development Test Set：${label} 的 text 超过 Seed Schema 上限 ${SEED_TEXT_MAX_CHARS} 字符`)
    }
    const expectation = entry.expectation ?? {}
    if ((expectation.proposal_count_min ?? 0) < 2) {
      throw new Error(`Story Development Test Set：${label} 的 proposal_count_min 至少为 2`)
    }
    if (expectation.distinctness_required !== true) {
      throw new Error(`Story Development Test Set：${label} 必须要求差异度（distinctness_required: true）`)
    }
    if (status === 'measured' && (entry.project_id ?? '') === '') {
      throw new Error(`Story Development Test Set：${label} 标记为 measured 时必须给出 project_id`)
    }
    return {
      seed_id: label,
      status,
      project_id: entry.project_id ?? null,
      title: entry.title ?? '',
      text,
      pov_hint: entry.pov_hint ?? 'single',
      expectation: {
        proposal_count_min: expectation.proposal_count_min ?? 2,
        distinctness_required: true,
      },
    }
  })
  const ids = new Set(seeds.map((seed) => seed.seed_id))
  if (ids.size !== seeds.length) throw new Error('Story Development Test Set：seed_id 必须唯一')
  if (seeds.length < minimum) {
    throw new Error(`Story Development Test Set：只有 ${seeds.length} 个 Seed，少于要求的 ${minimum} 个`)
  }
  return {
    set_id: set,
    seed_count_minimum: minimum,
    seeds,
    measuredCount: seeds.filter((seed) => seed.status === 'measured').length,
  }
}

export interface StoryDevelopmentRow {
  readonly seed_id: string
  readonly proposal_count: number
  readonly distinctness_ok: boolean
  readonly proposal_id: string
  readonly seed_preservation_rate: string
  readonly preserved: number
  readonly altered: number
  readonly additions: number
  readonly risks: number
  readonly conflicts: number
  readonly unaccounted_anchors: number
}

/** 从已跑完 Gate 2 的项目生成 Story Development 评估行（离线，可复跑）。 */
export function collectStoryDevelopmentRows(paths: ProjectPaths, seedId: string): StoryDevelopmentRow[] {
  const proposals = loadProposals(paths)
  const seed = loadSeed(paths)
  const anchors = seed.story_seed.raw_seed_anchor_ids
  const distinctness = checkProposalDistinctness(proposals.proposals)
  return proposals.proposals.map((proposal) => {
    const rate = computeSeedPreservationRate(proposal, anchors)
    return {
      seed_id: seedId,
      proposal_count: proposals.proposals.length,
      distinctness_ok: distinctness.ok,
      proposal_id: proposal.proposal_id,
      seed_preservation_rate: rate.rate_percent === null ? 'n/a' : `${rate.rate_percent}%`,
      preserved: proposal.seed_fidelity.preserved.length,
      altered: proposal.seed_fidelity.altered.length,
      additions: proposal.seed_fidelity.added.length,
      risks: proposal.seed_fidelity.risk.length,
      conflicts: proposal.conflicts.length,
      unaccounted_anchors: rate.unaccounted_anchor_ids.length,
    }
  })
}

export interface StoryDevelopmentEvaluation {
  readonly seedCount: number
  readonly proposalCount: number
  readonly distinctnessAllOk: boolean
  readonly rows: readonly StoryDevelopmentRow[]
}

export function buildStoryDevelopmentEvaluation(
  projects: readonly { readonly seedId: string; readonly paths: ProjectPaths }[],
): StoryDevelopmentEvaluation {
  const rows = projects.flatMap((project) => collectStoryDevelopmentRows(project.paths, project.seedId))
  return {
    seedCount: projects.length,
    proposalCount: rows.length,
    distinctnessAllOk: rows.every((row) => row.distinctness_ok),
    rows,
  }
}

// ---------------------------------------------------------------------------
// E：Author Cost（需求规格 §31.3）
// ---------------------------------------------------------------------------

export const AUTHOR_COST_CSV_COLUMNS = [
  'project_id',
  'explicit_gates',
  'gate1_status',
  'gate1_fixed_items',
  'gate1_gate1_confirmed_items',
  'blueprint_versions',
  'blueprint_conflicts_resolved',
  'linter_warnings',
  'rewrites_applied',
  'scenes',
  'confirmed_scenes',
  'occurred',
  'unresolved_state_conflicts',
] as const

export interface AuthorCostRow {
  readonly project_id: string
  readonly explicit_gates: number
  readonly gate1_status: string
  readonly gate1_fixed_items: number
  readonly gate1_gate1_confirmed_items: number
  readonly blueprint_versions: number
  readonly blueprint_conflicts_resolved: number
  readonly linter_warnings: number
  readonly rewrites_applied: number
  readonly scenes: number
  readonly confirmed_scenes: number
  readonly occurred: number
  readonly unresolved_state_conflicts: number
}

/** 从项目文件统计作者成本（显式 Gate 次数 = Gate 1 + Gate 2（每次确认）+ Gate 3）。 */
export function collectAuthorCost(projectId: string, paths: ProjectPaths): AuthorCostRow {
  const seed = existsSync(paths.seed) ? loadSeed(paths) : null
  const historyDir = paths.historyDir
  const blueprintVersions = existsSync(historyDir)
    ? readdirSync(historyDir).filter((name) => /^blueprint-\d{3}\.yaml$/.test(name)).length
    : 0
  let conflictsResolved = 0
  if (existsSync(paths.blueprintHistoryDir)) {
    for (const name of readdirSync(paths.blueprintHistoryDir).filter((entry) => entry.endsWith('.meta.yaml'))) {
      const meta = readYamlFile(join(paths.blueprintHistoryDir, name)) as {
        conflict_resolutions?: unknown[]
      }
      conflictsResolved += meta.conflict_resolutions?.length ?? 0
    }
  }
  const linter = loadLinterReport(paths)
  const state = loadStoryState(paths)
  const sceneCount = loadScenes(paths).length
  const gate1Done = seed !== null && seed.story_seed.gate1_status !== 'pending' ? 1 : 0
  const gate3Done = state !== null && state.confirmed_scenes.length > 0 ? 1 : 0
  return {
    project_id: projectId,
    explicit_gates: gate1Done + blueprintVersions + gate3Done,
    gate1_status: seed?.story_seed.gate1_status ?? 'n/a',
    gate1_fixed_items: seed?.story_seed.fixed_by_user.length ?? 0,
    gate1_gate1_confirmed_items:
      seed?.story_seed.fixed_by_user.filter((item) => item.source === 'user_gate1').length ?? 0,
    blueprint_versions: blueprintVersions,
    blueprint_conflicts_resolved: conflictsResolved,
    linter_warnings: linter?.warnings.length ?? 0,
    rewrites_applied: linter?.warnings.filter((warning) => warning.rewrite?.applied === true).length ?? 0,
    scenes: sceneCount,
    confirmed_scenes: state?.confirmed_scenes.length ?? 0,
    occurred: state?.occurred.length ?? 0,
    unresolved_state_conflicts:
      state?.state_rebuild_conflicts.filter((conflict) => conflict.resolution_note === null).length ?? 0,
  }
}

// ---------------------------------------------------------------------------
// D：Anti-AI A/B 对照（只生成对照与模板，不评分）
// ---------------------------------------------------------------------------

export interface AbGroup {
  readonly group_id: string
  readonly project_id: string
  readonly scene_id: string
  readonly pov: string
  readonly scene_type: string
  readonly intent_ref: string
  readonly text_a_file: string
  readonly text_b_file: string
  readonly harness_target_length: number
  readonly a_code_points: number
  readonly b_code_points: number
  readonly a_rule_warnings: number
  readonly b_rule_warnings: number
}

export interface AbSession {
  readonly session_id: string
  readonly session_dir: string
  readonly groups: readonly AbGroup[]
  readonly csvPath: string
  readonly metadataPath: string
}

export interface AbGenerateOptions {
  readonly repoRoot: string
  readonly sessionId: string
  /** 每个 Scene Intent 对应的 A 侧文本（"普通 Prompt"产出；离线时来自 fixture）。 */
  readonly plainTexts: Readonly<Record<string, string>>
  readonly harnessTexts: Readonly<Record<string, string>>
  readonly scenes: readonly {
    /** A/B 文本查找键：`<项目>/<scene_id>`（两个 demo 的 scene_id 会重名）。 */
    readonly key: string
    readonly project_id: string
    readonly scene_id: string
    readonly pov: string
    readonly scene_type: string
    readonly intent_ref: string
    readonly target_length: number
  }[]
  readonly aRuleWarnings: Readonly<Record<string, number>>
  readonly bRuleWarnings: Readonly<Record<string, number>>
}

/** 生成 session-<NNN>/：A/B 文本对 + 人工填写 CSV 模板 + 元数据（不自动评分）。 */
export function generateAbSession(options: AbGenerateOptions): AbSession {
  const sessionDir = join(options.repoRoot, ANTI_AI_DIR, options.sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const groups: AbGroup[] = []
  const csvRows: string[][] = []
  options.scenes.forEach((scene, index) => {
    const groupId = `G${String(index + 1).padStart(2, '0')}`
    const aFile = `group-${groupId}.a.txt`
    const bFile = `group-${groupId}.b.txt`
    const aText = options.plainTexts[scene.key] ?? ''
    const bText = options.harnessTexts[scene.key] ?? ''
    writeTextFile(join(sessionDir, aFile), `${aText.replace(/\s+$/u, '')}\n`)
    writeTextFile(join(sessionDir, bFile), `${bText.replace(/\s+$/u, '')}\n`)
    groups.push({
      group_id: groupId,
      project_id: scene.project_id,
      scene_id: scene.scene_id,
      pov: scene.pov,
      scene_type: scene.scene_type,
      intent_ref: scene.intent_ref,
      text_a_file: aFile,
      text_b_file: bFile,
      harness_target_length: scene.target_length,
      a_code_points: countNonWhitespaceCodePoints(aText),
      b_code_points: countNonWhitespaceCodePoints(bText),
      a_rule_warnings: options.aRuleWarnings[scene.key] ?? 0,
      b_rule_warnings: options.bRuleWarnings[scene.key] ?? 0,
    })
    csvRows.push([groupId, aFile, bFile, '', '', '', '', '', '', '', ''])
  })
  const csvPath = join(sessionDir, 'ratings.csv')
  writeTextFile(csvPath, toCsv(ANTI_AI_CSV_COLUMNS, csvRows))
  const metadataPath = join(sessionDir, 'session.yaml')
  writeYamlFile(
    metadataPath,
    {
      session_id: options.sessionId,
      schema_version: '0.1',
      generated_at: new Date().toISOString(),
      note: 'v0.1 不执行盲测、不自动评分；ratings.csv 由人工填写（Story 10 起始会裁决 4）',
      groups,
    },
    { headerComments: ['Anti-AI A/B 对照（Story 10 D）：A = 普通 Prompt，B = Writing Harness'] },
  )
  return { session_id: options.sessionId, session_dir: sessionDir, groups, csvPath, metadataPath }
}

export function nextSessionId(repoRoot: string): string {
  const dir = join(repoRoot, ANTI_AI_DIR)
  if (!existsSync(dir)) return 'session-001'
  const existing = readdirSync(dir).filter((name) => /^session-\d{3}$/.test(name))
  const max = existing.reduce((accumulator, name) => Math.max(accumulator, Number(name.replace('session-', ''))), 0)
  return `session-${String(max + 1).padStart(3, '0')}`
}

/**
 * 统计一段文本在 **Rule Linter** 下会产生多少 warning（仅作为 A/B 元数据，不参与评分）。
 * 词表从仓库级默认文件读取；纯函数，不触碰任何项目状态。
 */
export function countRuleWarnings(text: string, repoRoot: string = REPO_ROOT_FALLBACK): number {
  if (text.trim() === '') return 0
  const thresholds = resolveLinterThresholds(undefined)
  const actions = loadTemplateActions({ antiAiTemplateActions: '' } as ProjectPaths, repoRoot).items
  const phrases = loadElevationPhrases({ antiAiElevationPhrases: '' } as ProjectPaths, repoRoot).items
  const context = { text, thresholds, templateActions: actions, elevationPhrases: phrases }
  let sequence = 0
  const nextId = (): string => `LINT_${String((sequence += 1)).padStart(3, '0')}`
  return (
    checkTemplateActions(context, nextId).length +
    checkSentenceLengthVariance(context, nextId).length +
    checkParagraphLengthVariance(context, nextId).length +
    checkDialogueRatio(context, nextId).length +
    checkParagraphEndingElevation(context, nextId).length
  )
}

export function draftTextsOf(paths: ProjectPaths): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const name of listDraftFiles(paths)) {
    if (!/^scene-\d{3}\.md$/.test(name)) continue
    texts[name.replace(/\.md$/u, '')] = readTextFile(join(paths.draftsDir, name))
  }
  return texts
}

export { REPO_ROOT_FALLBACK, hashContractInput, dumpYaml, loadBlueprint, loadProjectConfig, compileContext, runRuleLinter }
