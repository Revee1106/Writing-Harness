import { describe, expect, it } from 'vitest'
import {
  CONFLICT_RESOLUTIONS,
  DISTINCTNESS_DIMENSIONS,
  MIN_CORE_DIMENSION_DIFFS,
  MIN_TOTAL_DIMENSION_DIFFS,
  REQUIRED_CORE_DIMENSIONS,
  ProposalValidationError,
  checkProposalDistinctness,
  compareProposalPair,
  computeSeedPreservationRate,
  conflictResolutionSchema,
  proposalsFileSchema,
  validateProposalsFile,
  type Proposal,
} from '../../src/schema/proposal.ts'
import {
  PROPOSAL_FIELD_PATHS,
  isProposalFieldPathAllowed,
  normalizeFieldPath,
  parseProposalFieldPath,
} from '../../src/core/proposal-field-paths.ts'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'

/** 需求规格 §9.1 的最小合法 Proposal（用于逐字段改造测试）。 */
function baseProposal(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    proposal_id: 'PROP_A',
    title: '标题',
    genre: '现代情感',
    core_premise: '前提 A',
    core_conflict: '冲突 A',
    truth_or_turn: '转折 A',
    character_arc: '弧线 A',
    ending: '结局 A',
    pov: ['CH_LIN_YU'],
    target_length: 8000,
    tone: '克制',
    seed_fidelity: {
      preserved: [{ seed_ref: 'SEED_F001', value_in_proposal: '保留了锚点一' }],
      altered: [],
      added: [{ id: 'ADD_001', value: '新增设定', status: 'PROPOSED', source: 'harness' }],
      risk: [{ id: 'RISK_001', value: '风险', related_addition_refs: ['ADD_001'] }],
    },
    conflicts: [],
    ...overrides,
  }
}

function fileWith(proposals: unknown[]): Record<string, unknown> {
  return { schema_version: '0.1', proposals }
}

describe('proposals.yaml 顶层结构（OQ-09 裁决 / Story 3）', () => {
  it('顶层是 schema_version + proposals 列表，且只接受 2～3 个方案（需求规格 §9）', () => {
    expect(proposalsFileSchema.safeParse(fileWith([baseProposal(), baseProposal({ proposal_id: 'PROP_B' })])).success).toBe(true)
    expect(
      proposalsFileSchema.safeParse(
        fileWith([baseProposal(), baseProposal({ proposal_id: 'PROP_B' }), baseProposal({ proposal_id: 'PROP_C' })]),
      ).success,
    ).toBe(true)
    expect(proposalsFileSchema.safeParse(fileWith([baseProposal()])).success).toBe(false)
    expect(
      proposalsFileSchema.safeParse(
        fileWith([
          baseProposal(),
          baseProposal({ proposal_id: 'PROP_B' }),
          baseProposal({ proposal_id: 'PROP_C' }),
          baseProposal({ proposal_id: 'PROP_D' }),
        ]),
      ).success,
    ).toBe(false)
  })

  it('拒绝未知字段与重复 proposal_id', () => {
    expect(proposalsFileSchema.safeParse({ ...fileWith([baseProposal(), baseProposal({ proposal_id: 'PROP_B' })]), note: 'x' }).success).toBe(false)
    expect(
      proposalsFileSchema.safeParse(fileWith([baseProposal(), baseProposal()])).success,
    ).toBe(false)
  })

  it('校验失败抛 ProposalValidationError', () => {
    expect(() => validateProposalsFile({ schema_version: '0.1' })).toThrow(ProposalValidationError)
  })

  it('YAML 往返一致', () => {
    const file = validateProposalsFile(fileWith([baseProposal(), baseProposal({ proposal_id: 'PROP_B' })]))
    expect(validateProposalsFile(loadYaml(dumpYaml(file)))).toEqual(file)
  })
})

describe('Proposal Schema（需求规格 §9.1）', () => {
  it('pov 长度 ∈ {1,2} 且元素是 CH_* 角色 ID（§11.3 规则）', () => {
    const two = baseProposal({ pov: ['CH_A', 'CH_B'] })
    expect(proposalsFileSchema.safeParse(fileWith([two, baseProposal({ proposal_id: 'PROP_B' })])).success).toBe(true)
    for (const bad of [[], ['CH_A', 'CH_B', 'CH_C'], ['LIN_YU']]) {
      expect(
        proposalsFileSchema.safeParse(fileWith([baseProposal({ pov: bad }), baseProposal({ proposal_id: 'PROP_B' })])).success,
        JSON.stringify(bad),
      ).toBe(false)
    }
  })

  it('target_length 必须是正整数（单位：中文字数）', () => {
    for (const bad of [0, -1, 1.5, '8000']) {
      expect(
        proposalsFileSchema.safeParse(fileWith([baseProposal({ target_length: bad }), baseProposal({ proposal_id: 'PROP_B' })])).success,
      ).toBe(false)
    }
  })

  it('seed_fidelity.added 强制 PROPOSED + harness（原则 2 的 Schema 级落地）', () => {
    const withUserGiven = baseProposal({
      seed_fidelity: {
        preserved: [],
        altered: [],
        added: [{ id: 'ADD_001', value: 'x', status: 'USER_GIVEN', source: 'user' }],
        risk: [],
      },
    })
    const result = proposalsFileSchema.safeParse(fileWith([withUserGiven, baseProposal({ proposal_id: 'PROP_B' })]))
    expect(result.success).toBe(false)
    // 也不允许伪装来源
    const withFakeSource = baseProposal({
      seed_fidelity: {
        preserved: [],
        altered: [],
        added: [{ id: 'ADD_001', value: 'x', status: 'PROPOSED', source: 'user' }],
        risk: [],
      },
    })
    expect(proposalsFileSchema.safeParse(fileWith([withFakeSource, baseProposal({ proposal_id: 'PROP_B' })])).success).toBe(false)
  })

  it('risk.related_addition_refs 必须指向存在的 ADD 项', () => {
    const bad = baseProposal({
      seed_fidelity: {
        preserved: [],
        altered: [],
        added: [{ id: 'ADD_001', value: 'x', status: 'PROPOSED', source: 'harness' }],
        risk: [{ id: 'RISK_001', value: 'r', related_addition_refs: ['ADD_009'] }],
      },
    })
    const result = proposalsFileSchema.safeParse(fileWith([bad, baseProposal({ proposal_id: 'PROP_B' })]))
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('引用了不存在的新增项')
  })

  it('preserved 中同一 Seed Anchor 不得重复（去重口径）', () => {
    const bad = baseProposal({
      seed_fidelity: {
        preserved: [
          { seed_ref: 'SEED_F001', value_in_proposal: 'a' },
          { seed_ref: 'SEED_F001', value_in_proposal: 'b' },
        ],
        altered: [],
        added: [],
        risk: [],
      },
    })
    expect(proposalsFileSchema.safeParse(fileWith([bad, baseProposal({ proposal_id: 'PROP_B' })])).success).toBe(false)
  })

  it('seed_ref 接受 SEED_F### 与 SEED_A###（Gate 1 提升项），拒绝其它形态', () => {
    const withPromoted = baseProposal({
      seed_fidelity: {
        preserved: [
          { seed_ref: 'SEED_F001', value_in_proposal: 'a' },
          { seed_ref: 'SEED_A002', value_in_proposal: 'b' },
        ],
        altered: [],
        added: [],
        risk: [],
      },
    })
    expect(proposalsFileSchema.safeParse(fileWith([withPromoted, baseProposal({ proposal_id: 'PROP_B' })])).success).toBe(true)
    const withQuestion = baseProposal({
      seed_fidelity: {
        preserved: [{ seed_ref: 'SEED_Q001', value_in_proposal: 'a' }],
        altered: [],
        added: [],
        risk: [],
      },
    })
    expect(proposalsFileSchema.safeParse(fileWith([withQuestion, baseProposal({ proposal_id: 'PROP_B' })])).success).toBe(false)
  })
})

describe('conflicts[] 结构化与 resolution 枚举可执行（需求规格 §9.2 / Story 3 验收）', () => {
  it('resolution 枚举与需求规格 §9.1 完全一致', () => {
    expect(CONFLICT_RESOLUTIONS).toEqual(['pending', 'kept_user', 'changed_user', 'dropped'])
    for (const value of CONFLICT_RESOLUTIONS) {
      expect(conflictResolutionSchema.safeParse(value).success, value).toBe(true)
    }
    expect(conflictResolutionSchema.safeParse('resolved').success).toBe(false)
  })

  it('冲突项必须回答：冲突哪个锚点 / 哪个字段 / 用户值 / 方案值 / 处理结果', () => {
    const withConflict = baseProposal({
      conflicts: [
        {
          id: 'CONF_001',
          seed_ref: 'SEED_F003',
          proposal_field: 'core_premise',
          user_value: '女方提出分手',
          proposal_value: '女方提出分手但并非要挟',
          resolution: 'pending',
        },
      ],
    })
    const parsed = proposalsFileSchema.safeParse(fileWith([withConflict, baseProposal({ proposal_id: 'PROP_B' })]))
    expect(parsed.success).toBe(true)
    const conflict = (parsed.data?.proposals[0] as Proposal).conflicts[0]
    expect(Object.keys(conflict ?? {}).sort()).toEqual([
      'id',
      'proposal_field',
      'proposal_value',
      'resolution',
      'seed_ref',
      'user_value',
    ])
  })

  it('proposal_field 必须落在字段路径白名单内', () => {
    const bad = baseProposal({
      conflicts: [
        {
          id: 'CONF_001',
          seed_ref: 'SEED_F003',
          proposal_field: 'some_random_field',
          user_value: 'a',
          proposal_value: 'b',
          resolution: 'pending',
        },
      ],
    })
    const result = proposalsFileSchema.safeParse(fileWith([bad, baseProposal({ proposal_id: 'PROP_B' })]))
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('白名单')
  })
})

describe('source_refs.type=proposal 字段路径白名单（用户裁决第 3 项 / OQ-31）', () => {
  it('至少覆盖用户指定项', () => {
    for (const required of [
      'core_premise',
      'core_conflict',
      'truth_or_turn',
      'character_arc',
      'ending',
      'seed_fidelity.added[N].value',
      'seed_fidelity.risk[N].value',
    ]) {
      expect(isProposalFieldPathAllowed(required), required).toBe(true)
    }
  })

  it('解析 <proposal_id>.<field_path> 并归一化下标', () => {
    expect(parseProposalFieldPath('PROP_A.core_premise')).toEqual({ proposalId: 'PROP_A', fieldPath: 'core_premise' })
    expect(parseProposalFieldPath('PROP_B.seed_fidelity.added[3].value')).toEqual({
      proposalId: 'PROP_B',
      fieldPath: 'seed_fidelity.added[N].value',
    })
    expect(parseProposalFieldPath('PROP_A.unknown_field')).toBeNull()
    expect(parseProposalFieldPath('core_premise')).toBeNull()
  })

  it('normalizeFieldPath 把任意下标折叠为 [N]', () => {
    expect(normalizeFieldPath('seed_fidelity.risk[12].value')).toBe('seed_fidelity.risk[N].value')
    expect(normalizeFieldPath('core_premise')).toBe('core_premise')
  })

  it('白名单是冻结的可枚举集合（便于审计与后续扩展）', () => {
    expect(PROPOSAL_FIELD_PATHS.length).toBeGreaterThanOrEqual(20)
    expect(PROPOSAL_FIELD_PATHS).toContain('seed_fidelity.preserved')
    expect(PROPOSAL_FIELD_PATHS).not.toContain('unknown_field')
  })
})

describe('Seed Preservation Rate（需求规格 §10.2 / 用户裁决第 1 项）', () => {
  const proposal = (preserved: string[], altered: string[] = [], conflicts: string[] = []): Proposal =>
    ({
      proposal_id: 'PROP_A',
      seed_fidelity: {
        preserved: preserved.map((ref) => ({ seed_ref: ref, value_in_proposal: 'v' })),
        altered: altered.map((ref) => ({ seed_ref: ref, original: 'o', changed_to: 'c' })),
        added: [],
        risk: [],
      },
      conflicts: conflicts.map((ref, index) => ({
        id: `CONF_00${index + 1}`,
        seed_ref: ref,
        proposal_field: 'core_premise',
        user_value: 'u',
        proposal_value: 'p',
        resolution: 'pending' as const,
      })),
    }) as unknown as Proposal

  it('分母是冻结的 raw_seed_anchor_ids，分子只数 preserved', () => {
    const rate = computeSeedPreservationRate(proposal(['SEED_F001', 'SEED_F002']), [
      'SEED_F001',
      'SEED_F002',
      'SEED_F003',
      'SEED_F004',
    ])
    expect(rate.denominator).toBe(4)
    expect(rate.numerator).toBe(2)
    expect(rate.rate).toBe(0.5)
    expect(rate.rate_percent).toBe(50)
  })

  it('altered 与 conflicts 不计入分子（用户裁决第 1 项）', () => {
    const rate = computeSeedPreservationRate(proposal([], ['SEED_F001'], ['SEED_F002']), ['SEED_F001', 'SEED_F002'])
    expect(rate.numerator).toBe(0)
    expect(rate.rate).toBe(0)
    expect(rate.unaccounted_anchor_ids).toEqual([])
    for (const notice of rate.notices) {
      expect(notice.code).not.toBe('UNACCOUNTED_ANCHOR')
    }
  })

  it('锚点在三处都未出现 → UNACCOUNTED_ANCHOR warning 且不计分子', () => {
    const rate = computeSeedPreservationRate(proposal(['SEED_F001']), ['SEED_F001', 'SEED_F002'])
    expect(rate.numerator).toBe(1)
    expect(rate.unaccounted_anchor_ids).toEqual(['SEED_F002'])
    expect(rate.notices.map((notice) => notice.code)).toContain('UNACCOUNTED_ANCHOR')
    expect(rate.rate).toBe(0.5)
  })

  it('Gate 1 提升项（SEED_A###）不进入分子分母（需求规格 §10.2）', () => {
    const rate = computeSeedPreservationRate(proposal(['SEED_F001', 'SEED_A001']), ['SEED_F001'])
    expect(rate.denominator).toBe(1)
    expect(rate.numerator).toBe(1)
    expect(rate.out_of_denominator_refs).toEqual(['SEED_A001'])
    expect(rate.notices.map((notice) => notice.code)).toContain('SEED_REF_NOT_ANCHOR')
  })

  it('同一锚点在 preserved 重复出现只计一次（Schema 层已拒绝，计算层再兜底去重）', () => {
    const duplicated = proposal(['SEED_F001', 'SEED_F001'])
    const rate = computeSeedPreservationRate(duplicated, ['SEED_F001', 'SEED_F002'])
    expect(rate.numerator).toBe(1)
    expect(rate.preserved_anchor_ids).toEqual(['SEED_F001'])
  })

  it('分母为 0 时 rate = null 并给出 EMPTY_DENOMINATOR（不产生 0/0）', () => {
    const rate = computeSeedPreservationRate(proposal([]), [])
    expect(rate.denominator).toBe(0)
    expect(rate.rate).toBeNull()
    expect(rate.rate_percent).toBeNull()
    expect(rate.notices.map((notice) => notice.code)).toEqual(['EMPTY_DENOMINATOR'])
  })

  it('Rate 固定落在 0～100%（需求规格 §10.2）', () => {
    const rate = computeSeedPreservationRate(proposal(['SEED_F001', 'SEED_F002']), ['SEED_F001', 'SEED_F002'])
    expect(rate.rate_percent).toBe(100)
    expect(rate.rate).toBeGreaterThanOrEqual(0)
    expect(rate.rate).toBeLessThanOrEqual(1)
  })
})

describe('Proposal 差异度（Story 3 验收「差异不是措辞差异」/ 用户裁决第 2 项）', () => {
  const make = (overrides: Partial<Record<string, unknown>>): Proposal =>
    validateProposalsFile(
      fileWith([baseProposal(overrides), baseProposal({ proposal_id: 'PROP_B' })]),
    ).proposals[0] as Proposal

  it('判定维度与阈值冻结在 5 个维度 + 2/3 规则', () => {
    expect(DISTINCTNESS_DIMENSIONS).toEqual(['core_conflict', 'truth_or_turn', 'ending', 'character_arc', 'core_premise'])
    expect(REQUIRED_CORE_DIMENSIONS).toEqual(['core_conflict', 'truth_or_turn', 'ending'])
    expect(MIN_CORE_DIMENSION_DIFFS).toBe(2)
    expect(MIN_TOTAL_DIMENSION_DIFFS).toBe(3)
  })

  it('核心三维全部不同 → 通过', () => {
    const a = make({})
    const b = make({ core_conflict: 'X', truth_or_turn: 'Y', ending: 'Z' })
    const pair = compareProposalPair(a, b)
    expect(pair.ok).toBe(true)
    expect(pair.differing_core_dimensions).toEqual(['core_conflict', 'truth_or_turn', 'ending'])
  })

  it('只有语气 / 标题不同 → 不通过（措辞差异不算差异）', () => {
    const a = make({})
    const b = make({ title: '另一个标题', tone: '完全不同的语气' })
    const pair = compareProposalPair(a, b)
    expect(pair.ok).toBe(false)
    expect(pair.differing_dimensions).toEqual([])
    expect(pair.reason).toContain('差异不足')
  })

  it('只差一个核心维度且总差异 < 3 → 不通过', () => {
    const a = make({})
    const b = make({ core_conflict: 'X' })
    expect(compareProposalPair(a, b).ok).toBe(false)
  })

  it('checkProposalDistinctness 输出 warning 而不是抛错（需求规格 §28 允许重做，不阻塞用户）', () => {
    const a = make({})
    const b = make({ title: '另一个标题' })
    const report = checkProposalDistinctness([a, b])
    expect(report.ok).toBe(false)
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toContain('重做')
  })

  it('三个方案时逐对判定', () => {
    const a = make({})
    const b = make({ core_conflict: 'X', truth_or_turn: 'Y', ending: 'Z' })
    const c = make({ core_conflict: 'X2', truth_or_turn: 'Y2', ending: 'Z2' })
    const report = checkProposalDistinctness([a, b, c])
    expect(report.pairs).toHaveLength(3)
    expect(report.ok).toBe(true)
  })
})
