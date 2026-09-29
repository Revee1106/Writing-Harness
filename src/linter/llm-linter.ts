import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { hashContractInput } from '../core/hash.ts'
import { countNonWhitespaceCodePoints } from '../core/text.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { extractYamlBlock } from '../interpreter/schema.ts'
import { dumpYaml, readTextFile, writeYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { loadScenes } from '../scenes/service.ts'
import type { LinterProvider } from '../providers/types.ts'
import {
  LINTER_REPORT_SCHEMA_VERSION,
  validateLinterReport,
  type LinterReport,
  type LinterWarning,
  type LowSeverityEntry,
} from '../schema/linter-report.ts'
import { LLM_LINTER_RULES, LLM_RULE_SEVERITY, type LlmRule } from './llm-rules.ts'

/**
 * LLM Linter —— 需求规格 §25.2；架构设计 §27；Story 9。
 *
 * 只做语义型问题（五类）；不做任何统计型检查（那是 Rule Linter 的职责，不得重复报告）。
 * span 使用 Unicode 码点偏移；非法 span **丢弃 + low_severity_log**，不 fail 整个 Linter。
 * LLM Linter **不承诺字节级稳定**（用 fixture 回放保证测试稳定）。
 */

export const LLM_LINTER_CONTRACT_ID = 'llm_linter'
export const LLM_LINTER_CONTRACT_VERSION = '0.1'

/** reason 上限（非空白码点）。 */
export const LLM_REASON_MAX_CODE_POINTS = 200

export class LlmLinterError extends Error {
  override readonly name = 'LlmLinterError'
  constructor(message: string) {
    super(message)
  }
}

const rawFindingSchema = z.strictObject({
  type: z.enum(LLM_LINTER_RULES),
  span: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(1) }),
  reason: z.string().min(1),
})

const rawLlmOutputSchema = z.strictObject({
  findings: z.array(rawFindingSchema),
})
export type RawLlmOutput = z.infer<typeof rawLlmOutputSchema>

export class LlmLinterOutputError extends Error {
  override readonly name = 'LlmLinterOutputError'
  readonly detail: readonly string[]
  readonly rawOutput: string
  constructor(detail: readonly string[], rawOutput: string) {
    super(`LLM Linter 输出不符合契约：\n- ${detail.join('\n- ')}`)
    this.detail = detail
    this.rawOutput = rawOutput
  }
}

export function parseLlmLinterOutput(rawOutput: string): RawLlmOutput {
  let parsed: unknown
  try {
    parsed = parseYaml(extractYamlBlock(rawOutput))
  } catch (error) {
    throw new LlmLinterOutputError([`YAML 解析失败：${(error as Error).message}`], rawOutput)
  }
  const result = rawLlmOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new LlmLinterOutputError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      rawOutput,
    )
  }
  return result.data
}

export interface SpanValidationIssue {
  readonly code: 'llm_span_invalid'
  readonly message: string
  readonly evidence: Record<string, unknown>
}

export interface ValidateFindingsResult {
  readonly accepted: readonly { type: LlmRule; start: number; end: number; reason: string; text: string }[]
  readonly rejected: readonly SpanValidationIssue[]
}

/**
 * span 合法性（Story 9 起始会裁决 2）：
 * `0 ≤ start < end ≤ 码点总数`；回切非空；同一 finding 集合内不得完全重叠。
 * 不合法 → 丢弃 + low_severity_log，不 fail。
 */
export function validateFindings(
  findings: readonly { type: LlmRule; span: { start: number; end: number }; reason: string }[],
  text: string,
): ValidateFindingsResult {
  const points = [...text]
  const accepted: { type: LlmRule; start: number; end: number; reason: string; text: string }[] = []
  const rejected: SpanValidationIssue[] = []
  const seenSpans = new Set<string>()

  findings.forEach((finding, index) => {
    const { start, end } = finding.span
    const reject = (message: string): void => {
      rejected.push({
        code: 'llm_span_invalid',
        message,
        evidence: { index, type: finding.type, start, end, code_point_length: points.length },
      })
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > points.length) {
      reject(`span 越界或顺序非法：start=${start} end=${end}（正文 ${points.length} 个码点）`)
      return
    }
    const slice = points.slice(start, end).join('')
    if (slice.trim() === '') {
      reject(`span 回切为空：start=${start} end=${end}`)
      return
    }
    const key = `${start}:${end}`
    if (seenSpans.has(key)) {
      reject(`span 与同一份输出中的其它 finding 完全重叠：${key}`)
      return
    }
    const reasonCodePoints = countNonWhitespaceCodePoints(finding.reason)
    if (reasonCodePoints === 0) {
      reject('reason 为空')
      return
    }
    if (reasonCodePoints > LLM_REASON_MAX_CODE_POINTS) {
      reject(`reason 过长：${reasonCodePoints} > ${LLM_REASON_MAX_CODE_POINTS} 个非空白码点`)
      return
    }
    seenSpans.add(key)
    accepted.push({ type: finding.type, start, end, reason: finding.reason, text: slice })
  })

  return { accepted, rejected }
}

/** 构造 Prompt Contract 的结构化输入（同时决定 recorded fixture 的查找键）。 */
export function buildLlmLinterInput(
  scene: { readonly scene_id: string; readonly pov: string; readonly purpose: string; readonly scene_type: string; readonly tone: readonly string[] },
  text: string,
): Readonly<Record<string, unknown>> {
  return {
    scene_meta: {
      scene_id: scene.scene_id,
      pov: scene.pov,
      purpose: scene.purpose,
      scene_type: scene.scene_type,
      tone: [...scene.tone],
    },
    scene_text: text,
    types: [...LLM_LINTER_RULES],
    reason_max_code_points: LLM_REASON_MAX_CODE_POINTS,
  }
}

export interface RunLlmLinterOptions {
  readonly paths: ProjectPaths
  readonly provider: LinterProvider
  readonly sceneId: string
  readonly now?: Date | undefined
  readonly dryRun?: boolean | undefined
}

export interface RunLlmLinterResult {
  readonly report: LinterReport
  readonly draftPath: string
  readonly rejected: readonly SpanValidationIssue[]
  readonly prompt: string
  readonly inputSha256: string
  readonly provider: string
  readonly model: string
  readonly written: boolean
  readonly rawOutput: string
}

export async function runLlmLinter(options: RunLlmLinterOptions): Promise<RunLlmLinterResult> {
  const { paths, sceneId } = options
  const scenes = loadScenes(paths)
  const scene = scenes.find((candidate) => candidate.scene_id === sceneId)
  if (scene === undefined) {
    throw new LlmLinterError(`找不到 ${sceneId}（可用：${scenes.map((candidate) => candidate.scene_id).join(' / ')}）`)
  }
  const draftPath = join(paths.draftsDir, `${sceneId}.md`)
  if (!existsSync(draftPath)) {
    throw new LlmLinterError(`找不到 ${draftPath}；请先执行 harness write`)
  }
  const text = readTextFile(draftPath)
  const contract = loadPromptContract(LLM_LINTER_CONTRACT_ID, LLM_LINTER_CONTRACT_VERSION)
  const input = buildLlmLinterInput(scene, text)
  const prompt = renderPrompt(contract, {
    scene_meta: dumpYaml(input.scene_meta).trimEnd(),
    scene_text: text,
  })

  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出严格 YAML（只有 findings 一个顶层键），不输出解释。',
    temperature: 0,
  })

  const parsed = parseLlmLinterOutput(response.text)
  const validation = validateFindings(
    parsed.findings.map((finding) => ({ type: finding.type, span: finding.span, reason: finding.reason })),
    text,
  )

  let sequence = 0
  const warnings: LinterWarning[] = validation.accepted.map((finding) => {
    sequence += 1
    return {
      id: `LINT_${String(sequence).padStart(3, '0')}`,
      linter: 'llm',
      rule: finding.type,
      severity: LLM_RULE_SEVERITY[finding.type],
      span: { start: finding.start, end: finding.end },
      text: finding.text,
      message: `${finding.reason}`,
      evidence: { type: finding.type, reason: finding.reason, span_code_points: finding.end - finding.start },
    }
  })

  let lowSequence = 0
  const lowSeverity: LowSeverityEntry[] = validation.rejected.map((issue) => {
    lowSequence += 1
    return {
      id: `LOW_${String(lowSequence).padStart(3, '0')}`,
      kind: issue.code,
      code: issue.code,
      message: `非法 span 已丢弃（不 fail 整个 Linter）：${issue.message}`,
      evidence: issue.evidence,
    }
  })

  const report = validateLinterReport({
    schema_version: LINTER_REPORT_SCHEMA_VERSION,
    scene_id: sceneId,
    generated_at: (options.now ?? new Date()).toISOString(),
    linter: 'llm',
    template_actions_version: null,
    elevation_phrases_version: null,
    disabled_rules: [],
    warnings,
    low_severity_log: lowSeverity,
  })
  const dryRun = options.dryRun ?? false
  if (!dryRun) {
    writeYamlFile(paths.linterReport, report, {
      headerComments: [
        `Last linted scene: ${sceneId} (llm linter)`,
        'Story 9：LLM Linter 只做语义型检查；span 为 Unicode 码点偏移',
      ],
    })
  }

  return {
    report,
    draftPath,
    rejected: validation.rejected,
    prompt,
    inputSha256: hashContractInput(contract.id, contract.version, input),
    provider: response.provider,
    model: response.model,
    written: !dryRun,
    rawOutput: response.text,
  }
}

