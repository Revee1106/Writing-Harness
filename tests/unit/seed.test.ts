import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'
import {
  GATE1_STATUSES,
  SEED_SCHEMA_VERSION,
  SeedValidationError,
  checkSeedInvariants,
  createEmptySeed,
  seedFileSchema,
  validateSeedFile,
  type SeedFile,
} from '../../src/schema/seed.ts'
import { SEED_FIXTURES_DIR } from '../helpers/tmp.ts'

/** 需求规格 §8.1 的示例结构（补上 OQ-09 裁决的 schema_version）。 */
function documentedSeedExample(): SeedFile {
  return {
    schema_version: '0.1',
    story_seed: {
      raw_input: '一个男人每天给去世的妻子发微信，某天突然收到回复。\n',
      raw_seed_anchor_ids: ['SEED_F001'],
      gate1_status: 'partial',
      fixed_by_user: [
        {
          id: 'SEED_F001',
          value: '妻子已经死亡',
          status: 'USER_GIVEN',
          source: 'user',
          origin: 'raw_seed',
        },
      ],
      ambiguous: [],
      open_questions: [{ id: 'SEED_Q001', value: '真相何时揭晓', source: 'interpreter' }],
    },
  }
}

describe('seed.yaml 结构（需求规格 §8.1 / Story 1 功能第 3 条）', () => {
  it('接受需求规格 §8.1 的示例结构', () => {
    const seed = validateSeedFile(documentedSeedExample())
    expect(seed.story_seed.gate1_status).toBe('partial')
    expect(seed.story_seed.raw_seed_anchor_ids).toEqual(['SEED_F001'])
    expect(seed.story_seed.fixed_by_user[0]?.origin).toBe('raw_seed')
  })

  it('顶层带 schema_version（OQ-09 裁决）', () => {
    expect(SEED_SCHEMA_VERSION).toBe('0.1')
    expect(() => validateSeedFile({ ...documentedSeedExample(), schema_version: '0.2' })).toThrow(SeedValidationError)
  })

  it('gate1_status 初值为 pending，Gate 1 后只能是 confirmed / skipped / partial（OQ-05 / D5）', () => {
    expect(GATE1_STATUSES).toEqual(['pending', 'confirmed', 'skipped', 'partial'])
    expect(createEmptySeed('').story_seed.gate1_status).toBe('pending')
    for (const status of ['confirmed', 'skipped', 'partial', 'pending']) {
      const seed = createEmptySeed('')
      expect(
        seedFileSchema.safeParse({ ...seed, story_seed: { ...seed.story_seed, gate1_status: status } }).success,
      ).toBe(true)
    }
    const bad = createEmptySeed('')
    expect(
      seedFileSchema.safeParse({ ...bad, story_seed: { ...bad.story_seed, gate1_status: 'accepted' } }).success,
    ).toBe(false)
  })

  it('新建项目的 seed 是空集合 + pending', () => {
    const seed = createEmptySeed('一句话种子\n')
    expect(seed.story_seed).toMatchObject({
      raw_input: '一句话种子\n',
      raw_seed_anchor_ids: [],
      gate1_status: 'pending',
      fixed_by_user: [],
      ambiguous: [],
      open_questions: [],
    })
  })

  it('拒绝文档未定义的顶层 / story_seed 字段', () => {
    const seed = documentedSeedExample()
    expect(seedFileSchema.safeParse({ ...seed, extra: 1 }).success).toBe(false)
    expect(
      seedFileSchema.safeParse({ ...seed, story_seed: { ...seed.story_seed, gate2_status: 'x' } }).success,
    ).toBe(false)
  })
})

describe('Seed item ID 与中间态（OQ-04 裁决）', () => {
  it('校验 SEED_F### / SEED_A### / SEED_Q###', () => {
    expect(() =>
      validateSeedFile({
        ...documentedSeedExample(),
        story_seed: {
          ...documentedSeedExample().story_seed,
          raw_seed_anchor_ids: ['SEED_F1'],
        },
      }),
    ).toThrow(SeedValidationError)

    const seed = createEmptySeed('')
    expect(
      seedFileSchema.safeParse({
        ...seed,
        story_seed: { ...seed.story_seed, ambiguous: [{ id: 'SEED_A1', value: 'x', source: 'interpreter' }] },
      }).success,
    ).toBe(false)
    expect(
      seedFileSchema.safeParse({
        ...seed,
        story_seed: { ...seed.story_seed, open_questions: [{ id: 'SEED_Q1', value: 'x', source: 'interpreter' }] },
      }).success,
    ).toBe(false)
  })

  it('ambiguous 项不带 status（OQ-04：不属于四状态模型）', () => {
    const seed = createEmptySeed('')
    const withStatus = {
      ...seed,
      story_seed: {
        ...seed.story_seed,
        ambiguous: [{ id: 'SEED_A001', value: '争吵的起因', source: 'interpreter', status: 'PROPOSED' }],
      },
    }
    expect(seedFileSchema.safeParse(withStatus).success).toBe(false)
    expect(
      seedFileSchema.safeParse({
        ...seed,
        story_seed: {
          ...seed.story_seed,
          ambiguous: [{ id: 'SEED_A001', value: '争吵的起因', source: 'interpreter' }],
        },
      }).success,
    ).toBe(true)
  })

  it('open_questions 不带 status，ID 稳定', () => {
    const seed = createEmptySeed('')
    expect(
      seedFileSchema.safeParse({
        ...seed,
        story_seed: {
          ...seed.story_seed,
          open_questions: [{ id: 'SEED_Q001', value: '真相何时揭晓', source: 'interpreter', state: 'open' }],
        },
      }).success,
    ).toBe(false)
  })
})

describe('seed.yaml 不变量（需求规格 §8.2 / §5.1；解读 I-8）', () => {
  it('合法示例无不变量问题', () => {
    expect(checkSeedInvariants(validateSeedFile(documentedSeedExample()).story_seed)).toEqual([])
  })

  it('origin=raw_seed 的锚点必须已冻结在 raw_seed_anchor_ids 中', () => {
    const seed = documentedSeedExample()
    const broken = {
      ...seed,
      story_seed: { ...seed.story_seed, raw_seed_anchor_ids: [] },
    }
    expect(() => validateSeedFile(broken)).toThrow(/ANCHOR_NOT_FROZEN/)
  })

  it('anchors 只接受 SEED_F### 形态（评估分母不会被 SEED_A/SEED_Q 污染）', () => {
    const seed = documentedSeedExample()
    const broken = {
      ...seed,
      story_seed: { ...seed.story_seed, raw_seed_anchor_ids: ['SEED_F001', 'SEED_A001'] },
    }
    expect(() => validateSeedFile(broken)).toThrow(SeedValidationError)
  })

  it('Gate 1 提升项不会自动进入 anchors（结构保证在 Gate 1 服务与 state-machine 层）', () => {
    const seed = documentedSeedExample()
    const promoted = {
      ...seed,
      story_seed: {
        ...seed.story_seed,
        gate1_status: 'partial' as const,
        ambiguous: [],
        fixed_by_user: [
          ...seed.story_seed.fixed_by_user,
          {
            id: 'SEED_A001',
            value: '两人仍然相爱',
            status: 'USER_GIVEN' as const,
            source: 'user_gate1' as const,
            origin: 'gate1_confirmation' as const,
          },
        ],
      },
    }
    const validated = validateSeedFile(promoted)
    expect(validated.story_seed.raw_seed_anchor_ids).toEqual(['SEED_F001'])
    expect(checkSeedInvariants(validated.story_seed)).toEqual([])
  })

  it('gate1_status=pending 时不得存在 Gate 1 提升项', () => {
    const seed = documentedSeedExample()
    const broken = {
      ...seed,
      story_seed: {
        ...seed.story_seed,
        gate1_status: 'pending',
        fixed_by_user: [
          {
            id: 'SEED_F002',
            value: '两人仍然相爱',
            status: 'USER_GIVEN',
            source: 'user_gate1',
            origin: 'gate1_confirmation',
          },
        ],
        raw_seed_anchor_ids: [],
      },
    }
    expect(() => validateSeedFile(broken)).toThrow(/GATE1_ITEMS_BEFORE_GATE1/)
  })

  it('校验失败时抛出携带明细的 SeedValidationError', () => {
    try {
      validateSeedFile({ schema_version: '0.1' })
      throw new Error('应当抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(SeedValidationError)
      expect((error as SeedValidationError).detail.length).toBeGreaterThan(0)
    }
  })
})

describe('用户 raw input 原样保留（Story 1 验收 3）', () => {
  const fixtures: Array<[string, string]> = [
    ['一句话', 'one-line.txt'],
    ['多句话', 'multi-sentence.txt'],
    ['简单 Markdown', 'markdown.md'],
  ]

  for (const [label, fileName] of fixtures) {
    it(`${label}：写盘再回读逐字符一致`, () => {
      const source = readFileSync(join(SEED_FIXTURES_DIR, fileName), 'utf8')
      const seed = validateSeedFile(createEmptySeed(source))
      const text = dumpYaml(seed)
      const reloaded = validateSeedFile(loadYaml(text))
      expect(reloaded.story_seed.raw_input).toBe(source)

      // 二次往返仍然稳定（golden 快照可复现的前提）
      expect(dumpYaml(reloaded)).toBe(text)
    })
  }

  it('多行输入使用 block literal，便于人工审阅', () => {
    const source = readFileSync(join(SEED_FIXTURES_DIR, 'markdown.md'), 'utf8')
    const text = dumpYaml(validateSeedFile(createEmptySeed(source)))
    expect(text).toContain('raw_input: |')
    expect(text).toContain('# 故事大概')
  })

  it('特殊字符不被转义破坏（引号 / 冒号 / 井号 / 反斜线 / 制表符）', () => {
    const tricky = '他说："我没忘。"\n# 不是标题\nkey: value\nC:\\path\\to\n结尾没有换行'
    const seed = validateSeedFile(createEmptySeed(tricky))
    expect(validateSeedFile(loadYaml(dumpYaml(seed))).story_seed.raw_input).toBe(tricky)
  })

  it('空 raw_input 合法（Story 1 允许先建项目后补 seed）', () => {
    const seed = validateSeedFile(createEmptySeed(''))
    expect(seed.story_seed.raw_input).toBe('')
    expect(validateSeedFile(loadYaml(dumpYaml(seed))).story_seed.raw_input).toBe('')
  })
})
