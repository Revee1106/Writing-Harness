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
import type { Proposal } from '../schema/proposal.ts'
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
  /** project 型 measured：指向 `projects/<project_id>/`。 */
  readonly project_id: string | null
  /** fixture 型（measured 或 corpus_only）：指向 `tests/fixtures/seeds/...` 的 Seed 文本。 */
  readonly seed_file: string | null
  readonly gate1_ops: readonly unknown[] | null
  /** 题材标签（Story 10 C 节要求的类型矩阵）。 */
  readonly genre: string
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
  readonly projectBackedCount: number
  readonly fixtureBackedCount: number
  readonly corpusOnlyCount: number
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
      seed_file?: string
      gate1_ops?: unknown[]
      genre?: string
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
    const seedFile = entry.seed_file ?? null
    // fixture 型条目的文本直接从 Seed 文件读取：测试集里的文本与真正喂给模型的输入
    // 必须是同一份（不复制粘贴，避免两处漂移）。
    let text = entry.text ?? ''
    if (seedFile !== null) {
      const seedPath = join(repoRoot, seedFile)
      if (!existsSync(seedPath)) {
        throw new Error(`Story Development Test Set：${label} 引用的 Seed 文件不存在：${seedFile}`)
      }
      const fromFile = readTextFile(seedPath)
      if (text.trim() !== '' && text !== fromFile) {
        throw new Error(`Story Development Test Set：${label} 的 text 与 ${seedFile} 不一致`)
      }
      text = fromFile
    }
    if (text.trim() === '') throw new Error(`Story Development Test Set：${label} 缺少 text 或 seed_file`)
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
    if (status === 'measured' && (entry.project_id ?? '') === '' && seedFile === null) {
      throw new Error(`Story Development Test Set：${label} 标记为 measured 时必须给出 project_id 或 seed_file`)
    }
    return {
      seed_id: label,
      status,
      project_id: entry.project_id ?? null,
      seed_file: seedFile,
      gate1_ops: entry.gate1_ops ?? null,
      genre: entry.genre ?? '',
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
  const measured = seeds.filter((seed) => seed.status === 'measured')
  for (const seed of measured) {
    if (seed.project_id === null && seed.seed_file === null) {
      throw new Error(`Story Development Test Set：measured 的 ${seed.seed_id} 既没有 project_id 也没有 seed_file`)
    }
  }
  return {
    set_id: set,
    seed_count_minimum: minimum,
    seeds,
    measuredCount: measured.length,
    projectBackedCount: measured.filter((seed) => seed.project_id !== null).length,
    fixtureBackedCount: measured.filter((seed) => seed.project_id === null).length,
    corpusOnlyCount: seeds.length - measured.length,
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

/**
 * 由"提案集合 + Seed 锚点"构造评估行。
 *
 * 项目（Gate 2 已跑完）与 fixture（离线回放 5 个题材 Seed）共用这一条计算路径，
 * 保证两类 measured Seed 的口径完全一致。
 */
export function buildStoryDevelopmentRows(
  seedId: string,
  proposals: readonly Proposal[],
  anchorIds: readonly string[],
): StoryDevelopmentRow[] {
  const distinctness = checkProposalDistinctness(proposals)
  return proposals.map((proposal) => {
    const rate = computeSeedPreservationRate(proposal, anchorIds)
    return {
      seed_id: seedId,
      proposal_count: proposals.length,
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

/** 从已跑完 Gate 2 的项目生成 Story Development 评估行（离线，可复跑）。 */
export function collectStoryDevelopmentRows(paths: ProjectPaths, seedId: string): StoryDevelopmentRow[] {
  const proposals = loadProposals(paths)
  const seed = loadSeed(paths)
  return buildStoryDevelopmentRows(seedId, proposals.proposals, seed.story_seed.raw_seed_anchor_ids)
}

export interface FixtureSeedMeasurement {
  readonly seed_id: string
  readonly seed_file: string
  readonly rows: readonly StoryDevelopmentRow[]
  readonly proposal_count: number
  readonly distinctness_ok: boolean
  readonly anchor_count: number
  readonly provider: string
}

/**
 * 离线量测"fixture Seed"（Story 10 C 节：情感 / 悬疑 / 温情 / 现实 / 轻科幻）。
 *
 * 走的是**与产品完全相同的代码路径**：`seed_interpreter` → Gate 1 → `story_developer`，
 * 只是模型回应来自 `tests/fixtures/recorded/`（离线回放）。因此这些指标是真实的
 * "Seed → 提案"指标，不是硬编码数字。
 *
 * 为什么需要它：这 5 类 Seed 没有独立的 `projects/<id>/` 目录（评估资产不得写进
 * `projects/`，见 Story 10 起始会裁决），但它们是 Story Development Test Set 的
 * measured 成员。
 */
export async function measureFixtureSeed(options: {
  readonly repoRoot: string
  readonly seedId: string
  readonly seedFile: string
  readonly gate1Ops?: readonly unknown[] | undefined
}): Promise<FixtureSeedMeasurement> {
  const [{ readFileSync }, { runSeedInterpreter }, { applyGate1Operations, seedFromInterpreterResult }, { runStoryDeveloper }, { RecordedProvider }] =
    await Promise.all([
      import('node:fs'),
      import('../interpreter/interpreter.ts'),
      import('../gate1/operations.ts'),
      import('../developer/developer.ts'),
      import('../providers/recorded.ts'),
    ])
  const seedPath = join(options.repoRoot, options.seedFile)
  if (!existsSync(seedPath)) {
    throw new Error(`Story Development Test Set：找不到 Seed 文件 ${options.seedFile}`)
  }
  const rawInput = readFileSync(seedPath, 'utf8')
  const interpreter = await runSeedInterpreter({
    provider: RecordedProvider.fromDirectory(join(options.repoRoot, 'tests/fixtures/recorded/seed-interpreter')),
    rawInput,
  })
  const candidate = seedFromInterpreterResult(rawInput, interpreter)
  const ops = (options.gate1Ops ?? [{ kind: 'skip' }]) as Parameters<typeof applyGate1Operations>[1]
  const seed = applyGate1Operations(candidate, ops).seed
  const result = await runStoryDeveloper({
    provider: RecordedProvider.fromDirectory(join(options.repoRoot, 'tests/fixtures/recorded/story_developer')),
    seed,
  })
  const rows = buildStoryDevelopmentRows(options.seedId, result.file.proposals, seed.story_seed.raw_seed_anchor_ids)
  return {
    seed_id: options.seedId,
    seed_file: options.seedFile,
    rows,
    proposal_count: result.file.proposals.length,
    distinctness_ok: checkProposalDistinctness(result.file.proposals).ok,
    anchor_count: seed.story_seed.raw_seed_anchor_ids.length,
    provider: result.provider,
  }
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

/** ±20% 之内视为"两侧长度接近"，此时原始 warning 计数可直接比较。 */
export const AB_LENGTH_TOLERANCE = 0.2

export interface AbNormalization {
  readonly session_id: string
  readonly groupCount: number
  readonly aCodePoints: number
  readonly bCodePoints: number
  readonly aAvgCodePoints: number
  readonly bAvgCodePoints: number
  /** A/B 平均长度之比（A 为基准）。 */
  readonly lengthRatio: number
  readonly lengthsComparable: boolean
  readonly aWarnings: number
  readonly bWarnings: number
  /** 归一化：每 1000 个非空白码点的 Rule Linter warning 数。 */
  readonly aWarningsPer1000: number
  readonly bWarningsPer1000: number
  readonly normalizedRatio: number
  /** 结论句（写给报告，不做自动评分）。 */
  readonly verdict: string
}

function per1000(warnings: number, codePoints: number): number {
  if (codePoints === 0) return 0
  return Math.round((warnings / codePoints) * 1000 * 100) / 100
}

/**
 * A/B 对照的**归一化**摘要（Story 10 封版裁决"4"）。
 *
 * 为什么需要：A 侧（普通 Prompt）与 B 侧（Harness）的平均长度如果差得远，
 * "A=41 : B=4" 这种原始计数就不公平。规则：
 * - 两侧平均码点差在 ±20% 内 → 原始计数直接可信；
 * - 否则以"每千码点 warning 数"为准；
 * - 两种口径都给出，判定不隐藏。
 */
export function summarizeAbSession(
  repoRoot: string,
  sessionId: string,
  options: { readonly vocabRoot?: string | undefined } = {},
): AbNormalization {
  const sessionDir = join(repoRoot, ANTI_AI_DIR, sessionId)
  const metadata = readYamlFile(join(sessionDir, 'session.yaml')) as {
    session_id?: string
    groups?: { group_id?: string; text_a_file?: string; text_b_file?: string }[]
  }
  const groups = metadata.groups ?? []
  let aCodePoints = 0
  let bCodePoints = 0
  let aWarnings = 0
  let bWarnings = 0
  for (const group of groups) {
    const aText = readTextFile(join(sessionDir, group.text_a_file ?? ''))
    const bText = readTextFile(join(sessionDir, group.text_b_file ?? ''))
    aCodePoints += countNonWhitespaceCodePoints(aText)
    bCodePoints += countNonWhitespaceCodePoints(bText)
    aWarnings += countRuleWarnings(aText, options.vocabRoot ?? repoRoot)
    bWarnings += countRuleWarnings(bText, options.vocabRoot ?? repoRoot)
  }
  const groupCount = groups.length
  const aAvgCodePoints = groupCount === 0 ? 0 : Math.round(aCodePoints / groupCount)
  const bAvgCodePoints = groupCount === 0 ? 0 : Math.round(bCodePoints / groupCount)
  const lengthRatio = aCodePoints === 0 ? 0 : Math.round((bCodePoints / aCodePoints) * 1000) / 1000
  const lengthsComparable = Math.abs(lengthRatio - 1) <= AB_LENGTH_TOLERANCE
  const aWarningsPer1000 = per1000(aWarnings, aCodePoints)
  const bWarningsPer1000 = per1000(bWarnings, bCodePoints)
  const normalizedRatio =
    aWarningsPer1000 === 0 ? 0 : Math.round((bWarningsPer1000 / aWarningsPer1000) * 1000) / 1000
  const basis = lengthsComparable
    ? `两侧平均长度相差 ${Math.round(Math.abs(lengthRatio - 1) * 100)}%（≤${AB_LENGTH_TOLERANCE * 100}%），原始计数直接可信`
    : `两侧平均长度相差 ${Math.round(Math.abs(lengthRatio - 1) * 100)}%（>${AB_LENGTH_TOLERANCE * 100}%），以每千码点归一化结果为准`
  const verdict = `${basis}：A ${aWarnings}/${aCodePoints} 码点 = ${aWarningsPer1000}/千码点，B ${bWarnings}/${bCodePoints} 码点 = ${bWarningsPer1000}/千码点（B/A = ${normalizedRatio}）`
  return {
    session_id: metadata.session_id ?? sessionId,
    groupCount,
    aCodePoints,
    bCodePoints,
    aAvgCodePoints,
    bAvgCodePoints,
    lengthRatio,
    lengthsComparable,
    aWarnings,
    bWarnings,
    aWarningsPer1000,
    bWarningsPer1000,
    normalizedRatio,
    verdict,
  }
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
