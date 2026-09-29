import { describe, expect, it } from 'vitest'
import {
  countAllCodePoints,
  countNonWhitespaceCodePoints,
  takeLastNonWhitespaceCodePoints,
} from '../../src/core/text.ts'
import {
  StyleProfileValidationError,
  createEmptyStyleProfile,
  nextSampleId,
  sampleTextForWriter,
  styleProfileSchema,
  validateStyleProfile,
} from '../../src/schema/style-profile.ts'
import {
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  EXCLUSION_REASONS,
  contextManifestSchema,
  validateContextManifest,
} from '../../src/schema/context-manifest.ts'

describe('文本计数口径（OQ-16 裁决）', () => {
  it('按 Unicode 码点计，含所有非空白字符，不含空白 / 换行 / 制表符', () => {
    expect(countNonWhitespaceCodePoints('你好 世界')).toBe(4)
    expect(countNonWhitespaceCodePoints('a b\tc\nd\re')).toBe(5)
    expect(countNonWhitespaceCodePoints('　全角空格　也算空白')).toBe(8)
    expect(countNonWhitespaceCodePoints('')).toBe(0)
    expect(countNonWhitespaceCodePoints('   \n\t ')).toBe(0)
  })

  it('emoji 与代理对按 1 个码点计（不是 UTF-16 code unit）', () => {
    expect(countAllCodePoints('👍')).toBe(1)
    expect(countNonWhitespaceCodePoints('👍')).toBe(1)
    expect(countNonWhitespaceCodePoints('好👍')).toBe(2)
    // 中文标点算非空白
    expect(countNonWhitespaceCodePoints('好，。！？')).toBe(5)
  })

  it('取末尾 N 个非空白码点：保留原文中的空白，不压缩', () => {
    const text = '第一句。\n\n第二句，带 空格。'
    const truncated = takeLastNonWhitespaceCodePoints(text, 5)
    expect(truncated.countedCodePoints).toBe(5)
    expect(text.endsWith(truncated.text)).toBe(true)
    expect(truncated.truncated).toBe(true)
    // 全文不足 N 时返回原文
    const full = takeLastNonWhitespaceCodePoints('短文本', 600)
    expect(full.text).toBe('短文本')
    expect(full.truncated).toBe(false)
  })

  it('limit<=0 时返回空串', () => {
    expect(takeLastNonWhitespaceCodePoints('abc', 0).text).toBe('')
  })
})

describe('Style Profile Schema（OQ-12 裁决）', () => {
  const baseSample = {
    sample_id: 'SAMPLE_001',
    tags: { pov: 'CH_A', scene_type: 'dialogue', tone: 'conflict' },
    text: '原文',
    de_entity: false,
  }

  it('接受最小合法样本；三个标签都必填', () => {
    expect(validateStyleProfile({ schema_version: '0.1', samples: [baseSample] }).samples).toHaveLength(1)
    for (const tags of [
      { scene_type: 'dialogue', tone: 'conflict' },
      { pov: 'CH_A', tone: 'conflict' },
      { pov: 'CH_A', scene_type: 'dialogue' },
    ]) {
      expect(styleProfileSchema.safeParse({ schema_version: '0.1', samples: [{ ...baseSample, tags }] }).success).toBe(false)
    }
  })

  it('scene_type / tone 必须在白名单内（tone 与 OBH 一致）', () => {
    expect(
      styleProfileSchema.safeParse({
        schema_version: '0.1',
        samples: [{ ...baseSample, tags: { ...baseSample.tags, scene_type: 'conflict' } }],
      }).success,
    ).toBe(false)
    expect(
      styleProfileSchema.safeParse({
        schema_version: '0.1',
        samples: [{ ...baseSample, tags: { ...baseSample.tags, tone: 'whatever' } }],
      }).success,
    ).toBe(false)
  })

  it('de_entity=true 必须有 sanitized_text；false 时不得存在（裁决第 3 条）', () => {
    expect(
      styleProfileSchema.safeParse({ schema_version: '0.1', samples: [{ ...baseSample, de_entity: true }] }).success,
    ).toBe(false)
    expect(
      styleProfileSchema.safeParse({
        schema_version: '0.1',
        samples: [{ ...baseSample, de_entity: false, sanitized_text: 'x' }],
      }).success,
    ).toBe(false)
    const ok = validateStyleProfile({
      schema_version: '0.1',
      samples: [{ ...baseSample, de_entity: true, sanitized_text: '[CHAR_A]说完了。' }],
    })
    expect(ok.samples[0]?.sanitized_text).toBe('[CHAR_A]说完了。')
  })

  it('sample_id 形态与唯一性（裁决第 1 条）', () => {
    expect(styleProfileSchema.safeParse({ schema_version: '0.1', samples: [{ ...baseSample, sample_id: 'S1' }] }).success).toBe(false)
    const duplicated = styleProfileSchema.safeParse({
      schema_version: '0.1',
      samples: [baseSample, baseSample],
    })
    expect(duplicated.success).toBe(false)
  })

  it('nextSampleId 取既有最大编号 + 1（同项目内不复用）', () => {
    expect(nextSampleId(createEmptyStyleProfile())).toBe('SAMPLE_001')
    const profile = validateStyleProfile({
      schema_version: '0.1',
      samples: [baseSample, { ...baseSample, sample_id: 'SAMPLE_007' }],
    })
    expect(nextSampleId(profile)).toBe('SAMPLE_008')
  })

  it('text 原样保留；有 sanitized_text 时 Writer 优先用去实体化版本（§23.2）', () => {
    const profile = validateStyleProfile({
      schema_version: '0.1',
      samples: [
        { ...baseSample, text: '  原文含 空格\n换行  ' },
        { ...baseSample, sample_id: 'SAMPLE_002', de_entity: true, sanitized_text: '[CHAR_A] 走开了。' },
      ],
    })
    const first = profile.samples[0]
    const second = profile.samples[1]
    expect(first?.text).toBe('  原文含 空格\n换行  ')
    expect(sampleTextForWriter(first!)).toBe('  原文含 空格\n换行  ')
    expect(sampleTextForWriter(second!)).toBe('[CHAR_A] 走开了。')
  })

  it('校验失败抛 StyleProfileValidationError', () => {
    expect(() => validateStyleProfile({ schema_version: '0.1' })).toThrow(StyleProfileValidationError)
  })
})

describe('Context Manifest Schema（需求规格 §21）', () => {
  function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: CONTEXT_MANIFEST_SCHEMA_VERSION,
      scene_id: 'scene-001',
      blueprint_version: 1,
      pov: 'CH_A',
      included_sensitive: [],
      excluded_sensitive: [],
      director_surface: [],
      style_samples: [],
      future_content_exposed: false,
      unconfirmed_proposal_exposed: false,
      overrides: [],
      ...overrides,
    }
  }

  it('六类 exclusion reason 枚举锁定，且 reason 必填', () => {
    expect(EXCLUSION_REASONS).toEqual([
      'not_revealed_yet',
      'future_scene',
      'non_pov_inner_state',
      'unconfirmed_content',
      'foreshadowing_backstage',
      'user_override',
    ])
    expect(
      contextManifestSchema.safeParse(
        baseManifest({ excluded_sensitive: [{ id: 'K001', type: 'key_knowledge', source_ref: 'x', reason: 'whatever' }] }),
      ).success,
    ).toBe(false)
    expect(
      contextManifestSchema.safeParse(
        baseManifest({ excluded_sensitive: [{ id: 'K001', type: 'key_knowledge', source_ref: 'x' }] }),
      ).success,
    ).toBe(false)
    expect(
      validateContextManifest(
        baseManifest({
          excluded_sensitive: [{ id: 'K001', type: 'key_knowledge', source_ref: 'x', reason: 'not_revealed_yet' }],
        }),
      ).excluded_sensitive[0]?.reason,
    ).toBe('not_revealed_yet')
  })

  it('overrides 与 director_surface 一对一，且只有 source=user_override 能进 overrides', () => {
    const withOverride = baseManifest({
      director_surface: [
        { id: 'DIR_SCENE_001', source_ref: 'scene.scene-001', instruction: '对白再短', source: 'scene' },
        { id: 'DIR_USER_001', source_ref: 'user_note', instruction: '不要回忆', source: 'user_override' },
      ],
      overrides: [{ id: 'OVR_001', director_surface_ref: 'DIR_USER_001', note: '不要回忆', source: 'user' }],
    })
    expect(validateContextManifest(withOverride).overrides).toHaveLength(1)
    // 指向不存在
    expect(
      contextManifestSchema.safeParse(
        baseManifest({ overrides: [{ id: 'OVR_001', director_surface_ref: 'DIR_USER_009', note: 'x', source: 'user' }] }),
      ).success,
    ).toBe(false)
    // 指向非 user_override
    expect(
      contextManifestSchema.safeParse(
        baseManifest({
          director_surface: [{ id: 'DIR_SCENE_001', source_ref: 'x', instruction: 'y', source: 'scene' }],
          overrides: [{ id: 'OVR_001', director_surface_ref: 'DIR_SCENE_001', note: 'x', source: 'user' }],
        }),
      ).success,
    ).toBe(false)
    // user_override 指令缺 overrides 记录
    expect(
      contextManifestSchema.safeParse(
        baseManifest({
          director_surface: [{ id: 'DIR_USER_001', source_ref: 'x', instruction: 'y', source: 'user_override' }],
        }),
      ).success,
    ).toBe(false)
  })

  it('future_content_exposed / unconfirmed_proposal_exposed 必须为 false', () => {
    expect(contextManifestSchema.safeParse(baseManifest({ future_content_exposed: true })).success).toBe(false)
    expect(contextManifestSchema.safeParse(baseManifest({ unconfirmed_proposal_exposed: true })).success).toBe(false)
  })

  it('included_sensitive 的 id 唯一；未知字段被拒绝', () => {
    expect(
      contextManifestSchema.safeParse(
        baseManifest({
          included_sensitive: [
            { id: 'K001', type: 'key_knowledge', source_ref: 'a', reason: 'r' },
            { id: 'K001', type: 'key_knowledge', source_ref: 'b', reason: 'r' },
          ],
        }),
      ).success,
    ).toBe(false)
    expect(contextManifestSchema.safeParse(baseManifest({ extra: 1 })).success).toBe(false)
  })

  it('校验失败抛 ContextManifestValidationError', () => {
    expect(() => validateContextManifest({ scene_id: 'scene-001' })).toThrow(/excluded_sensitive|Invalid|校验失败/)
  })
})
