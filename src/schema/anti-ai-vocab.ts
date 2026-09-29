import { existsSync } from 'node:fs'
import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { readYamlFile } from '../io/yaml.ts'
import { REPO_DEFAULT_ANTI_AI_ELEVATION_REL_PATH, REPO_DEFAULT_ANTI_AI_TEMPLATE_ACTIONS_REL_PATH, type ProjectPaths } from '../io/paths.ts'
import { join } from 'node:path'

/**
 * 反 AI 词表（模板动作 + 段尾升华）—— Story 8；需求规格 §25.1 / 架构设计 §26。
 *
 * 结构（Story 8 起始会裁决）：
 * ```yaml
 * schema_version: "0.1"
 * version: "2026.01"          # 词表变化必须改版本号，运行时写进 reports/linter.yaml
 * actions:                    # 升华词典用 phrases:
 *   - id: TA_001              # EL_NNN
 *     pattern: 沉默了片刻      # 字面匹配，不解释为正则
 *     severity: medium        # high | medium | low
 *     note: ...               # 可选
 * ```
 */

export const ANTI_AI_VOCAB_SCHEMA_VERSION = '0.1'

export const LINTER_SEVERITIES = ['high', 'medium', 'low'] as const
export const linterSeveritySchema = z.enum(LINTER_SEVERITIES)
export type LinterSeverity = z.infer<typeof linterSeveritySchema>

export const templateActionSchema = z.strictObject({
  id: z.string().regex(/^TA_\d{3}$/, '模板动作 ID 必须形如 TA_001'),
  /** 字面匹配的原文子串（不是正则）。 */
  pattern: z.string().min(1),
  severity: linterSeveritySchema,
  note: z.string().min(1).optional(),
})
export type TemplateAction = z.infer<typeof templateActionSchema>

export const elevationPhraseSchema = z.strictObject({
  id: z.string().regex(/^EL_\d{3}$/, '升华词典 ID 必须形如 EL_001'),
  pattern: z.string().min(1),
  severity: linterSeveritySchema,
  note: z.string().min(1).optional(),
})
export type ElevationPhrase = z.infer<typeof elevationPhraseSchema>

function vocabFileSchema<TSchema extends z.ZodTypeAny>(
  itemSchema: TSchema,
  listKey: 'actions' | 'phrases',
  label: string,
): z.ZodType<{ schema_version: '0.1'; version: string; items: z.infer<TSchema>[] }> {
  return z
    .strictObject({
      schema_version: z.literal(ANTI_AI_VOCAB_SCHEMA_VERSION),
      version: z.string().min(1, `${label} 必须有 version（词表变化必须带版本号）`),
      [listKey]: z.array(itemSchema).min(1, `${label} 至少要有 1 条`),
    })
    .transform((value) => {
      const record = value as Record<string, unknown>
      return {
        schema_version: ANTI_AI_VOCAB_SCHEMA_VERSION,
        version: record.version as string,
        items: record[listKey] as z.infer<TSchema>[],
      }
    })
}

export const templateActionsVocabSchema = vocabFileSchema(templateActionSchema, 'actions', '模板动作词表')
export const elevationPhrasesVocabSchema = vocabFileSchema(elevationPhraseSchema, 'phrases', '升华词典')

export class AntiAiVocabError extends Error {
  override readonly name = 'AntiAiVocabError'
  readonly detail: readonly string[]

  constructor(message: string, detail: readonly string[] = []) {
    super(detail.length === 0 ? message : `${message}\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

function readVocab<T>(file: string, schema: z.ZodType<T>, label: string): T {
  const parsed = schema.safeParse(readYamlFile(file))
  if (!parsed.success) {
    throw new AntiAiVocabError(
      `${label}校验失败：${file}`,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data)
}

export interface ResolvedVocabulary<T> {
  readonly file: string
  readonly scope: 'project' | 'repo_default'
  readonly version: string
  readonly items: readonly T[]
}

/**
 * OQ-07：项目级优先，仓库级 fallback。两处都不存在时明确报错（不静默降级成"没有词表"）。
 */
export function loadTemplateActions(
  paths: ProjectPaths,
  repoRoot: string,
): ResolvedVocabulary<TemplateAction> {
  const candidates: Array<{ file: string; scope: 'project' | 'repo_default' }> = [
    { file: paths.antiAiTemplateActions, scope: 'project' },
    { file: join(repoRoot, REPO_DEFAULT_ANTI_AI_TEMPLATE_ACTIONS_REL_PATH), scope: 'repo_default' },
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) continue
    const parsed = readVocab(candidate.file, templateActionsVocabSchema, '模板动作词表')
    return { file: candidate.file, scope: candidate.scope, version: parsed.version, items: parsed.items }
  }
  throw new AntiAiVocabError(
    `找不到模板动作词表：已尝试 ${candidates.map((candidate) => candidate.file).join(' / ')}（OQ-07：项目级优先，仓库级 fallback）`,
  )
}

export function loadElevationPhrases(
  paths: ProjectPaths,
  repoRoot: string,
): ResolvedVocabulary<ElevationPhrase> {
  const candidates: Array<{ file: string; scope: 'project' | 'repo_default' }> = [
    { file: paths.antiAiElevationPhrases, scope: 'project' },
    { file: join(repoRoot, REPO_DEFAULT_ANTI_AI_ELEVATION_REL_PATH), scope: 'repo_default' },
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) continue
    const parsed = readVocab(candidate.file, elevationPhrasesVocabSchema, '升华词典')
    return { file: candidate.file, scope: candidate.scope, version: parsed.version, items: parsed.items }
  }
  throw new AntiAiVocabError(
    `找不到升华词典：已尝试 ${candidates.map((candidate) => candidate.file).join(' / ')}（OQ-07：项目级优先，仓库级 fallback）`,
  )
}
