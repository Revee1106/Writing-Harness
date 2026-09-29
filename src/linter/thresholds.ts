import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'

/**
 * Rule Linter 的阈值常量（Story 8 起始会裁决）。
 *
 * 全部集中在这里，并**可被 `project-config.yaml` 的 `linter.thresholds` 覆盖**
 * （常量是默认值，项目配置是覆盖层）。
 */
export const LINTER_THRESHOLD_KEYS = [
  'sentenceLengthCv',
  'paragraphLengthCv',
  'dialogueRatioHigh',
  'dialogueRatioLow',
  'templateActionEscalateCount',
  'elevationConsecutiveParagraphs',
  'sentenceLengthMinCodePoints',
  'paragraphCountMin',
  'dialogueMinCodePoints',
  'wordFrequencyMinOccurrences',
  'paragraphSplit',
] as const
export type LinterThresholdKey = (typeof LINTER_THRESHOLD_KEYS)[number]

/** 段落切分口径（"段落切分可配"）。 */
export const PARAGRAPH_SPLITS = ['blank_line', 'line'] as const
export type ParagraphSplit = (typeof PARAGRAPH_SPLITS)[number]

export interface LinterThresholds {
  /** sentence_length_variance：句长变异系数低于该值即提示（默认 0.30）。 */
  readonly sentenceLengthCv: number
  /** paragraph_length_variance：段长变异系数低于该值即提示（默认 0.35）。 */
  readonly paragraphLengthCv: number
  /** dialogue_ratio：高于该值或低于 dialogueRatioLow 即提示。 */
  readonly dialogueRatioHigh: number
  readonly dialogueRatioLow: number
  /** 同一模板动作在同一 Scene 命中 ≥ 该次数时升级为 high（默认 3）。 */
  readonly templateActionEscalateCount: number
  /** 连续 ≥ 该段段尾命中升华词典即触发（默认 3）。 */
  readonly elevationConsecutiveParagraphs: number
  /** 文本不足该码点数时跳过 sentence_length_variance（默认 100）。 */
  readonly sentenceLengthMinCodePoints: number
  /** 段落数不足时跳过 paragraph_length_variance / paragraph_ending_elevation（默认 3）。 */
  readonly paragraphCountMin: number
  /** 文本不足该码点数时跳过 dialogue_ratio（默认 200）。 */
  readonly dialogueMinCodePoints: number
  /** 词频类（只能 low，进 low_severity_log）：同一 n-gram 命中 ≥ 该次数即记录（默认 3；0 表示关闭）。 */
  readonly wordFrequencyMinOccurrences: number
  /** 段落切分方式：连续空行（默认）或单个换行。 */
  readonly paragraphSplit: ParagraphSplit
}

export const DEFAULT_LINTER_THRESHOLDS: LinterThresholds = {
  sentenceLengthCv: 0.3,
  paragraphLengthCv: 0.35,
  dialogueRatioHigh: 0.85,
  dialogueRatioLow: 0.1,
  templateActionEscalateCount: 3,
  elevationConsecutiveParagraphs: 3,
  sentenceLengthMinCodePoints: 100,
  paragraphCountMin: 3,
  dialogueMinCodePoints: 200,
  wordFrequencyMinOccurrences: 3,
  paragraphSplit: 'blank_line',
}

export const linterThresholdOverridesSchema = z.strictObject({
  sentenceLengthCv: z.number().min(0).max(2).optional(),
  paragraphLengthCv: z.number().min(0).max(2).optional(),
  dialogueRatioHigh: z.number().min(0).max(1).optional(),
  dialogueRatioLow: z.number().min(0).max(1).optional(),
  templateActionEscalateCount: z.number().int().min(1).optional(),
  elevationConsecutiveParagraphs: z.number().int().min(2).optional(),
  sentenceLengthMinCodePoints: z.number().int().min(0).optional(),
  paragraphCountMin: z.number().int().min(2).optional(),
  dialogueMinCodePoints: z.number().int().min(0).optional(),
  wordFrequencyMinOccurrences: z.number().int().min(0).optional(),
  paragraphSplit: z.enum(PARAGRAPH_SPLITS).optional(),
})
export type LinterThresholdOverrides = z.infer<typeof linterThresholdOverridesSchema>

export function resolveLinterThresholds(overrides: LinterThresholdOverrides | undefined): LinterThresholds {
  return deepFreeze({ ...DEFAULT_LINTER_THRESHOLDS, ...(overrides ?? {}) }) as LinterThresholds
}

/** 词频类诊断的 n-gram 长度（码点）。 */
export const WORD_FREQUENCY_NGRAM_SIZE = 4
