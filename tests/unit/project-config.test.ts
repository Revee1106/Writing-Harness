import { describe, expect, it } from 'vitest'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'
import {
  DRAFT_CONTEXT_MAX_CHARS_DEFAULT,
  DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED,
  DEFAULT_LINTER_RULES,
  LINTER_RULE_KEYS,
  PROJECT_CONFIG_SCHEMA_VERSION,
  ProjectConfigValidationError,
  TARGET_LENGTH_SUPPORTED,
  TARGET_LENGTH_UNIT,
  checkProjectConfigWarnings,
  createDefaultProjectConfig,
  projectConfigSchema,
  validateProjectConfig,
  type ProjectConfig,
} from '../../src/schema/project-config.ts'

const CREATED_AT = '2026-01-01T00:00:00.000Z'

function defaultConfig(): ProjectConfig {
  return createDefaultProjectConfig({ projectId: 'demo-01', title: '演示', createdAt: CREATED_AT, targetLength: 8000 })
}

describe('project-config.yaml 最小 schema（Story 1 验收增强第 1 条 / D6 裁决）', () => {
  it('包含版本、linter 规则开关位、draft_context.max_chars 三个必备部分', () => {
    const config = defaultConfig()
    expect(config.schema_version).toBe(PROJECT_CONFIG_SCHEMA_VERSION)
    expect(Object.keys(config.linter.rules)).toEqual([...LINTER_RULE_KEYS])
    expect(config.draft_context.max_chars).toBe(DRAFT_CONTEXT_MAX_CHARS_DEFAULT)
  })

  it('linter 规则开关位等于需求规格 §25.1 的 5 条默认规则', () => {
    expect(LINTER_RULE_KEYS).toEqual([
      'template_actions',
      'sentence_length_variance',
      'paragraph_length_variance',
      'dialogue_ratio',
      'paragraph_ending_elevation',
    ])
    expect(DEFAULT_LINTER_RULES).toEqual({
      template_actions: true,
      sentence_length_variance: true,
      paragraph_length_variance: true,
      dialogue_ratio: true,
      paragraph_ending_elevation: true,
    })
  })

  it('draft_context 使用需求规格 §19.1 的 mode 与默认值', () => {
    const config = defaultConfig()
    expect(config.draft_context.mode).toBe('same_pov_previous')
    expect(DRAFT_CONTEXT_MAX_CHARS_DEFAULT).toBe(600)
    expect(DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED).toEqual({ min: 500, max: 800 })
  })

  it('target_length 的单位是中文字数（D6 裁决）', () => {
    expect(TARGET_LENGTH_UNIT).toBe('cjk_chars')
    expect(TARGET_LENGTH_SUPPORTED).toEqual({ min: 1000, max: 30000 })
    expect(defaultConfig().project.target_length).toBe(8000)
  })

  it('缺少任一规则开关位会被拒绝（结构完整性）', () => {
    const config = defaultConfig()
    const { template_actions: _omitted, ...restRules } = config.linter.rules
    expect(
      projectConfigSchema.safeParse({ ...config, linter: { rules: restRules } }).success,
    ).toBe(false)
  })

  it('拒绝文档未定义的规则键', () => {
    const config = defaultConfig()
    expect(
      projectConfigSchema.safeParse({
        ...config,
        linter: { rules: { ...config.linter.rules, word_frequency: true } },
      }).success,
    ).toBe(false)
  })

  it('拒绝未知的 draft_context.mode 与非法 max_chars', () => {
    const config = defaultConfig()
    expect(
      projectConfigSchema.safeParse({ ...config, draft_context: { mode: 'previous_scene', max_chars: 600 } }).success,
    ).toBe(false)
    for (const maxChars of [0, -5, 1.5]) {
      expect(
        projectConfigSchema.safeParse({ ...config, draft_context: { ...config.draft_context, max_chars: maxChars } })
          .success,
        `max_chars=${maxChars} 应被拒绝`,
      ).toBe(false)
    }
  })

  it('校验 project.id / created_at', () => {
    const config = defaultConfig()
    expect(projectConfigSchema.safeParse({ ...config, project: { ...config.project, id: 'Demo_01' } }).success).toBe(false)
    expect(
      projectConfigSchema.safeParse({ ...config, project: { ...config.project, created_at: '不是时间' } }).success,
    ).toBe(false)
  })

  it('校验失败时抛出携带明细的 ProjectConfigValidationError', () => {
    expect(() => validateProjectConfig({ schema_version: '0.1' })).toThrow(ProjectConfigValidationError)
  })

  it('YAML 往返一致', () => {
    const config = defaultConfig()
    expect(validateProjectConfig(loadYaml(dumpYaml(config)))).toEqual(config)
  })
})

describe('规则开关可单条关闭并持久化（需求规格 §26 / 架构设计 §28）', () => {
  it('关闭单条规则不影响其他规则，且可回读', () => {
    const config = defaultConfig()
    const updated: ProjectConfig = {
      ...config,
      linter: { rules: { ...config.linter.rules, template_actions: false } },
    }
    const reloaded = validateProjectConfig(loadYaml(dumpYaml(updated)))
    expect(reloaded.linter.rules.template_actions).toBe(false)
    expect(reloaded.linter.rules.sentence_length_variance).toBe(true)
    expect(reloaded.linter.rules.dialogue_ratio).toBe(true)
  })
})

describe('推荐区间只告警不报错（解读 I-3 / I-4）', () => {
  it('默认配置无告警', () => {
    expect(checkProjectConfigWarnings(defaultConfig())).toEqual([])
  })

  it('draft_context.max_chars 超出 500～800 时给出 warning 而非错误', () => {
    const config = defaultConfig()
    for (const maxChars of [400, 900]) {
      const next: ProjectConfig = { ...config, draft_context: { ...config.draft_context, max_chars: maxChars } }
      expect(validateProjectConfig(next).draft_context.max_chars).toBe(maxChars)
      expect(checkProjectConfigWarnings(next).map((notice) => notice.code)).toContain(
        'DRAFT_CONTEXT_MAX_CHARS_OUT_OF_RECOMMENDED_RANGE',
      )
    }
    for (const maxChars of [500, 600, 800]) {
      const next: ProjectConfig = { ...config, draft_context: { ...config.draft_context, max_chars: maxChars } }
      expect(checkProjectConfigWarnings(next)).toEqual([])
    }
  })

  it('target_length 超出 1,000～30,000 时给出 warning 而非错误', () => {
    const config = defaultConfig()
    for (const targetLength of [500, 40000]) {
      const next: ProjectConfig = { ...config, project: { ...config.project, target_length: targetLength } }
      expect(validateProjectConfig(next).project.target_length).toBe(targetLength)
      expect(checkProjectConfigWarnings(next).map((notice) => notice.code)).toContain(
        'TARGET_LENGTH_OUT_OF_SUPPORTED_RANGE',
      )
    }
    for (const targetLength of [1000, 30000]) {
      const next: ProjectConfig = { ...config, project: { ...config.project, target_length: targetLength } }
      expect(checkProjectConfigWarnings(next)).toEqual([])
    }
  })

  it('target_length 为 null 表示未定，不产生告警', () => {
    const config = createDefaultProjectConfig({ projectId: 'demo-01', createdAt: CREATED_AT })
    expect(config.project.target_length).toBeNull()
    expect(checkProjectConfigWarnings(config)).toEqual([])
  })
})
