import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AntiAiVocabError,
  elevationPhrasesVocabSchema,
  loadElevationPhrases,
  loadTemplateActions,
  templateActionsVocabSchema,
} from '../../src/schema/anti-ai-vocab.ts'
import {
  DEFAULT_LINTER_THRESHOLDS,
  LINTER_THRESHOLD_KEYS,
  linterThresholdOverridesSchema,
  resolveLinterThresholds,
} from '../../src/linter/thresholds.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject } from '../../src/project/project.ts'
import { writeYamlFile } from '../../src/io/yaml.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-linter-vocab-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

function project(): ReturnType<typeof projectPaths> {
  const root = tempRoot()
  createProject({ projectsRoot: root.dir, projectId: 'lint-vocab' })
  return projectPaths(root.dir, 'lint-vocab')
}

describe('模板动作词表 Schema（Story 8 起始会裁决）', () => {
  it('形态为 {schema_version, version, actions:[{id, pattern, severity, note?}]}', () => {
    const valid = {
      schema_version: '0.1',
      version: '2026.01',
      actions: [{ id: 'TA_001', pattern: '沉默了片刻', severity: 'medium', note: '首版测试项' }],
    }
    const parsed = templateActionsVocabSchema.parse(valid)
    expect(parsed.version).toBe('2026.01')
    expect(parsed.items).toHaveLength(1)
  })

  it('ID 形态、version 必填、severity 枚举都受约束', () => {
    const base = { schema_version: '0.1', version: 'v1', actions: [{ id: 'TA_001', pattern: 'x', severity: 'medium' }] }
    expect(templateActionsVocabSchema.safeParse({ ...base, version: '' }).success).toBe(false)
    expect(
      templateActionsVocabSchema.safeParse({ ...base, actions: [{ id: 'TA_1', pattern: 'x', severity: 'medium' }] }).success,
    ).toBe(false)
    expect(
      templateActionsVocabSchema.safeParse({ ...base, actions: [{ id: 'TA_001', pattern: '', severity: 'medium' }] }).success,
    ).toBe(false)
    expect(
      templateActionsVocabSchema.safeParse({ ...base, actions: [{ id: 'TA_001', pattern: 'x', severity: 'fatal' }] }).success,
    ).toBe(false)
    expect(templateActionsVocabSchema.safeParse({ ...base, actions: [] }).success).toBe(false)
  })

  it('升华词典用 phrases 列表与 EL_NNN 前缀', () => {
    const parsed = elevationPhrasesVocabSchema.parse({
      schema_version: '0.1',
      version: '2026.01',
      phrases: [{ id: 'EL_001', pattern: '也许，这就是', severity: 'medium' }],
    })
    expect(parsed.items[0]?.id).toBe('EL_001')
    expect(
      elevationPhrasesVocabSchema.safeParse({
        schema_version: '0.1',
        version: 'v1',
        phrases: [{ id: 'TA_001', pattern: 'x', severity: 'medium' }],
      }).success,
    ).toBe(false)
  })
})

describe('词表加载：项目级覆盖仓库级（OQ-07）', () => {
  it('没有项目级词表时 fallback 到仓库级默认词表', () => {
    const paths = project()
    const resolved = loadTemplateActions(paths, REPO_ROOT)
    expect(resolved.scope).toBe('repo_default')
    expect(resolved.version).toBe('2026.01')
    expect(resolved.items.length).toBeGreaterThanOrEqual(20)
    const elevation = loadElevationPhrases(paths, REPO_ROOT)
    expect(elevation.scope).toBe('repo_default')
    expect(elevation.items.length).toBeGreaterThanOrEqual(8)
  })

  it('仓库级首版词表包含需求规格 §25.1 点名的五条测试项', () => {
    const paths = project()
    const patterns = loadTemplateActions(paths, REPO_ROOT).items.map((action) => action.pattern)
    for (const named of ['沉默了片刻', '深吸一口气', '苦笑', '眼底闪过', '微微一怔']) {
      expect(patterns, named).toContain(named)
    }
  })

  it('项目级词表存在时优先使用，并保留自己的 version', () => {
    const paths = project()
    mkdirSync(paths.configDir, { recursive: true })
    writeYamlFile(paths.antiAiTemplateActions, {
      schema_version: '0.1',
      version: 'project-2026.02',
      actions: [{ id: 'TA_001', pattern: '本项目专用模板', severity: 'high' }],
    })
    const resolved = loadTemplateActions(paths, REPO_ROOT)
    expect(resolved.scope).toBe('project')
    expect(resolved.version).toBe('project-2026.02')
    expect(resolved.items).toHaveLength(1)

    // 升华词典同理（项目级单独一份）
    writeYamlFile(paths.antiAiElevationPhrases, {
      schema_version: '0.1',
      version: 'project-el-1',
      phrases: [{ id: 'EL_001', pattern: '专属升华句', severity: 'low' }],
    })
    expect(loadElevationPhrases(paths, REPO_ROOT).scope).toBe('project')
    expect(loadElevationPhrases(paths, REPO_ROOT).version).toBe('project-el-1')
  })

  it('两处都不存在或词表非法时明确报错（不静默降级）', () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'lint-novocab' })
    const paths = projectPaths(root.dir, 'lint-novocab')
    const emptyRepo = tempRoot()
    expect(() => loadTemplateActions(paths, emptyRepo.dir)).toThrow(AntiAiVocabError)
    expect(() => loadElevationPhrases(paths, emptyRepo.dir)).toThrow(AntiAiVocabError)

    writeFileSync(paths.antiAiTemplateActions, 'schema_version: "0.1"\nversion: v1\nactions:\n  - id: TA_1\n    pattern: x\n    severity: medium\n', 'utf8')
    mkdirSync(paths.configDir, { recursive: true })
    expect(() => loadTemplateActions(paths, REPO_ROOT)).toThrow(AntiAiVocabError)
  })
})

describe('阈值常量与覆盖（Story 8 起始会裁决）', () => {
  it('默认阈值与裁决一致', () => {
    expect(DEFAULT_LINTER_THRESHOLDS.sentenceLengthCv).toBe(0.3)
    expect(DEFAULT_LINTER_THRESHOLDS.paragraphLengthCv).toBe(0.35)
    expect(DEFAULT_LINTER_THRESHOLDS.dialogueRatioHigh).toBe(0.85)
    expect(DEFAULT_LINTER_THRESHOLDS.dialogueRatioLow).toBe(0.1)
    expect(DEFAULT_LINTER_THRESHOLDS.templateActionEscalateCount).toBe(3)
    expect(DEFAULT_LINTER_THRESHOLDS.elevationConsecutiveParagraphs).toBe(3)
    expect(DEFAULT_LINTER_THRESHOLDS.sentenceLengthMinCodePoints).toBe(100)
    expect(DEFAULT_LINTER_THRESHOLDS.paragraphCountMin).toBe(3)
    expect(DEFAULT_LINTER_THRESHOLDS.dialogueMinCodePoints).toBe(200)
    expect(DEFAULT_LINTER_THRESHOLDS.paragraphSplit).toBe('blank_line')
  })

  it('项目配置可覆盖部分阈值，其余取默认值', () => {
    const resolved = resolveLinterThresholds({ sentenceLengthCv: 0.5, paragraphSplit: 'line' })
    expect(resolved.sentenceLengthCv).toBe(0.5)
    expect(resolved.paragraphSplit).toBe('line')
    expect(resolved.paragraphLengthCv).toBe(DEFAULT_LINTER_THRESHOLDS.paragraphLengthCv)
  })

  it('覆盖项集合与阈值键一一对应（防止漏配/错配）', () => {
    expect([...LINTER_THRESHOLD_KEYS].sort()).toEqual(Object.keys(linterThresholdOverridesSchema.shape).sort())
  })

  it('非法覆盖值被拒绝', () => {
    expect(linterThresholdOverridesSchema.safeParse({ sentenceLengthCv: -1 }).success).toBe(false)
    expect(linterThresholdOverridesSchema.safeParse({ dialogueRatioHigh: 2 }).success).toBe(false)
    expect(linterThresholdOverridesSchema.safeParse({ paragraphSplit: 'sentence' }).success).toBe(false)
    expect(linterThresholdOverridesSchema.safeParse({ paragraphCountMin: 1 }).success).toBe(false)
  })
})
