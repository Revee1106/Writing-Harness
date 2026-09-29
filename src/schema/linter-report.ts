import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { LINTER_SEVERITIES } from './anti-ai-vocab.ts'

/**
 * `reports/linter.yaml` Schema —— Story 8 起始会裁决（OQ-12 的最后一项）。
 *
 * 关键约束：
 * - `linter: rule | llm` **共用同一 Schema**（Story 8/9 不建平行结构）；
 * - `span` 使用 **Unicode 码点偏移**（OQ-16 口径；`start` 含、`end` 不含）；
 * - 顶部记录 `template_actions_version` / `elevation_phrases_version` / `disabled_rules`；
 * - `evidence` 按规则固定结构（OQ-53）；
 * - 词频类只进 `low_severity_log`，**不进 `warnings[]`**；
 * - **Span 稳定性契约**：给定输入下字节级稳定（`generated_at` 可注入），rewrite 后必须重跑 Linter。
 */

export const LINTER_REPORT_SCHEMA_VERSION = '0.1'

export const LINTER_KINDS = ['rule', 'llm'] as const
export type LinterKind = (typeof LINTER_KINDS)[number]

/** Story 8 的 Rule Linter 规则名（Story 9 的语义类型共用 warnings[]，但 rule 值不同）。 */
export const RULE_LINTER_RULES = [
  'template_actions',
  'sentence_length_variance',
  'paragraph_length_variance',
  'dialogue_ratio',
  'paragraph_ending_elevation',
] as const
export type RuleLinterRule = (typeof RULE_LINTER_RULES)[number]

/** Story 9 的语义类型（此处只用于校验同一 Schema 能承载，Story 8 不产生）。 */
export const LLM_LINTER_RULES = [
  'author_summary',
  'subtext_exposed',
  'emotion_repeated',
  'voice_blur',
  'over_explanation',
] as const

export const linterSpanSchema = z
  .strictObject({
    /** Unicode 码点偏移（含）。 */
    start: z.number().int().min(0),
    /** Unicode 码点偏移（不含），必须大于 start。 */
    end: z.number().int().min(1),
  })
  .refine((span) => span.end > span.start, { error: () => ({ message: 'span.end 必须大于 span.start' }) })

export const linterWarningSchema = z.strictObject({
  id: z.string().regex(/^LINT_\d{3}$/, 'warning ID 必须形如 LINT_001'),
  linter: z.enum(LINTER_KINDS),
  rule: z.string().min(1),
  severity: z.enum(LINTER_SEVERITIES),
  /** 统计型问题可以是整段/整篇范围；无明确位置时为 null。 */
  span: linterSpanSchema.nullable(),
  /** 出问题的原文片段（码点级截取）。 */
  text: z.string(),
  message: z.string().min(1),
  /** 按规则固定的结构（OQ-53）。 */
  evidence: z.record(z.string(), z.unknown()),
  /**
   * Local Rewrite 的落回记录（Story 9 起始会裁决 4）：
   * 原地改写 `drafts/scene-NNN.md`，并把 before / after 与契约版本记在对应 warning 上；
   * **不新增备份文件**、v0.1 不实现自动回滚。
   */
  rewrite: z
    .strictObject({
      applied: z.boolean(),
      before: z.string(),
      after: z.string(),
      rewrite_contract: z.string().min(1),
      rewritten_at: z.string().min(1),
    })
    .optional(),
})
export type LinterWarning = z.infer<typeof linterWarningSchema>

export const lowSeverityEntrySchema = z.strictObject({
  id: z.string().regex(/^LOW_\d{3}$/, 'low severity 记录 ID 必须形如 LOW_001'),
  kind: z.string().min(1),
  /**
   * Story 9 起始会裁决：低级别日志带稳定 code（例如 `llm_span_invalid`），
   * 便于测试与工具消费；Story 8 的词频类条目可省略该字段。
   */
  code: z.string().min(1).optional(),
  message: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()),
})
export type LowSeverityEntry = z.infer<typeof lowSeverityEntrySchema>

export const linterReportSchema = z
  .strictObject({
    schema_version: z.literal(LINTER_REPORT_SCHEMA_VERSION),
    scene_id: z.string().regex(ID_PATTERNS.scene, 'scene_id 必须是 scene-###'),
    generated_at: z.string().min(1),
    linter: z.enum(LINTER_KINDS),
    /**
     * rule 报告必填；llm 报告**保留键、值为 `null`**（Story 9 起始会裁决 3）：
     * 这样 rule 与 llm 共用同一 Schema、键集合完全一致，工具与测试不需要分支处理。
     */
    template_actions_version: z.string().min(1).nullable(),
    elevation_phrases_version: z.string().min(1).nullable(),
    /** 被项目配置关闭的规则（关闭的规则不产生任何输出，但要记录在这里）。 */
    disabled_rules: z.array(z.string().min(1)),
    warnings: z.array(linterWarningSchema),
    low_severity_log: z.array(lowSeverityEntrySchema),
  })
  .superRefine((report, ctx) => {
    if (report.linter === 'rule' && report.template_actions_version === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['template_actions_version'],
        message: 'rule 报告必须记录 template_actions_version（Story 8 起始会裁决）',
      })
    }
    if (report.linter === 'rule' && report.elevation_phrases_version === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['elevation_phrases_version'],
        message: 'rule 报告必须记录 elevation_phrases_version（Story 8 起始会裁决）',
      })
    }
    // 词频类只能进 low_severity_log
    for (const warning of report.warnings) {
      if (warning.rule === 'word_frequency') {
        ctx.addIssue({
          code: 'custom',
          path: ['warnings'],
          message: '词频类诊断只能进 low_severity_log，不能出现在 warnings[]（Story 8 起始会裁决）',
        })
      }
      if (warning.severity === 'low') {
        ctx.addIssue({
          code: 'custom',
          path: ['warnings'],
          message: `warnings[] 中不允许 low severity（low 一律进 low_severity_log）：${warning.id}`,
        })
      }
    }
    const ids = report.warnings.map((warning) => warning.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['warnings'], message: 'warning ID 必须唯一（Span 稳定性契约）' })
    }
    const disabled = report.disabled_rules
    if (new Set(disabled).size !== disabled.length) {
      ctx.addIssue({ code: 'custom', path: ['disabled_rules'], message: 'disabled_rules 不允许重复' })
    }
    for (const warning of report.warnings) {
      if (warning.rewrite !== undefined && warning.rewrite.applied && warning.rewrite.before === warning.rewrite.after) {
        ctx.addIssue({
          code: 'custom',
          path: ['warnings'],
          message: `${warning.id}.rewrite.applied=true 但 before 与 after 相同（Story 9 裁决：无法改写时应输出原文并记 applied=false）`,
        })
      }
      if (disabled.includes(warning.rule)) {
        ctx.addIssue({
          code: 'custom',
          path: ['warnings'],
          message: `规则 ${warning.rule} 已被关闭，不应产生输出（Story 8 起始会裁决）`,
        })
      }
    }
  })
export type LinterReport = z.infer<typeof linterReportSchema>

export class LinterReportValidationError extends Error {
  override readonly name = 'LinterReportValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`linter 报告校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateLinterReport(value: unknown): LinterReport {
  const parsed = linterReportSchema.safeParse(value)
  if (!parsed.success) {
    throw new LinterReportValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data) as LinterReport
}

/** 需求规格 §25.3 / Story 8 裁决：high 默认展开、medium 默认折叠、low 仅日志。 */
export const SEVERITY_DISPLAY = {
  high: 'expanded',
  medium: 'collapsed',
  low: 'log_only',
} as const
