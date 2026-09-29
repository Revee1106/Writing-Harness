import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RULE_LINTER_ID,
  RuleLinterPreconditionError,
  loadLinterReport,
  runRuleLinter,
  runRuleLinterAll,
} from '../../src/linter/rule-linter.ts'
import { RULE_LINTER_RULES, LLM_LINTER_RULES, SEVERITY_DISPLAY, validateLinterReport } from '../../src/schema/linter-report.ts'
import { loadElevationPhrases, loadTemplateActions } from '../../src/schema/anti-ai-vocab.ts'
import { snapshotProjectState, diffProjectState } from '../../src/writer/writer.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadProjectConfig, saveProjectConfig } from '../../src/project/project.ts'
import { writeYamlFile, readYamlFile } from '../../src/io/yaml.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'

/**
 * Story 8 验收测试（《开发 Story 拆分》Story 8「验收」+ 起始会裁决的三条证明测试）。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story8-')
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

const lintOptions = (paths: ReturnType<typeof projectPaths>) => ({ paths, repoRoot: REPO_ROOT })

describe('验收 A：五条规则全部实现且都有结构化输出', () => {
  it('人工构造的"模板化文本"能触发全部五条规则', () => {
    const paths = cloneProject('demo-01')
    // 文本 A：句长 / 段长高度均匀（触发两条 variance）+ 一条模板动作
    const uniformParagraph = ['他看着她。', '她看着他。', '他看着她。', '她看着他。', '他看着她。'].join('')
    const uniformParagraphs = Array.from({ length: 5 }, (_unused, index) =>
      index === 2 ? uniformParagraph.replace('他看着她。', '他沉默了片刻。') : uniformParagraph,
    )
    writeFileSync(join(paths.draftsDir, 'scene-001.md'), `${uniformParagraphs.join('\n\n')}\n`, 'utf8')

    // 文本 B：对话过量 + 连续段尾升华
    const dialogueBlock = '「走吧。」「好。」「那就算了吧。」「也行。」'.repeat(3)
    const elevationEndings = ['也许，这就是结局。', '而这一切，才刚刚开始。', '也许，这就是答案。']
    const styleParagraphs = Array.from(
      { length: 6 },
      (_unused, index) => `${dialogueBlock}${elevationEndings[index % elevationEndings.length] as string}`,
    )
    writeFileSync(join(paths.draftsDir, 'scene-002.md'), `${styleParagraphs.join('\n\n')}\n`, 'utf8')

    const rules = new Set<string>()
    const warnings: unknown[] = []
    for (const sceneId of ['scene-001', 'scene-002']) {
      const result = runRuleLinter({ ...lintOptions(paths), sceneId, dryRun: true })
      for (const warning of result.report.warnings) {
        rules.add(warning.rule)
        warnings.push(warning)
      }
    }
    for (const rule of RULE_LINTER_RULES) {
      expect([...rules], `规则 ${rule} 未被触发`).toContain(rule)
    }
    for (const warning of warnings as Array<{ id: string; linter: string; severity: string; evidence: Record<string, unknown> }>) {
      expect(warning.id).toMatch(/^LINT_\d{3}$/)
      expect(warning.linter).toBe(RULE_LINTER_ID)
      expect(['high', 'medium']).toContain(warning.severity)
      expect(Object.keys(warning.evidence).length).toBeGreaterThan(0)
    }
  })

  it('模板动作重复 ≥3 次升级为 high（Story 8 阈值）', () => {
    const paths = cloneProject('demo-01')
    writeFileSync(
      join(paths.draftsDir, 'scene-002.md'),
      '他沉默了片刻。她又沉默了片刻。两个人一起沉默了片刻。\n',
      'utf8',
    )
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-002', dryRun: true })
    const finding = result.report.warnings.find((warning) => warning.rule === 'template_actions')
    expect(finding?.severity).toBe('high')
    expect(finding?.evidence).toMatchObject({ occurrences: 3, severity_basis: 'repeated' })
  })

  it('干净文本不产生 warning，也不产生语义型 warning', () => {
    const paths = cloneProject('demo-02')
    writeFileSync(
      join(paths.draftsDir, 'scene-003.md'),
      '他把手放进兜里，停了两秒，才去按那枚按钮。门开的时候，外面比里面亮。\n',
      'utf8',
    )
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-003', dryRun: true })
    expect(result.report.warnings).toEqual([])
  })
})

describe('验收 B：规则可单独关闭', () => {
  it('关闭的规则不产生任何输出，但写入 disabled_rules', () => {
    const paths = cloneProject('demo-01')
    writeFileSync(join(paths.draftsDir, 'scene-004.md'), '他沉默了片刻。她又沉默了片刻。\n', 'utf8')
    const config = loadProjectConfig(paths)
    saveProjectConfig(paths, {
      ...config,
      linter: { ...config.linter, rules: { ...config.linter.rules, template_actions: false, dialogue_ratio: false } },
    })
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-004', dryRun: true })
    expect(result.report.disabled_rules).toEqual(['dialogue_ratio', 'template_actions'])
    expect(result.report.warnings.some((warning) => warning.rule === 'template_actions')).toBe(false)
    expect(result.report.warnings.some((warning) => warning.rule === 'dialogue_ratio')).toBe(false)
    // 其余规则仍可输出
    const allDisabled = { ...config.linter.rules }
    for (const key of Object.keys(allDisabled)) allDisabled[key as keyof typeof allDisabled] = false
    saveProjectConfig(paths, { ...config, linter: { ...config.linter, rules: allDisabled } })
    const silent = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-004', dryRun: true })
    expect(silent.report.warnings).toEqual([])
    expect(silent.report.disabled_rules).toHaveLength(5)
  })

  it('阈值可被 project-config.yaml 覆盖', () => {
    const paths = cloneProject('demo-01')
    const text = '他来了。她走了。天亮了。灯灭了。'
    writeFileSync(join(paths.draftsDir, 'scene-005.md'), `${text}\n`, 'utf8')
    const config = loadProjectConfig(paths)
    // 默认阈值下文本过短 → 跳过
    const skipped = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-005', dryRun: true })
    expect(skipped.report.warnings).toEqual([])
    // 覆盖阈值 → 触发
    saveProjectConfig(paths, {
      ...config,
      linter: { ...config.linter, thresholds: { sentenceLengthMinCodePoints: 0 } },
    })
    const triggered = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-005', dryRun: true })
    expect(triggered.report.warnings.some((warning) => warning.rule === 'sentence_length_variance')).toBe(true)
  })
})

describe('验收 C：测试 A —— 同文本两次运行字节级一致（Span 稳定性契约）', () => {
  it('注入同一 generated_at 时报告逐字节相同', () => {
    const paths = cloneProject('demo-01')
    const options = {
      ...lintOptions(paths),
      sceneId: 'scene-001',
      now: new Date('2026-01-01T00:00:00.000Z'),
    }
    const first = runRuleLinter(options)
    const firstText = readFileSync(paths.linterReport, 'utf8')
    const second = runRuleLinter(options)
    const secondText = readFileSync(paths.linterReport, 'utf8')
    expect(secondText).toBe(firstText)
    expect(second.report).toEqual(first.report)
    // span 稳定：同一输入下偏移不变
    expect(second.report.warnings.map((warning) => JSON.stringify(warning.span))).toEqual(
      first.report.warnings.map((warning) => JSON.stringify(warning.span)),
    )
  })

  it('报告可回读且与运行结果一致（写盘 + 回读）', () => {
    const paths = cloneProject('demo-02')
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-001' })
    expect(existsSync(paths.linterReport)).toBe(true)
    const reloaded = loadLinterReport(paths)
    expect(reloaded).toEqual(result.report)
    expect(validateLinterReport(readYamlFile(paths.linterReport))).toEqual(result.report)
    const raw = readFileSync(paths.linterReport, 'utf8')
    expect(raw.startsWith('# Last linted scene: scene-001')).toBe(true)
  })
})

describe('验收 D：测试 B —— 只含语义问题的文本，Rule Linter 不做语义判定', () => {
  it('测试 B（写死断言）：只允许 paragraph_ending_elevation 命中，其余四条规则必须零命中', () => {
    const paths = cloneProject('demo-01')
    // 这段文本的问题全部是语义型：作者总结 / 潜台词直说 / 情绪重复 / 声音趋同 / 解释过度。
    // 其句长、段长、对话比例都不触发统计阈值，且不含任何模板动作词；
    // 唯一允许命中的是"连续段尾升华"（这本身就是表达层问题，不属于语义判定）。
    const paragraphs = [
      '他终于明白了，原来爱一个人就是愿意为她改变自己，这就是生活的意义。也许，这就是结局。',
      '「我今天很生气。」她说，「真的很生气。」「我知道。」他说。而这一切，才刚刚开始。',
      '她心里很委屈，但她没有说，因为她知道说了也没有用。她放下杯子，站起来，走到窗边，外面的天已经黑了，楼下的路灯一盏一盏亮起来，她站了很久，直到腿有点酸。也许，这就是答案。',
      '她没说。',
      '他们都在等对方先开口。谁也没等到。灯灭了。',
    ]
    writeFileSync(join(paths.draftsDir, 'scene-002.md'), `${paragraphs.join('\n\n')}\n`, 'utf8')
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-002', dryRun: true })
    const rules = result.report.warnings.map((warning) => warning.rule)

    // 写死：唯一允许出现的规则是 paragraph_ending_elevation
    for (const rule of rules) {
      expect(rule, `不允许出现的规则命中：${rule}`).toBe('paragraph_ending_elevation')
    }
    // 其余四条规则必须零命中
    for (const rule of [
      'template_actions',
      'sentence_length_variance',
      'paragraph_length_variance',
      'dialogue_ratio',
    ]) {
      expect(rules, `${rule} 必须零命中`).not.toContain(rule)
    }
    // 语义型规则名一个都不出现
    for (const semanticRule of LLM_LINTER_RULES) {
      expect(rules).not.toContain(semanticRule)
      expect(JSON.stringify(result.report)).not.toContain(semanticRule)
    }
  })
})

describe('验收 E：测试 C —— rule 与 llm 共用同一 Schema', () => {
  it('同一 Schema 能承载 llm 报告（Story 9 不建平行结构）', () => {
    const paths = cloneProject('demo-01')
    const ruleReport = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-001', dryRun: true }).report
    const llmReport = {
      ...ruleReport,
      linter: 'llm' as const,
      template_actions_version: null,
      elevation_phrases_version: null,
      warnings: [
        {
          id: 'LINT_001',
          linter: 'llm' as const,
          rule: 'subtext_exposed',
          severity: 'high' as const,
          span: { start: 0, end: 12 },
          text: '他终于明白了生活的意义',
          message: '潜台词直说',
          evidence: { category: 'subtext_exposed' },
        },
      ],
      low_severity_log: [],
    }
    const validated = validateLinterReport(llmReport)
    expect(validated.linter).toBe('llm')
    expect(Object.keys(validated).sort()).toEqual(Object.keys(ruleReport).sort())
    for (const rule of LLM_LINTER_RULES) {
      expect(
        validateLinterReport({ ...llmReport, warnings: [{ ...llmReport.warnings[0], rule }] }).warnings[0]?.rule,
      ).toBe(rule)
    }
  })

  it('severity 展示策略固定：high 展开 / medium 折叠 / low 仅日志', () => {
    expect(SEVERITY_DISPLAY).toEqual({ high: 'expanded', medium: 'collapsed', low: 'log_only' })
  })
})

describe('验收 F：不自动 Rewrite、不改状态、词表版本入报告', () => {
  it('运行 Linter 不修改任何文件（除 reports/linter.yaml）', () => {
    const paths = cloneProject('demo-01')
    const before = snapshotProjectState(paths)
    const draftBefore = readFileSync(join(paths.draftsDir, 'scene-001.md'), 'utf8')
    runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-001' })
    const after = snapshotProjectState(paths)
    expect(diffProjectState(before, after)).toEqual([])
    expect(readFileSync(join(paths.draftsDir, 'scene-001.md'), 'utf8')).toBe(draftBefore)
  })

  it('报告记录词表版本与被关闭的规则（Story 8 裁决）', () => {
    const paths = cloneProject('demo-01')
    const templateVocab = loadTemplateActions(paths, REPO_ROOT)
    const elevationVocab = loadElevationPhrases(paths, REPO_ROOT)
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-001', dryRun: true })
    expect(result.report.template_actions_version).toBe(templateVocab.version)
    expect(result.report.elevation_phrases_version).toBe(elevationVocab.version)
    const raw = readFileSync(paths.linterReport, 'utf8')
    expect(raw).toContain(`template_actions_version: "${templateVocab.version}"`)
    expect(raw).toContain(`elevation_phrases_version: "${elevationVocab.version}"`)
  })

  it('项目级词表覆盖后，报告记录的 version 也随项目级词表变化', () => {
    const paths = cloneProject('demo-02')
    writeYamlFile(paths.antiAiTemplateActions, {
      schema_version: '0.1',
      version: 'project-v9',
      actions: [{ id: 'TA_001', pattern: '本项目模板', severity: 'high' }],
    })
    writeFileSync(join(paths.draftsDir, 'scene-002.md'), '他本项目模板了一下。\n', 'utf8')
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-002', dryRun: true })
    expect(result.report.template_actions_version).toBe('project-v9')
    expect(result.report.warnings.some((warning) => warning.rule === 'template_actions')).toBe(true)
  })

  it('低噪声：词频类只进 low_severity_log，不进 warnings[]', () => {
    const paths = cloneProject('demo-01')
    writeFileSync(
      join(paths.draftsDir, 'scene-003.md'),
      '他看着她，她看着他，他看着她，她看着他，他看着她。\n',
      'utf8',
    )
    const result = runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-003', dryRun: true })
    expect(result.report.warnings.every((warning) => warning.severity !== 'low')).toBe(true)
    expect(result.report.low_severity_log.length).toBeGreaterThan(0)
    expect(result.report.low_severity_log[0]?.kind).toBe('word_frequency')
  })
})

describe('验收 G：前置条件与批量运行', () => {
  it('没有正文 / 没有 Scene 时明确报错', () => {
    const paths = cloneProject('demo-01')
    rmSync(join(paths.draftsDir, 'scene-004.md'))
    expect(() => runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-004', dryRun: true })).toThrow(
      RuleLinterPreconditionError,
    )
    expect(() => runRuleLinter({ ...lintOptions(paths), sceneId: 'scene-099', dryRun: true })).toThrow(
      RuleLinterPreconditionError,
    )
  })

  it('全部 Scene 批量检查：每场一份报告，磁盘保留最后一场', () => {
    const paths = cloneProject('demo-01')
    const all = runRuleLinterAll({ ...lintOptions(paths) })
    expect(all.failures).toEqual([])
    expect(all.reports).toHaveLength(5)
    expect(all.reports.map((report) => report.scene_id)).toEqual([
      'scene-001',
      'scene-002',
      'scene-003',
      'scene-004',
      'scene-005',
    ])
    expect(loadLinterReport(paths)?.scene_id).toBe('scene-005')
  })

  it('仓库内 demo 项目已提交的 linter.yaml 可回读并通过校验（Story 9 的现成输入）', () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      const report = loadLinterReport(paths)
      expect(report, projectId).not.toBeNull()
      expect(report?.linter).toBe('rule')
      expect(report?.template_actions_version).toBeTruthy()
      expect(report?.elevation_phrases_version).toBeTruthy()
      expect(validateLinterReport(report)).toBeDefined()
    }
  })
})
