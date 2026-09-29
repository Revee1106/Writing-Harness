import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LLM_LINTER_CONTRACT_ID,
  LLM_REASON_MAX_CODE_POINTS,
  LlmLinterOutputError,
  buildLlmLinterInput,
  parseLlmLinterOutput,
  runLlmLinter,
  validateFindings,
} from '../../src/linter/llm-linter.ts'
import { LLM_LINTER_RULES, LLM_RULE_SEVERITY } from '../../src/linter/llm-rules.ts'
import {
  LOCAL_REWRITE_CONTRACT_ID,
  REWRITE_MAX_LENGTH_RATIO,
  checkRewriteTextFormat,
  locateParagraphs,
  prepareRewrite,
  runLocalRewrite,
  validateRewrite,
} from '../../src/linter/rewrite.ts'
import { llmRelintRange, relintAfterRewrite, ruleRelintRange } from '../../src/linter/relint.ts'
import { loadLinterReport } from '../../src/linter/rule-linter.ts'
import { validateLinterReport } from '../../src/schema/linter-report.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { readTextFile } from '../../src/io/yaml.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR } from '../helpers/story4.ts'
import { StubProvider } from '../helpers/story2.ts'

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story9-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

function cloneProject(projectId: 'demo-01' | 'demo-02'): ReturnType<typeof projectPaths> {
  const root = tempRoot()
  cpSync(join(REPO_ROOT, 'projects', projectId), join(root.dir, projectId), { recursive: true })
  return projectPaths(root.dir, projectId)
}

const recorded = (contract: string): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, contract))

describe('LLM Linter：输出契约与 span 合法性（Story 9 裁决 1/2）', () => {
  it('只接受 findings[] 一个顶层键；五类之外的类型被拒绝', () => {
    expect(parseLlmLinterOutput('findings: []').findings).toEqual([])
    expect(() => parseLlmLinterOutput('findings: []\nextra: 1')).toThrow(LlmLinterOutputError)
    expect(() =>
      parseLlmLinterOutput('findings:\n  - type: pacing_problem\n    span: {start: 0, end: 3}\n    reason: x'),
    ).toThrow(LlmLinterOutputError)
    expect(() =>
      parseLlmLinterOutput('findings:\n  - type: author_summary\n    span: {start: 0, end: 3}'),
    ).toThrow(LlmLinterOutputError)
  })

  it('五类语义类型与 severity 映射固定', () => {
    expect(LLM_LINTER_RULES).toEqual([
      'author_summary',
      'subtext_exposed',
      'emotion_repeated',
      'voice_blur',
      'over_explanation',
    ])
    expect(LLM_RULE_SEVERITY.author_summary).toBe('high')
    expect(LLM_RULE_SEVERITY.subtext_exposed).toBe('high')
    expect(LLM_RULE_SEVERITY.voice_blur).toBe('medium')
  })

  it('span 合法性：越界 / 空回切 / 完全重叠 / reason 过长都会被丢弃并记录 code', () => {
    const text = '他看着她，把筷子搁在碗沿上。'
    const result = validateFindings(
      [
        { type: 'author_summary', span: { start: 0, end: 4 }, reason: 'ok' },
        { type: 'voice_blur', span: { start: 5, end: 999 }, reason: '越界' },
        { type: 'voice_blur', span: { start: 0, end: 4 }, reason: '完全重叠' },
        { type: 'emotion_repeated', span: { start: 4, end: 4 }, reason: '空' },
        { type: 'over_explanation', span: { start: 1, end: 3 }, reason: 'x'.repeat(LLM_REASON_MAX_CODE_POINTS + 1) },
      ],
      text,
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected.map((issue) => issue.code)).toEqual([
      'llm_span_invalid',
      'llm_span_invalid',
      'llm_span_invalid',
      'llm_span_invalid',
    ])
    expect(result.rejected.map((issue) => issue.message).join('\n')).toContain('越界')
    expect(result.rejected.map((issue) => issue.message).join('\n')).toContain('完全重叠')
  })

  it('span 是码点偏移（emoji 不破坏偏移）', () => {
    const text = '👍她看着他。'
    const result = validateFindings([{ type: 'author_summary', span: { start: 1, end: 5 }, reason: 'r' }], text)
    expect(result.accepted[0]?.text).toBe('她看着他')
  })

  it('跑一遍离线 LLM Linter：报告是 linter=llm，两个词表键为 null（裁决 3）', async () => {
    const paths = cloneProject('demo-01')
    const result = await runLlmLinter({
      paths,
      provider: recorded('llm_linter'),
      sceneId: 'scene-001',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(result.report.linter).toBe('llm')
    expect(result.report.template_actions_version).toBeNull()
    expect(result.report.elevation_phrases_version).toBeNull()
    expect(result.report.warnings).toHaveLength(2)
    for (const warning of result.report.warnings) {
      expect(warning.linter).toBe('llm')
      expect(LLM_LINTER_RULES).toContain(warning.rule as never)
      expect(warning.span).not.toBeNull()
      expect(warning.message.length).toBeGreaterThan(0)
      expect(LLM_RULE_SEVERITY[warning.rule as never]).toBe(warning.severity)
    }
    expect(loadLinterReport(paths)).toEqual(result.report)
    expect(readFileSync(paths.linterReport, 'utf8')).toContain('# Last linted scene: scene-001 (llm linter)')
  })

  it('非法 span 不 fail 整个 Linter：丢弃 + low_severity_log[code=llm_span_invalid]', async () => {
    const paths = cloneProject('demo-01')
    const provider = new StubProvider(
      ['findings:', '  - type: author_summary', '    span: {start: 0, end: 99999}', '    reason: 越界'].join('\n'),
    )
    const result = await runLlmLinter({ paths, provider, sceneId: 'scene-001', dryRun: true })
    expect(result.report.warnings).toEqual([])
    expect(result.report.low_severity_log[0]).toMatchObject({ kind: 'llm_span_invalid', code: 'llm_span_invalid' })
  })

  it('输入只包含 Scene 元信息与正文（不给 Blueprint / key_knowledge / 其它 POV 内心）', async () => {
    const paths = cloneProject('demo-01')
    const input = buildLlmLinterInput(
      { scene_id: 'scene-001', pov: 'CH_WOMAN', purpose: 'p', scene_type: 'dialogue', tone: ['conflict'] },
      readTextFile(join(paths.draftsDir, 'scene-001.md')),
    )
    expect(Object.keys(input).sort()).toEqual([
      'reason_max_code_points',
      'scene_meta',
      'scene_text',
      'types',
    ])
    expect(JSON.stringify(input)).not.toContain('PROP_')
    expect(JSON.stringify(input)).not.toContain('key_knowledge')
  })
})

describe('Local Rewrite：契约（Story 9 裁决 3）', () => {
  it('格式校验：引号包裹 / 前缀 / Markdown / 代码围栏都算违约', () => {
    expect(checkRewriteTextFormat('她把筷子搁在碗沿上。')).toEqual([])
    expect(checkRewriteTextFormat('「她把筷子搁在碗沿上。」').length).toBeGreaterThan(0)
    expect(checkRewriteTextFormat('改写：她把筷子搁在碗沿上。').length).toBeGreaterThan(0)
    expect(checkRewriteTextFormat('```\n文本\n```').length).toBeGreaterThan(0)
    expect(checkRewriteTextFormat('## 标题').length).toBeGreaterThan(0)
    expect(checkRewriteTextFormat('- 列表项').length).toBeGreaterThan(0)
  })

  it('长度上限 = 原 span 的 3 倍；超过即违约', () => {
    const original = '她把筷子搁在碗沿上。'
    const tooLong = '她'.repeat(original.length * REWRITE_MAX_LENGTH_RATIO + 10)
    const result = validateRewrite({
      originalSpanText: original,
      rewrittenText: tooLong,
      sceneText: original,
      blueprintCharacterNames: [],
      forbiddenTruthPhrases: [],
      endStatePhrases: [],
    })
    expect(result.ok).toBe(false)
    expect(result.problems.join()).toContain('过长')
  })

  it('不得引入 Scene 中没有的角色、未授权真相，且不得丢掉 end_state 关键短语', () => {
    const sceneText = '她看着他。两人各自沉默，饭没吃完。'
    const newEntity = validateRewrite({
      originalSpanText: '她看着他',
      rewrittenText: '她看着陈默',
      sceneText,
      blueprintCharacterNames: ['陈默'],
      forbiddenTruthPhrases: [],
      endStatePhrases: [],
    })
    expect(newEntity.ok).toBe(false)

    const truthLeak = validateRewrite({
      originalSpanText: '她看着他',
      rewrittenText: '她看着他，想起他删掉了那条道歉消息',
      sceneText,
      blueprintCharacterNames: [],
      forbiddenTruthPhrases: ['删掉了那条道歉消息'],
      endStatePhrases: [],
    })
    expect(truthLeak.ok).toBe(false)

    const brokeEndState = validateRewrite({
      originalSpanText: '饭没吃完',
      rewrittenText: '饭还在桌上',
      sceneText,
      blueprintCharacterNames: [],
      forbiddenTruthPhrases: [],
      endStatePhrases: ['两人各自沉默', '饭没吃完'],
    })
    expect(brokeEndState.ok).toBe(false)
    expect(brokeEndState.problems.join()).toContain('end_state')
  })

  it('替换文本与紧随其后的原文重复 → 被拒绝（防止用重复粘贴凑长度）', () => {
    const sceneText = '那部手机亮了一次，是一条系统提示。'
    const result = validateRewrite({
      originalSpanText: '是一条系统提示',
      rewrittenText: '手机亮了一次，又暗下去。',
      sceneText,
      blueprintCharacterNames: [],
      forbiddenTruthPhrases: [],
      endStatePhrases: [],
    })
    expect(result.ok).toBe(false)
    expect(result.problems.join()).toContain('重复')
  })

  it('原地改写 + 除 span 外字节级一致 + 报告带 rewrite 记录（裁决 4）', async () => {
    const paths = cloneProject('demo-01')
    await runLlmLinter({ paths, provider: recorded('llm_linter'), sceneId: 'scene-001' })
    const before = readTextFile(join(paths.draftsDir, 'scene-001.md'))
    const warning = loadLinterReport(paths)?.warnings[0] as { id: string; span: { start: number; end: number } }
    const result = await runLocalRewrite({
      paths,
      repoRoot: REPO_ROOT,
      provider: recorded('local_rewrite'),
      sceneId: 'scene-001',
      warningId: warning.id,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(result.applied).toBe(true)
    const after = readTextFile(join(paths.draftsDir, 'scene-001.md'))
    const beforePoints = [...before]
    expect(after.startsWith(beforePoints.slice(0, warning.span.start).join(''))).toBe(true)
    expect(after.endsWith(beforePoints.slice(warning.span.end).join(''))).toBe(true)
    expect(after).not.toBe(before)
    const report = loadLinterReport(paths)
    expect(report?.warnings.some((candidate) => candidate.rewrite?.applied === true)).toBe(true)
    const rewritten = report?.warnings.find((candidate) => candidate.rewrite !== undefined)?.rewrite
    expect(rewritten?.rewrite_contract).toBe(`${LOCAL_REWRITE_CONTRACT_ID}@0.1`)
    expect(rewritten?.rewritten_at).toBe('2026-01-01T00:00:00.000Z')
    // 不新增备份文件
    expect(existsSync(join(paths.draftsDir, 'scene-001.md.bak'))).toBe(false)
    expect(readFileSync(paths.draftsDir + '/scene-001.md', 'utf8').includes('##')).toBe(false)
  })

  it('模型原样返回 → applied=false，不改动正文', async () => {
    const paths = cloneProject('demo-02')
    await runLlmLinter({ paths, provider: recorded('llm_linter'), sceneId: 'scene-001' })
    const warning = loadLinterReport(paths)?.warnings[0] as { id: string; text: string }
    const before = readTextFile(join(paths.draftsDir, 'scene-001.md'))
    const result = await runLocalRewrite({
      paths,
      repoRoot: REPO_ROOT,
      provider: new StubProvider(warning.text),
      sceneId: 'scene-001',
      warningId: warning.id,
    })
    expect(result.applied).toBe(false)
    expect(readTextFile(join(paths.draftsDir, 'scene-001.md'))).toBe(before)
  })

  it('违反契约的替换文本被拒绝（不落盘）', async () => {
    const paths = cloneProject('demo-01')
    await runLlmLinter({ paths, provider: recorded('llm_linter'), sceneId: 'scene-002' })
    const widget = loadLinterReport(paths)?.warnings[0] as { id: string }
    const before = readTextFile(join(paths.draftsDir, 'scene-002.md'))
    await expect(
      runLocalRewrite({
        paths,
        repoRoot: REPO_ROOT,
        provider: new StubProvider('改写：她打了一行字，删掉。'),
        sceneId: 'scene-002',
        warningId: widget.id,
      }),
    ).rejects.toThrow(/违反 Rewrite 契约/)
    expect(readTextFile(join(paths.draftsDir, 'scene-002.md'))).toBe(before)
  })

  it('prepareRewrite 与运行时输入一致（fixture 可复现）', async () => {
    const paths = cloneProject('demo-01')
    const target = {
      warning_id: 'LINT_001',
      rule: 'author_summary',
      severity: 'high',
      span: { start: 31, end: 45 },
      text: '',
      message: 'r',
    }
    const prepared = prepareRewrite(paths, 'scene-001', target)
    expect(prepared.input.span_text).toBe(prepared.spanText)
    expect(prepared.spanText.length).toBeGreaterThan(0)
    expect(LOCAL_REWRITE_CONTRACT_ID).toBe('local_rewrite')
    expect(LLM_LINTER_CONTRACT_ID).toBe('llm_linter')
  })
})

describe('局部二次 Linter（Story 9 裁决 5）', () => {
  it('Rule Linter 与 LLM Linter 的重跑范围独立定义（当前均为 ±1 段，但函数分离）', () => {
    const text = '第一段。\n\n第二段，很长的一段文字。\n\n第三段。\n\n第四段。'
    const span = { start: 20, end: 24 }
    expect(ruleRelintRange(text, span)).toEqual(llmRelintRange(text, span))
    // 偏移 10 落在第二段内
    expect(locateParagraphs(text, 10).index).toBe(1)
    expect(locateParagraphs(text, 20).index).toBe(2)
  })

  it('局部重跑只替换范围内旧 warning，范围外不变，且 ID 重新分配不复用', async () => {
    const paths = cloneProject('demo-01')
    // 先造一份"全场统计型"报告：句长/段长方差会覆盖整篇范围
    const first = await import('../../src/linter/rule-linter.ts').then((module) =>
      module.runRuleLinter({ paths, repoRoot: REPO_ROOT, sceneId: 'scene-004' }),
    )
    const beforeIds = first.report.warnings.map((warning) => warning.id)
    const result = await relintAfterRewrite({
      paths,
      repoRoot: REPO_ROOT,
      sceneId: 'scene-004',
      span: { start: 2, end: 6 },
      text: readTextFile(join(paths.draftsDir, 'scene-004.md')),
      scope: 'paragraph',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(result.replacedRange.start).toBeLessThan(2)
    expect(validateLinterReport(result.report)).toBeDefined()
    // ID 连续且唯一（重新分配，不复用旧 ID 的顺序语义）
    const ids = result.report.warnings.map((warning) => warning.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(ids.map((_id, index) => `LINT_${String(index + 1).padStart(3, '0')}`))
    expect(beforeIds.length).toBeGreaterThanOrEqual(0)
  })

  it('--full 等价于整篇范围', async () => {
    const paths = cloneProject('demo-01')
    const text = readTextFile(join(paths.draftsDir, 'scene-005.md'))
    const result = await relintAfterRewrite({
      paths,
      repoRoot: REPO_ROOT,
      sceneId: 'scene-005',
      span: { start: 1, end: 4 },
      text,
      scope: 'full',
    })
    expect(result.replacedRange).toEqual({ start: 0, end: [...text].length })
    expect(loadLinterReport(paths)?.warnings.length).toBe(result.report.warnings.length)
    expect(readFileSync(paths.linterReport, 'utf8')).toContain('full')
  })
})
