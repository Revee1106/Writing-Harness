import { countNonWhitespaceCodePoints } from '../core/text.ts'
import type { TemplateAction } from '../schema/anti-ai-vocab.ts'
import type { LinterWarning, LowSeverityEntry } from '../schema/linter-report.ts'
import {
  WORD_FREQUENCY_NGRAM_SIZE,
  type LinterThresholds,
} from './thresholds.ts'

/**
 * Rule Linter 的五条确定性 / 统计型规则 —— 需求规格 §25.1；架构设计 §26；Story 8。
 *
 * **只做确定性 / 统计型问题**：作者总结 / 潜台词直说 / 情绪语义重复 / 角色声音趋同 /
 * 解释过度属于 Story 9 的 LLM Linter，Rule Linter **不检测**（非语义证明测试 B）。
 *
 * 所有 span 都是 **Unicode 码点偏移**（OQ-16 口径），且在给定输入下字节级稳定。
 */

export interface RuleContext {
  readonly text: string
  readonly thresholds: LinterThresholds
  readonly templateActions: readonly TemplateAction[]
  readonly elevationPhrases: readonly { readonly id: string; readonly pattern: string; readonly severity: 'high' | 'medium' | 'low' }[]
}

export interface RuleOutcome {
  readonly warnings: readonly LinterWarning[]
  readonly lowSeverity: readonly LowSeverityEntry[]
}

/** 按码点查找字面 pattern 的全部出现位置（不解释为正则）。 */
export function findLiteralMatches(text: string, pattern: string): { start: number; end: number }[] {
  if (pattern === '') return []
  const haystack = [...text]
  const needle = [...pattern]
  const matches: { start: number; end: number }[] = []
  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) matches.push({ start: index, end: index + needle.length })
  }
  return matches
}

/** 句子切分：`。！？!?` 与换行（Story 8 裁决）。 */
export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const points = [...text]
  const sentences: { text: string; start: number; end: number }[] = []
  let bufferStart = 0
  let buffer = ''
  const flush = (endExclusive: number): void => {
    if (countNonWhitespaceCodePoints(buffer) > 0) {
      sentences.push({ text: buffer, start: bufferStart, end: endExclusive })
    }
    buffer = ''
    bufferStart = endExclusive
  }
  points.forEach((point, index) => {
    buffer += point
    if ('。！？!?'.includes(point) || point === '\n') {
      flush(index + 1)
    }
  })
  flush(points.length)
  return sentences
}

/** 段落切分：`blank_line`（连续空行）或 `line`（单个换行）。 */
export function splitParagraphs(text: string, mode: LinterThresholds['paragraphSplit']): { text: string; start: number; end: number }[] {
  const points = [...text]
  const paragraphs: { text: string; start: number; end: number }[] = []
  let bufferStart = 0
  let buffer = ''
  const flush = (endExclusive: number): void => {
    if (countNonWhitespaceCodePoints(buffer) > 0) {
      paragraphs.push({ text: buffer, start: bufferStart, end: endExclusive })
    }
    buffer = ''
    bufferStart = endExclusive
  }
  if (mode === 'line') {
    points.forEach((point, index) => {
      buffer += point
      if (point === '\n') flush(index + 1)
    })
    flush(points.length)
    return paragraphs
  }
  let pendingNewlines = 0
  points.forEach((point, index) => {
    if (point === '\n') {
      pendingNewlines += 1
      if (pendingNewlines >= 2) {
        flush(index + 1 - pendingNewlines + 1)
        pendingNewlines = 0
        bufferStart = index + 1
        return
      }
      buffer += point
      return
    }
    pendingNewlines = 0
    buffer += point
  })
  flush(points.length)
  return paragraphs
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 总体标准差。 */
function stddev(values: readonly number[]): number {
  if (values.length === 0) return 0
  const average = mean(values)
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}

export function coefficientOfVariation(values: readonly number[]): number {
  const average = mean(values)
  if (average === 0) return 0
  return stddev(values) / average
}

/**
 * 规则 1：模板动作列表（字面匹配）。
 * 命中 ≥1 次 → 按词表里的 severity；同一 action 在同一 Scene 命中 ≥ escalate 次 → 升 high。
 */
export function checkTemplateActions(context: RuleContext, nextId: () => string): LinterWarning[] {
  const warnings: LinterWarning[] = []
  for (const action of context.templateActions) {
    const matches = findLiteralMatches(context.text, action.pattern)
    if (matches.length === 0) continue
    const escalated = matches.length >= context.thresholds.templateActionEscalateCount
    const severity = escalated ? 'high' : action.severity
    const first = matches[0] as { start: number; end: number }
    warnings.push({
      id: nextId(),
      linter: 'rule',
      rule: 'template_actions',
      severity,
      span: first,
      text: [...context.text].slice(first.start, first.end).join(''),
      message: escalated
        ? `模板动作「${action.pattern}」在本场出现 ${matches.length} 次（≥${context.thresholds.templateActionEscalateCount} 次，升级为 high）`
        : `模板动作「${action.pattern}」命中（词表 ${action.id}）`,
      evidence: {
        action_id: action.id,
        pattern: action.pattern,
        occurrences: matches.length,
        severity_basis: escalated ? 'repeated' : 'hit',
        spans: matches,
      },
    })
  }
  return warnings
}

/** 规则 2：句长方差（CV < 阈值）。 */
export function checkSentenceLengthVariance(context: RuleContext, nextId: () => string): LinterWarning[] {
  if (countNonWhitespaceCodePoints(context.text) < context.thresholds.sentenceLengthMinCodePoints) return []
  const sentences = splitSentences(context.text)
  if (sentences.length < 3) return []
  const lengths = sentences.map((sentence) => countNonWhitespaceCodePoints(sentence.text))
  const cv = coefficientOfVariation(lengths)
  if (cv >= context.thresholds.sentenceLengthCv) return []
  const first = sentences[0] as { start: number; end: number }
  const last = sentences[sentences.length - 1] as { start: number; end: number }
  return [
    {
      id: nextId(),
      linter: 'rule',
      rule: 'sentence_length_variance',
      severity: 'medium',
      span: { start: first.start, end: last.end },
      text: '',
      message: `句长变异系数 ${cv.toFixed(2)} 低于阈值 ${context.thresholds.sentenceLengthCv}（句子节奏过于均匀，共 ${sentences.length} 句）`,
      evidence: {
        cv: Number(cv.toFixed(4)),
        mean: Number(mean(lengths).toFixed(2)),
        stddev: Number(stddev(lengths).toFixed(2)),
        sentence_count: sentences.length,
        lengths,
      },
    },
  ]
}

/** 规则 3：段长方差（CV < 阈值）。 */
export function checkParagraphLengthVariance(context: RuleContext, nextId: () => string): LinterWarning[] {
  const paragraphs = splitParagraphs(context.text, context.thresholds.paragraphSplit)
  if (paragraphs.length < context.thresholds.paragraphCountMin) return []
  const lengths = paragraphs.map((paragraph) => countNonWhitespaceCodePoints(paragraph.text))
  const cv = coefficientOfVariation(lengths)
  if (cv >= context.thresholds.paragraphLengthCv) return []
  const first = paragraphs[0] as { start: number; end: number }
  const last = paragraphs[paragraphs.length - 1] as { start: number; end: number }
  return [
    {
      id: nextId(),
      linter: 'rule',
      rule: 'paragraph_length_variance',
      severity: 'medium',
      span: { start: first.start, end: last.end },
      text: '',
      message: `段长变异系数 ${cv.toFixed(2)} 低于阈值 ${context.thresholds.paragraphLengthCv}（段落长度过于均匀，共 ${paragraphs.length} 段）`,
      evidence: {
        cv: Number(cv.toFixed(4)),
        mean: Number(mean(lengths).toFixed(2)),
        stddev: Number(stddev(lengths).toFixed(2)),
        paragraph_count: paragraphs.length,
        lengths,
      },
    },
  ]
}

/** 对话码点统计：`「」` / `""` / `''` 包裹（Story 8 裁决）。 */
export function collectDialogueSpans(text: string): { start: number; end: number }[] {
  const pairs: Array<[string, string]> = [
    ['「', '」'],
    ['“', '”'],
    ['‘', '’'],
    ['"', '"'],
    ["'", "'"],
  ]
  const points = [...text]
  const spans: { start: number; end: number }[] = []
  for (const [open, close] of pairs) {
    let cursor = 0
    while (cursor < points.length) {
      const start = points.indexOf(open, cursor)
      if (start < 0) break
      const end = points.indexOf(close, start + 1)
      if (end < 0) break
      spans.push({ start, end: end + 1 })
      cursor = end + 1
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** 规则 4：对话比例（> 0.85 或 < 0.10）。 */
export function checkDialogueRatio(context: RuleContext, nextId: () => string): LinterWarning[] {
  const total = countNonWhitespaceCodePoints(context.text)
  if (total < context.thresholds.dialogueMinCodePoints) return []
  const spans = collectDialogueSpans(context.text)
  const dialogueCodePoints = spans.reduce((sum, span) => sum + countNonWhitespaceCodePoints([...context.text].slice(span.start, span.end).join('')), 0)
  const ratio = total === 0 ? 0 : dialogueCodePoints / total
  const tooHigh = ratio > context.thresholds.dialogueRatioHigh
  const tooLow = ratio < context.thresholds.dialogueRatioLow
  if (!tooHigh && !tooLow) return []
  const first = spans[0]
  const last = spans[spans.length - 1]
  return [
    {
      id: nextId(),
      linter: 'rule',
      rule: 'dialogue_ratio',
      severity: 'medium',
      span: first !== undefined && last !== undefined ? { start: first.start, end: last.end } : null,
      text: '',
      message: tooHigh
        ? `对话占比 ${(ratio * 100).toFixed(1)}% 高于阈值 ${context.thresholds.dialogueRatioHigh * 100}%（叙述几乎消失）`
        : `对话占比 ${(ratio * 100).toFixed(1)}% 低于阈值 ${context.thresholds.dialogueRatioLow * 100}%（对话几乎缺失）`,
      evidence: {
        ratio: Number(ratio.toFixed(4)),
        dialogue_code_points: dialogueCodePoints,
        total_code_points: total,
        dialogue_span_count: spans.length,
      },
    },
  ]
}

/** 规则 5：连续段尾升华（连续 ≥3 段段尾命中升华词典）。 */
export function checkParagraphEndingElevation(context: RuleContext, nextId: () => string): LinterWarning[] {
  const paragraphs = splitParagraphs(context.text, context.thresholds.paragraphSplit)
  if (paragraphs.length < context.thresholds.paragraphCountMin) return []
  const endings = paragraphs.map((paragraph) => {
    const points = [...paragraph.text]
    const nonWhitespaceIndexes: number[] = []
    points.forEach((point, index) => {
      if (!/^\s$/u.test(point)) nonWhitespaceIndexes.push(index)
    })
    const tailIndexes = nonWhitespaceIndexes.slice(-16)
    if (tailIndexes.length === 0) return { text: '', start: paragraph.start, end: paragraph.end }
    const start = tailIndexes[0] as number
    return {
      text: points.slice(start).join(''),
      start: paragraph.start + start,
      end: paragraph.end,
    }
  })

  const warnings: LinterWarning[] = []
  let runStart = -1
  let runLength = 0
  const flush = (endIndexExclusive: number): void => {
    if (runLength >= context.thresholds.elevationConsecutiveParagraphs) {
      const firstParagraph = paragraphs[runStart] as { start: number; end: number }
      const lastParagraph = paragraphs[endIndexExclusive - 1] as { start: number; end: number }
      const matched = endings
        .slice(runStart, endIndexExclusive)
        .flatMap((ending, offset) =>
          context.elevationPhrases
            .filter((phrase) => ending.text.includes(phrase.pattern))
            .map((phrase) => ({ paragraph_index: runStart + offset, phrase_id: phrase.id, pattern: phrase.pattern })),
        )
      warnings.push({
        id: nextId(),
        linter: 'rule',
        rule: 'paragraph_ending_elevation',
        severity: 'medium',
        span: { start: firstParagraph.start, end: lastParagraph.end },
        text: '',
        message: `连续 ${runLength} 段以升华句收尾（≥${context.thresholds.elevationConsecutiveParagraphs} 段）：段尾升华模式`,
        evidence: {
          consecutive: runLength,
          paragraph_indexes: Array.from({ length: runLength }, (_unused, offset) => runStart + offset),
          matched_patterns: matched,
        },
      })
    }
    runStart = -1
    runLength = 0
  }

  endings.forEach((ending, index) => {
    const hit = context.elevationPhrases.some((phrase) => ending.text.includes(phrase.pattern))
    if (hit) {
      if (runStart < 0) runStart = index
      runLength += 1
    } else {
      flush(index)
    }
  })
  flush(endings.length)
  return warnings
}

/**
 * 词频类诊断：**只进 `low_severity_log`**，不进 `warnings[]`（Story 8 裁决）。
 * 采用 n-gram 词频（中文无分词依赖），阈值 = `wordFrequencyMinOccurrences`（0 表示关闭）。
 */
export function checkWordFrequency(context: RuleContext): LowSeverityEntry[] {
  const threshold = context.thresholds.wordFrequencyMinOccurrences
  if (threshold <= 0) return []
  const points = [...context.text].filter((point) => !/^\s$/u.test(point) && !/[\p{P}\p{S}]/u.test(point))
  const counts = new Map<string, number>()
  for (let index = 0; index + WORD_FREQUENCY_NGRAM_SIZE <= points.length; index += 1) {
    const gram = points.slice(index, index + WORD_FREQUENCY_NGRAM_SIZE).join('')
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .slice(0, 5)
    .map(([gram, count], index) => ({
      id: `LOW_${String(index + 1).padStart(3, '0')}`,
      kind: 'word_frequency',
      message: `${WORD_FREQUENCY_NGRAM_SIZE}-gram「${gram}」重复 ${count} 次（词频类，只记日志，不弹给用户）`,
      evidence: { ngram: gram, occurrences: count, ngram_size: WORD_FREQUENCY_NGRAM_SIZE },
    }))
}
