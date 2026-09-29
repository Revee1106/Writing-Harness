import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'

/**
 * `project-config.yaml` 最小 Schema —— Story 1 验收增强项（D6 裁决）。
 *
 * 三份冻结文档只给了这个文件名与碎片用途（需求规格 §19.1 draft_context、§26 / §28 规则开关），
 * 没有定义任何字段。按 Story 1 的验收增强要求，这里在 Story 1 就给出最小 schema，
 * 不留到 Story 6 再补。每个字段的来源在下方逐条标注。
 */

export const PROJECT_CONFIG_SCHEMA_VERSION = '0.1'

/**
 * Rule Linter 的规则开关位（需求规格 §25.1 定义的 5 条默认规则；架构设计 §26 同）。
 * 文档只给了中文规则名，键名为 Story 1 提议的规范化命名（D6 裁决采纳）。
 */
export const LINTER_RULE_KEYS = [
  'template_actions',
  'sentence_length_variance',
  'paragraph_length_variance',
  'dialogue_ratio',
  'paragraph_ending_elevation',
] as const
export type LinterRuleKey = (typeof LINTER_RULE_KEYS)[number]

export const DEFAULT_LINTER_RULES: Readonly<Record<LinterRuleKey, boolean>> = {
  template_actions: true,
  sentence_length_variance: true,
  paragraph_length_variance: true,
  dialogue_ratio: true,
  paragraph_ending_elevation: true,
}

/** 需求规格 §19.1 / 架构设计 §19：v0.1 只有一种 Draft Context 选择模式。 */
export const DRAFT_CONTEXT_MODES = ['same_pov_previous'] as const
export const DRAFT_CONTEXT_MAX_CHARS_DEFAULT = 600
/**
 * OQ-16 裁决：`draft_context.max_chars` 的计数口径 =
 * **Unicode 码点、含所有非空白字符、不含空白 / 换行 / 制表符**
 * （实现见 `src/core/text.ts` 的 `countNonWhitespaceCodePoints`）。
 */
export const DRAFT_CONTEXT_MAX_CHARS_UNIT = 'non_whitespace_code_points'
/** 需求规格 §19.1："max_chars v0.1 推荐允许 500～800 范围配置"—— 推荐区间，不设硬门槛（解读 I-3）。 */
export const DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED = { min: 500, max: 800 } as const

/** D6 裁决：`project.target_length` 的单位是**中文字数**。 */
export const TARGET_LENGTH_UNIT = 'cjk_chars'
/** 需求规格 §1 / §30：目标篇幅 1,000～30,000 字 —— 支持区间（超出给 warning，不报错，解读 I-4）。 */
export const TARGET_LENGTH_SUPPORTED = { min: 1000, max: 30000 } as const

const isoDateStringSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'created_at 必须是可解析的 ISO-8601 时间字符串')

export const projectConfigSchema = z.strictObject({
  schema_version: z.literal(PROJECT_CONFIG_SCHEMA_VERSION),
  project: z.strictObject({
    /** OQ-20 / D7：项目 id 同时是项目目录名。 */
    id: z.string().regex(ID_PATTERNS.projectId, 'project.id 必须是 slug（^[a-z0-9][a-z0-9_-]{0,63}$，解读 I-5）'),
    title: z.string().nullable(),
    /** 解读 I-6：ISO-8601，可注入以保证 golden 快照可复现。 */
    created_at: isoDateStringSchema,
    /** D6 裁决：单位 = 中文字数（TARGET_LENGTH_UNIT）。 */
    target_length: z.number().int().positive().nullable(),
  }),
  linter: z.strictObject({
    rules: z.strictObject(
      Object.fromEntries(LINTER_RULE_KEYS.map((key) => [key, z.boolean()])) as Record<LinterRuleKey, z.ZodBoolean>,
    ),
  }),
  /** 需求规格 §19.1 原文结构。 */
  draft_context: z.strictObject({
    mode: z.enum(DRAFT_CONTEXT_MODES),
    /** 计数口径：Unicode 码点、含所有非空白字符、不含空白 / 换行 / 制表符（OQ-16）。 */
    max_chars: z.number().int().positive(),
  }),
})
export type ProjectConfig = z.infer<typeof projectConfigSchema>

export interface ProjectConfigNotice {
  readonly code: string
  readonly message: string
}

/** 非致命提示：推荐区间之外不报错，但要可见（解读 I-3 / I-4）。 */
export function checkProjectConfigWarnings(config: ProjectConfig): ProjectConfigNotice[] {
  const notices: ProjectConfigNotice[] = []
  const { max_chars: maxChars } = config.draft_context
  if (maxChars < DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED.min || maxChars > DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED.max) {
    notices.push({
      code: 'DRAFT_CONTEXT_MAX_CHARS_OUT_OF_RECOMMENDED_RANGE',
      message: `draft_context.max_chars=${maxChars} 超出需求规格 §19.1 推荐区间 ${DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED.min}～${DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED.max}`,
    })
  }
  const targetLength = config.project.target_length
  if (
    targetLength !== null &&
    (targetLength < TARGET_LENGTH_SUPPORTED.min || targetLength > TARGET_LENGTH_SUPPORTED.max)
  ) {
    notices.push({
      code: 'TARGET_LENGTH_OUT_OF_SUPPORTED_RANGE',
      message: `project.target_length=${targetLength} 超出 v0.1 支持区间 ${TARGET_LENGTH_SUPPORTED.min}～${TARGET_LENGTH_SUPPORTED.max} 中文字（需求规格 §1 / §30）`,
    })
  }
  return notices
}

export class ProjectConfigValidationError extends Error {
  override readonly name = 'ProjectConfigValidationError'
  readonly detail: readonly string[]

  constructor(detail: readonly string[]) {
    super(`project-config.yaml 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  const parsed = projectConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new ProjectConfigValidationError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
        return `${path}: ${issue.message}`
      }),
    )
  }
  return deepFreeze(parsed.data) as ProjectConfig
}

export interface DefaultProjectConfigInput {
  readonly projectId: string
  readonly title?: string | null | undefined
  readonly createdAt: string
  readonly targetLength?: number | null | undefined
}

export function createDefaultProjectConfig(input: DefaultProjectConfigInput): ProjectConfig {
  return {
    schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
    project: {
      id: input.projectId,
      title: input.title ?? null,
      created_at: input.createdAt,
      target_length: input.targetLength ?? null,
    },
    linter: { rules: { ...DEFAULT_LINTER_RULES } },
    draft_context: {
      mode: 'same_pov_previous',
      max_chars: DRAFT_CONTEXT_MAX_CHARS_DEFAULT,
    },
  }
}
