import { describe, expect, it } from 'vitest'
import {
  checkDialogueRatio,
  checkParagraphEndingElevation,
  checkParagraphLengthVariance,
  checkSentenceLengthVariance,
  checkTemplateActions,
  checkWordFrequency,
  coefficientOfVariation,
  collectDialogueSpans,
  findLiteralMatches,
  splitParagraphs,
  splitSentences,
  type RuleContext,
} from '../../src/linter/rules.ts'
import { DEFAULT_LINTER_THRESHOLDS, resolveLinterThresholds, type LinterThresholds } from '../../src/linter/thresholds.ts'
import {
  LINTER_REPORT_SCHEMA_VERSION,
  linterReportSchema,
  validateLinterReport,
} from '../../src/schema/linter-report.ts'

function context(text: string, overrides: Partial<LinterThresholds> = {}, pattern = '沉默了片刻'): RuleContext {
  return {
    text,
    thresholds: resolveLinterThresholds(overrides),
    templateActions: [
      { id: 'TA_001', pattern, severity: 'medium' },
      { id: 'TA_016', pattern: '仿佛整个世界', severity: 'high' },
    ],
    elevationPhrases: [
      { id: 'EL_001', pattern: '也许，这就是', severity: 'medium' },
      { id: 'EL_005', pattern: '而这一切，才刚刚开始', severity: 'medium' },
    ],
  }
}

let counter = 0
const nextId = (): string => {
  counter += 1
  return `LINT_${String(counter).padStart(3, '0')}`
}
const resetIds = (): void => {
  counter = 0
}

describe('切分与统计工具', () => {
  it('字面匹配（不解释为正则）', () => {
    expect(findLiteralMatches('他沉默了片刻，然后开口。', '沉默了片刻')).toEqual([{ start: 1, end: 6 }])
    // 正则元字符按字面处理
    expect(findLiteralMatches('价格是 3.5 元。', '3.5')).toEqual([{ start: 4, end: 7 }])
    expect(findLiteralMatches('ab', 'a.c')).toEqual([])
  })

  it('句子切分：。！？!? 与换行', () => {
    const sentences = splitSentences('他来了。她走了！真的吗？\n下一段。')
    expect(sentences.map((sentence) => sentence.text.replace(/\n/u, ''))).toEqual(['他来了。', '她走了！', '真的吗？', '下一段。'])
  })

  it('段落切分：blank_line（默认）与 line', () => {
    const text = '第一段。\n\n第二段。\n第三段。'
    expect(splitParagraphs(text, 'blank_line')).toHaveLength(2)
    expect(splitParagraphs(text, 'line')).toHaveLength(3)
  })

  it('对话 span：四种包裹符号', () => {
    const spans = collectDialogueSpans('「走吧。」他说。然后“好”了一声，又说\'行\'。')
    expect(spans.length).toBe(3)
  })

  it('CV = 标准差 / 均值；均值为 0 时返回 0', () => {
    expect(coefficientOfVariation([10, 10, 10])).toBe(0)
    expect(coefficientOfVariation([1, 3])).toBeCloseTo(0.5, 5)
    expect(coefficientOfVariation([])).toBe(0)
  })
})

describe('规则 1：template_actions（字面匹配 + 重复升级）', () => {
  it('命中 ≥1 次按词表 severity；同一 action ≥3 次升 high', () => {
    resetIds()
    const once = checkTemplateActions(context('他沉默了片刻。'), nextId)
    expect(once).toHaveLength(1)
    expect(once[0]).toMatchObject({ rule: 'template_actions', severity: 'medium', linter: 'rule' })
    expect(once[0]?.evidence).toMatchObject({ action_id: 'TA_001', occurrences: 1, severity_basis: 'hit' })

    resetIds()
    const thrice = checkTemplateActions(context('他沉默了片刻。她也沉默了片刻。两人都沉默了片刻。'), nextId)
    expect(thrice[0]).toMatchObject({ severity: 'high' })
    expect(thrice[0]?.evidence).toMatchObject({ occurrences: 3, severity_basis: 'repeated' })
  })

  it('词表里 severity 已是 high 的动作命中即 high', () => {
    resetIds()
    const high = checkTemplateActions(context('仿佛整个世界都静止了。'), nextId)
    expect(high[0]).toMatchObject({ id: 'LINT_001', severity: 'high' })
  })

  it('span 是码点偏移（emoji / 多字节不破坏偏移）', () => {
    resetIds()
    const matches = checkTemplateActions(context('👍他沉默了片刻。'), nextId)
    // 👍 是 1 个码点（不是 2 个 UTF-16 code unit）
    expect(matches[0]?.span).toEqual({ start: 2, end: 7 })
  })

  it('未命中不产生任何输出', () => {
    resetIds()
    expect(checkTemplateActions(context('他把碗推到他面前，什么也没说。'), nextId)).toEqual([])
  })
})

describe('规则 2：sentence_length_variance（CV < 阈值）', () => {
  it('句长过于均匀时触发；长度不足时跳过', () => {
    resetIds()
    const uniform = '他来了。她走了。天亮了。灯灭了。'
    const triggered = checkSentenceLengthVariance(context(uniform, { sentenceLengthMinCodePoints: 0 }), nextId)
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ rule: 'sentence_length_variance', severity: 'medium' })
    expect(triggered[0]?.evidence).toMatchObject({ sentence_count: 4, cv: 0 })

    // 默认阈值下 100 码点以下直接跳过
    resetIds()
    expect(checkSentenceLengthVariance(context(uniform), nextId)).toEqual([])
  })

  it('句长差异明显时不触发', () => {
    resetIds()
    const varied = '他来了他来了他来了他来了他来了他来了他来了。她走了。天。'
    expect(checkSentenceLengthVariance(context(varied, { sentenceLengthMinCodePoints: 0 }), nextId)).toEqual([])
  })
})

describe('规则 3：paragraph_length_variance（CV < 阈值）', () => {
  it('段落长度均匀触发；段落不足 3 段跳过', () => {
    resetIds()
    const text = '他来了，坐下。\n\n她走了，关门。\n\n天亮了，很冷。'
    const triggered = checkParagraphLengthVariance(context(text, { paragraphCountMin: 3 }), nextId)
    expect(triggered).toHaveLength(1)
    expect(triggered[0]?.evidence).toMatchObject({ paragraph_count: 3 })
    resetIds()
    expect(checkParagraphLengthVariance(context('一段。\n\n两段。'), nextId)).toEqual([])
  })
})

describe('规则 4：dialogue_ratio（> 0.85 或 < 0.10）', () => {
  it('对话过量与对话缺失都触发；文本过短跳过', () => {
    resetIds()
    const heavy = `「${'话'.repeat(60)}」`
    const high = checkDialogueRatio(context(heavy, { dialogueMinCodePoints: 0 }), nextId)
    expect(high).toHaveLength(1)
    expect(high[0]?.evidence).toMatchObject({ total_code_points: 62, ratio: 1 })

    resetIds()
    const none = '叙'.repeat(60) + '。'
    const low = checkDialogueRatio(context(none, { dialogueMinCodePoints: 0 }), nextId)
    expect(low).toHaveLength(1)
    expect(low[0]?.severity).toBe('medium')

    // 默认阈值下 200 码点以下直接跳过
    resetIds()
    expect(checkDialogueRatio(context(heavy), nextId)).toEqual([])
    resetIds()
    expect(checkDialogueRatio(context('「早。」'), nextId)).toEqual([])
  })

  it('比例正常时不触发', () => {
    resetIds()
    const balanced = `${'叙'.repeat(30)}「${'话'.repeat(10)}」`
    expect(checkDialogueRatio(context(balanced, { dialogueMinCodePoints: 0 }), nextId)).toEqual([])
  })
})

describe('规则 5：paragraph_ending_elevation（连续 ≥3 段段尾升华）', () => {
  it('连续 3 段段尾命中升华词典才触发', () => {
    resetIds()
    const three = '他关上门。也许，这就是结局。\n\n她走下楼。而这一切，才刚刚开始。\n\n灯灭了。也许，这就是答案。'
    const triggered = checkParagraphEndingElevation(context(three), nextId)
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ rule: 'paragraph_ending_elevation', severity: 'medium' })
    expect(triggered[0]?.evidence).toMatchObject({ consecutive: 3 })
    expect((triggered[0]?.evidence.paragraph_indexes as number[]).length).toBe(3)
  })

  it('只有 2 段连续时不触发；段落数不足时跳过', () => {
    resetIds()
    const two = '他关上门。也许，这就是结局。\n\n她走下楼。而这一切，才刚刚开始。'
    expect(checkParagraphEndingElevation(context(two), nextId)).toEqual([])
    resetIds()
    const short = '也许，这就是结局。'
    expect(checkParagraphEndingElevation(context(short), nextId)).toEqual([])
  })

  it('段尾窗口是最后 16 个非空白码点（中间的升华句不算段尾）', () => {
    resetIds()
    const text = `${'也许，这就是结局。'}${'然'.repeat(40)}他关上门。\n\n${'而这一切，才刚刚开始。'}${'然'.repeat(40)}灯灭了。\n\n${'也许，这就是答案。'}${'然'.repeat(40)}天亮了。`
    expect(checkParagraphEndingElevation(context(text), nextId)).toEqual([])
  })
})

describe('词频类：只进 low_severity_log', () => {
  it('n-gram 重复达到阈值时产生 low 记录，并受 thresholds 控制', () => {
    const text = '他看着她。他看着她。他看着她。'
    const entries = checkWordFrequency(context(text, { wordFrequencyMinOccurrences: 2 }))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]?.kind).toBe('word_frequency')
    expect(entries[0]?.id).toMatch(/^LOW_\d{3}$/)
    // 0 表示关闭
    expect(checkWordFrequency(context(text, { wordFrequencyMinOccurrences: 0 }))).toEqual([])
  })
})

describe('reports/linter.yaml Schema（rule 与 llm 共用）', () => {
  function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: LINTER_REPORT_SCHEMA_VERSION,
      scene_id: 'scene-001',
      generated_at: '2026-01-01T00:00:00.000Z',
      linter: 'rule',
      template_actions_version: '2026.01',
      elevation_phrases_version: '2026.01',
      disabled_rules: [],
      warnings: [],
      low_severity_log: [],
      ...overrides,
    }
  }

  it('rule 报告必须记录两个词表版本', () => {
    expect(linterReportSchema.safeParse(report({ template_actions_version: null })).success).toBe(false)
    expect(linterReportSchema.safeParse(report({ elevation_phrases_version: null })).success).toBe(false)
  })

  it('llm 报告共用同一 Schema（Story 9 不建平行结构）', () => {
    const llm = report({
      linter: 'llm',
      template_actions_version: null,
      elevation_phrases_version: null,
      warnings: [
        {
          id: 'LINT_001',
          linter: 'llm',
          rule: 'author_summary',
          severity: 'medium',
          span: { start: 0, end: 12 },
          text: '他终于明白了生活的意义',
          message: '作者总结：把主题直接说了出来',
          evidence: { pattern: 'summary_statement' },
        },
      ],
    })
    const parsed = validateLinterReport(llm)
    expect(parsed.linter).toBe('llm')
    expect(parsed.warnings[0]?.rule).toBe('author_summary')
  })

  it('词频类不得进 warnings[]；low severity 不得进 warnings[]', () => {
    expect(
      linterReportSchema.safeParse(
        report({
          warnings: [
            {
              id: 'LINT_001',
              linter: 'rule',
              rule: 'word_frequency',
              severity: 'low',
              span: null,
              text: '',
              message: 'x',
              evidence: {},
            },
          ],
        }),
      ).success,
    ).toBe(false)
    expect(
      linterReportSchema.safeParse(
        report({
          warnings: [
            { id: 'LINT_001', linter: 'rule', rule: 'template_actions', severity: 'low', span: null, text: '', message: 'x', evidence: {} },
          ],
        }),
      ).success,
    ).toBe(false)
  })

  it('被关闭的规则不得产生输出，但必须记入 disabled_rules', () => {
    const bad = report({
      disabled_rules: ['template_actions'],
      warnings: [
        {
          id: 'LINT_001',
          linter: 'rule',
          rule: 'template_actions',
          severity: 'medium',
          span: { start: 0, end: 5 },
          text: '沉默了片刻',
          message: 'x',
          evidence: {},
        },
      ],
    })
    expect(linterReportSchema.safeParse(bad).success).toBe(false)
    expect(validateLinterReport(report({ disabled_rules: ['dialogue_ratio'] })).disabled_rules).toEqual(['dialogue_ratio'])
  })

  it('span 必须是码点偏移且 end > start', () => {
    expect(
      linterReportSchema.safeParse(
        report({
          warnings: [
            { id: 'LINT_001', linter: 'rule', rule: 'template_actions', severity: 'medium', span: { start: 5, end: 5 }, text: '', message: 'x', evidence: {} },
          ],
        }),
      ).success,
    ).toBe(false)
  })

  it('warning ID 唯一、disabled_rules 不重复', () => {
    const warning = {
      id: 'LINT_001',
      linter: 'rule',
      rule: 'template_actions',
      severity: 'medium',
      span: { start: 0, end: 5 },
      text: 'x',
      message: 'x',
      evidence: {},
    }
    expect(linterReportSchema.safeParse(report({ warnings: [warning, warning] })).success).toBe(false)
    expect(linterReportSchema.safeParse(report({ disabled_rules: ['dialogue_ratio', 'dialogue_ratio'] })).success).toBe(false)
  })

  it('默认阈值对象是冻结的（不允许运行期被改写）', () => {
    expect(Object.isFrozen(DEFAULT_LINTER_THRESHOLDS)).toBe(false)
    expect(Object.isFrozen(resolveLinterThresholds({}))).toBe(true)
  })
})
