import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readTextFile, writeYamlFile, readYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { loadProjectConfig } from '../project/project.ts'
import { loadElevationPhrases, loadTemplateActions, type ElevationPhrase, type TemplateAction } from '../schema/anti-ai-vocab.ts'
import {
  LINTER_REPORT_SCHEMA_VERSION,
  validateLinterReport,
  type LinterReport,
  type LinterWarning,
} from '../schema/linter-report.ts'
import { loadScenes } from '../scenes/service.ts'
import { resolveLinterThresholds, type LinterThresholds } from './thresholds.ts'
import {
  checkDialogueRatio,
  checkParagraphEndingElevation,
  checkParagraphLengthVariance,
  checkSentenceLengthVariance,
  checkTemplateActions,
  checkWordFrequency,
} from './rules.ts'

/**
 * Rule Linter 运行器 —— 需求规格 §25、§26；架构设计 §26、§28；Story 8。
 *
 * 只报告问题，**不自动 Rewrite**（需求规格 §27）；不写任何状态文件；
 * 结果写入 `reports/linter.yaml`（单文件、末次覆盖，与 Manifest 同一约定）。
 */

export const RULE_LINTER_ID = 'rule'

export class RuleLinterPreconditionError extends Error {
  override readonly name = 'RuleLinterPreconditionError'
  constructor(message: string) {
    super(message)
  }
}

export interface RunRuleLinterOptions {
  readonly paths: ProjectPaths
  readonly repoRoot: string
  readonly sceneId: string
  /** 注入时间以便测试做字节级稳定性断言（Span 稳定性契约）。 */
  readonly now?: Date | undefined
  readonly dryRun?: boolean | undefined
  /** 覆盖项目配置（测试用；正常运行从 project-config.yaml 读取）。 */
  readonly thresholdOverrides?: Partial<LinterThresholds> | undefined
}

export interface RunRuleLinterResult {
  readonly report: LinterReport
  readonly draftPath: string
  readonly thresholds: LinterThresholds
  readonly templateActions: { readonly version: string; readonly file: string; readonly scope: string; readonly count: number }
  readonly elevationPhrases: { readonly version: string; readonly file: string; readonly scope: string; readonly count: number }
  readonly written: boolean
}

function draftPathFor(paths: ProjectPaths, sceneId: string): string {
  return join(paths.draftsDir, `${sceneId}.md`)
}

export function runRuleLinter(options: RunRuleLinterOptions): RunRuleLinterResult {
  const { paths, sceneId } = options
  if (!existsSync(paths.blueprint)) {
    throw new RuleLinterPreconditionError(`找不到 ${paths.blueprint}；请先完成 Gate 2`)
  }
  const scenes = loadScenes(paths)
  if (!scenes.some((scene) => scene.scene_id === sceneId)) {
    throw new RuleLinterPreconditionError(
      `找不到 ${sceneId}（可用：${scenes.map((scene) => scene.scene_id).join(' / ')}）`,
    )
  }
  const draftPath = draftPathFor(paths, sceneId)
  if (!existsSync(draftPath)) {
    throw new RuleLinterPreconditionError(`找不到 ${draftPath}；请先执行 harness write`)
  }

  const config = loadProjectConfig(paths)
  const thresholds = resolveLinterThresholds(
    options.thresholdOverrides === undefined
      ? config.linter.thresholds
      : { ...(config.linter.thresholds ?? {}), ...options.thresholdOverrides },
  )
  const templateActions = loadTemplateActions(paths, options.repoRoot)
  const elevationPhrases = loadElevationPhrases(paths, options.repoRoot)
  const text = readTextFile(draftPath)

  const enabled = config.linter.rules
  const disabledRules = Object.entries(enabled)
    .filter(([, value]) => value === false)
    .map(([key]) => key)
    .sort()

  let sequence = 0
  const nextId = (): string => {
    sequence += 1
    return `LINT_${String(sequence).padStart(3, '0')}`
  }
  const context = {
    text,
    thresholds,
    templateActions: templateActions.items as readonly TemplateAction[],
    elevationPhrases: elevationPhrases.items as readonly ElevationPhrase[],
  }

  const warnings: LinterWarning[] = []
  if (enabled.template_actions) warnings.push(...checkTemplateActions(context, nextId))
  if (enabled.sentence_length_variance) warnings.push(...checkSentenceLengthVariance(context, nextId))
  if (enabled.paragraph_length_variance) warnings.push(...checkParagraphLengthVariance(context, nextId))
  if (enabled.dialogue_ratio) warnings.push(...checkDialogueRatio(context, nextId))
  if (enabled.paragraph_ending_elevation) warnings.push(...checkParagraphEndingElevation(context, nextId))

  // 词频类：只进 low_severity_log，永不进 warnings[]；由 thresholds.wordFrequencyMinOccurrences 控制（0 = 关闭）
  const lowSeverity = checkWordFrequency(context)

  const report = validateLinterReport({
    schema_version: LINTER_REPORT_SCHEMA_VERSION,
    scene_id: sceneId,
    generated_at: (options.now ?? new Date()).toISOString(),
    linter: RULE_LINTER_ID,
    template_actions_version: templateActions.version,
    elevation_phrases_version: elevationPhrases.version,
    disabled_rules: disabledRules,
    warnings,
    low_severity_log: lowSeverity,
  })

  const dryRun = options.dryRun ?? false
  if (!dryRun) {
    writeYamlFile(paths.linterReport, report, {
      headerComments: [
        `Last linted scene: ${sceneId} (rule linter)`,
        `template_actions@${templateActions.version} (${templateActions.scope}) / elevation_phrases@${elevationPhrases.version} (${elevationPhrases.scope})`,
        'Story 8：只报告问题，不自动 Rewrite（需求规格 §27）',
      ],
    })
  }

  return {
    report,
    draftPath,
    thresholds,
    templateActions: {
      version: templateActions.version,
      file: templateActions.file,
      scope: templateActions.scope,
      count: templateActions.items.length,
    },
    elevationPhrases: {
      version: elevationPhrases.version,
      file: elevationPhrases.file,
      scope: elevationPhrases.scope,
      count: elevationPhrases.items.length,
    },
    written: !dryRun,
  }
}

export function loadLinterReport(paths: ProjectPaths): LinterReport | null {
  if (!existsSync(paths.linterReport)) return null
  return validateLinterReport(readYamlFile(paths.linterReport))
}

export interface RunRuleLinterAllResult {
  readonly reports: readonly LinterReport[]
  readonly failures: readonly { readonly sceneId: string; readonly message: string }[]
}

export function runRuleLinterAll(options: Omit<RunRuleLinterOptions, 'sceneId'>): RunRuleLinterAllResult {
  const reports: LinterReport[] = []
  const failures: { sceneId: string; message: string }[] = []
  for (const scene of loadScenes(options.paths)) {
    try {
      reports.push(runRuleLinter({ ...options, sceneId: scene.scene_id }).report)
    } catch (error) {
      failures.push({ sceneId: scene.scene_id, message: (error as Error).message })
    }
  }
  return { reports, failures }
}
