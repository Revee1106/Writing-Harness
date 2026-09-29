import { existsSync } from 'node:fs'
import { readYamlFile, writeYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { loadProjectConfig } from '../project/project.ts'
import { loadElevationPhrases, loadTemplateActions, type ElevationPhrase, type TemplateAction } from '../schema/anti-ai-vocab.ts'
import {
  LINTER_REPORT_SCHEMA_VERSION,
  validateLinterReport,
  type LinterReport,
  type LinterWarning,
  type LowSeverityEntry,
} from '../schema/linter-report.ts'
import { resolveLinterThresholds } from './thresholds.ts'
import {
  checkDialogueRatio,
  checkParagraphEndingElevation,
  checkParagraphLengthVariance,
  checkSentenceLengthVariance,
  checkTemplateActions,
  checkWordFrequency,
} from './rules.ts'
import { locateParagraphs } from './rewrite.ts'

/**
 * 局部二次 Linter —— 需求规格 §27；Story 9 起始会裁决 5。
 *
 * - **Rule Linter**：只重跑 span 所在段落 + 相邻必要段落；
 * - **LLM Linter**：只检查 span ± 前后一段（由调用方传入局部文本，见 `relintLlmRange`）；
 * - 两个范围**独立定义**，允许不一致；
 * - 局部重跑结果替换该范围内的旧 warning，**范围外不变**；
 * - 重跑后 warning id **重新分配、不复用**；
 * - 终稿前或用户主动请求时跑完整 Linter（`--full`）。
 */

export const RELINT_SCOPES = ['paragraph', 'full'] as const
export type RelintScope = (typeof RELINT_SCOPES)[number]

export class RelintError extends Error {
  override readonly name = 'RelintError'
  constructor(message: string) {
    super(message)
  }
}

export interface RelintOptions {
  readonly paths: ProjectPaths
  /** 仓库根（用于加载仓库级词表 fallback）。 */
  readonly repoRoot: string
  readonly sceneId: string
  readonly span: { readonly start: number; readonly end: number }
  readonly text: string
  readonly scope: RelintScope
  readonly now?: Date | undefined
  /**
   * 需要**保留**的 warning（通常是刚被改写的目标）：它不被替换，
   * 以便 `rewrite` 审计记录留在报告里（Story 9 裁决 4 + 5 的组合语义）。
   */
  readonly keepWarningId?: string | undefined
  /** 磁盘报告的替代来源（运行时传入内存中已带 rewrite 记录的报告）。 */
  readonly previousReport?: LinterReport | undefined
}

export interface RelintResult {
  readonly report: LinterReport
  readonly replacedRange: { readonly start: number; readonly end: number }
  /** 被替换掉的旧 warning ID（不复用）。 */
  readonly replacedWarningIds: readonly string[]
}

function intersects(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

/** Rule Linter 的局部范围 = span 所在段落 + 相邻段落（±1）。 */
export function ruleRelintRange(text: string, span: { start: number; end: number }): { start: number; end: number } {
  const location = locateParagraphs(text, span.start)
  const from = location.paragraphs[Math.max(0, location.index - 1)]
  const to = location.paragraphs[Math.min(location.paragraphs.length - 1, location.index + 1)]
  return { start: from?.start ?? 0, end: to?.end ?? [...text].length }
}

/** LLM Linter 的局部范围 = span ± 前后一段（与 Rule Linter 的范围独立定义）。 */
export function llmRelintRange(text: string, span: { start: number; end: number }): { start: number; end: number } {
  const location = locateParagraphs(text, span.start)
  const from = location.paragraphs[Math.max(0, location.index - 1)]
  const to = location.paragraphs[Math.min(location.paragraphs.length - 1, location.index + 1)]
  return { start: from?.start ?? 0, end: to?.end ?? [...text].length }
}

export async function relintAfterRewrite(options: RelintOptions): Promise<RelintResult> {
  const { paths, sceneId, text } = options
  const range = options.scope === 'full' ? { start: 0, end: [...text].length } : ruleRelintRange(text, options.span)

  const config = loadProjectConfig(paths)
  const thresholds = resolveLinterThresholds(config.linter.thresholds)
  const templateActions = loadTemplateActions(paths, options.repoRoot)
  const elevationPhrases = loadElevationPhrases(paths, options.repoRoot)
  const enabled = config.linter.rules

  const points = [...text]
  const slice = points.slice(range.start, range.end).join('')
  let sequence = 0
  const nextId = (): string => {
    sequence += 1
    return `LINT_${String(sequence).padStart(3, '0')}`
  }
  const context = {
    text: slice,
    thresholds,
    templateActions: templateActions.items as readonly TemplateAction[],
    elevationPhrases: elevationPhrases.items as readonly ElevationPhrase[],
  }

  const localWarnings: LinterWarning[] = []
  if (enabled.template_actions) localWarnings.push(...checkTemplateActions(context, nextId))
  if (enabled.sentence_length_variance) localWarnings.push(...checkSentenceLengthVariance(context, nextId))
  if (enabled.paragraph_length_variance) localWarnings.push(...checkParagraphLengthVariance(context, nextId))
  if (enabled.dialogue_ratio) localWarnings.push(...checkDialogueRatio(context, nextId))
  if (enabled.paragraph_ending_elevation) localWarnings.push(...checkParagraphEndingElevation(context, nextId))

  const lowSeverity: LowSeverityEntry[] = checkWordFrequency(context)

  // 把局部 span 偏移平移到全文
  const shifted = localWarnings.map((warning) => ({
    ...warning,
    span: warning.span === null ? null : { start: warning.span.start + range.start, end: warning.span.end + range.start },
  }))

  // 旧报告：优先用调用方传入的（含 rewrite 记录），否则从磁盘读
  const previous = options.previousReport ?? loadReportIfExists(paths)
  const kept = (previous?.warnings ?? []).filter((warning) => warning.id === options.keepWarningId)
  const outside = (previous?.warnings ?? []).filter((warning) =>
    warning.span === null ? warning.id === options.keepWarningId : !intersects(warning.span, range),
  )
  const replacedIds = (previous?.warnings ?? [])
    .filter(
      (warning) =>
        warning.id !== options.keepWarningId && warning.span !== null && intersects(warning.span, range),
    )
    .map((warning) => warning.id)


  // 重新分配 ID（不复用）：范围外旧 warning 也重新编号，保证全局唯一且连续
  let reassign = 0
  const renumber = (warning: LinterWarning): LinterWarning => {
    reassign += 1
    return { ...warning, id: `LINT_${String(reassign).padStart(3, '0')}` }
  }
  // 避免重复：范围局部重跑若与需保留的 warning 的 span 完全一致，则不重复记录
  const keptSpans = new Set(
    (previous?.warnings ?? [])
      .filter((warning) => warning.id === options.keepWarningId && warning.span !== null)
      .map((warning) => `${warning.span?.start}:${warning.span?.end}`),
  )
  const deduped = shifted.filter(
    (warning) => warning.span === null || !keptSpans.has(`${warning.span.start}:${warning.span.end}`),
  )
  // 需保留的 warning（被改写的目标，含 rewrite 审计记录）与范围外 warning 一起保留
  const merged = [...outside, ...kept].map(renumber).concat(deduped.map(renumber))

  const report = validateLinterReport({
    schema_version: LINTER_REPORT_SCHEMA_VERSION,
    scene_id: sceneId,
    generated_at: (options.now ?? new Date()).toISOString(),
    linter: 'rule',
    template_actions_version: templateActions.version,
    elevation_phrases_version: elevationPhrases.version,
    disabled_rules: Object.entries(enabled)
      .filter(([, value]) => value === false)
      .map(([key]) => key)
      .sort(),
    warnings: merged,
    low_severity_log: lowSeverity,
  })

  writeYamlFile(paths.linterReport, report, {
    headerComments: [
      `Last linted scene: ${sceneId} (rule linter, ${options.scope === 'full' ? 'full' : 'partial re-lint'})`,
      `局部范围：${range.start}-${range.end}（Rule Linter 只重跑该范围；LLM Linter 的范围独立定义）`,
      'Story 9：warning id 重跑后重新分配，不复用',
    ],
  })

  return { report, replacedRange: range, replacedWarningIds: replacedIds }
}

function loadReportIfExists(paths: ProjectPaths): LinterReport | null {
  if (!existsSync(paths.linterReport)) return null
  try {
    return validateLinterReport(readYamlFile(paths.linterReport))
  } catch {
    return null
  }
}
