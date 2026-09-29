import { describe, expect, it } from 'vitest'
import {
  ARC_IDS,
  BLUEPRINT_SCHEMA_VERSION,
  BlueprintValidationError,
  CORE_CONFLICT_ID,
  PREMISE_ID,
  STYLE_DIRECTION_ID,
  STRUCTURE_IDS,
  TRUTH_STATUSES,
  listBlueprintItemIds,
  scanBlueprint,
  validateBlueprint,
} from '../../src/schema/blueprint.ts'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'

/** 一份最小合法 Blueprint（用于逐字段改造测试）。 */
function baseBlueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const valueItem = (id: string, value: string | null = '内容') => ({
    id,
    value,
    source_refs: [{ type: 'seed', ref_id: 'SEED_F001' }],
  })
  return {
    schema_version: BLUEPRINT_SCHEMA_VERSION,
    blueprint_version: 1,
    meta: { title: '标题', genre: '类型', pov: ['CH_A'], target_length: 8000 },
    premise: { id: PREMISE_ID, value: '前提', status: 'CONFIRMED', source_refs: [{ type: 'seed', ref_id: 'SEED_F001' }] },
    theme: { primary: valueItem('BP_THEME_01', '主题'), secondary: [] },
    characters: [
      {
        id: 'CH_A',
        name: '甲',
        role: '主角',
        desire: '想要',
        fear: '怕',
        contradiction: '矛盾',
        voice_hint: '说话短',
        inner_state_pov_visible: ['CH_A'],
        observable_behavior_hints: [
          { id: 'OBH_A_01', value: '不满时沉默', applicable_scene_types: ['conflict', 'dialogue'] },
        ],
        relationships: [
          {
            id: 'REL_A_B',
            target: 'CH_B',
            kind: 'lover',
            state: 'together',
            since_ref: STRUCTURE_IDS.beginning,
            source_refs: [],
          },
        ],
        source_refs: [],
      },
      {
        id: 'CH_B',
        name: '乙',
        role: '对手',
        desire: '想要',
        fear: '怕',
        contradiction: '矛盾',
        voice_hint: '话多',
        inner_state_pov_visible: [],
        observable_behavior_hints: [],
        relationships: [],
        source_refs: [],
      },
    ],
    core_conflict: valueItem(CORE_CONFLICT_ID, '核心冲突'),
    arc: {
      start: valueItem(ARC_IDS.start),
      shift: valueItem(ARC_IDS.shift),
      end: valueItem(ARC_IDS.end),
    },
    structure: {
      beginning: valueItem(STRUCTURE_IDS.beginning),
      development: valueItem(STRUCTURE_IDS.development),
      turning_point: valueItem(STRUCTURE_IDS.turning_point),
      climax: valueItem(STRUCTURE_IDS.climax),
      ending: valueItem(STRUCTURE_IDS.ending),
    },
    key_knowledge: [
      {
        id: 'K001',
        truth: '乙早就知道',
        truth_status: 'CONFIRMED',
        known_by: { CH_A: false, CH_B: true },
        reader_knows: false,
        reveal_at_structure: STRUCTURE_IDS.turning_point,
        reveal_order: 1,
        reveal_to: ['CH_A'],
        reveal_to_reader: true,
        source_refs: [],
      },
    ],
    foreshadowing: [
      {
        id: 'BP_FS_001',
        value: '反复出现的杯子',
        setup_at_structure: STRUCTURE_IDS.beginning,
        setup_order: 1,
        payoff_at_structure: STRUCTURE_IDS.climax,
        payoff_order: 1,
        source_refs: [],
      },
    ],
    style_direction: {
      id: STYLE_DIRECTION_ID,
      narration: '贴身第三人称',
      dialogue: '短句',
      rhythm: '段落短',
      source_refs: [],
    },
    seed_fidelity: { preserved: [], altered: [], added: [], risk: [] },
    ...overrides,
  }
}

describe('Blueprint Schema（需求规格 §11.1）', () => {
  it('接受最小合法 Blueprint，并列出全部可引用 ID', () => {
    const blueprint = validateBlueprint(baseBlueprint())
    const ids = listBlueprintItemIds(blueprint)
    for (const expected of [
      PREMISE_ID,
      'BP_THEME_01',
      CORE_CONFLICT_ID,
      STYLE_DIRECTION_ID,
      STRUCTURE_IDS.beginning,
      STRUCTURE_IDS.turning_point,
      ARC_IDS.start,
      'CH_A',
      'CH_B',
      'OBH_A_01',
      'REL_A_B',
      'K001',
      'BP_FS_001',
    ]) {
      expect(ids, expected).toContain(expected)
    }
  })

  it('YAML 往返一致', () => {
    const blueprint = validateBlueprint(baseBlueprint())
    expect(validateBlueprint(loadYaml(dumpYaml(blueprint)))).toEqual(blueprint)
  })

  it('meta.pov 长度必须 ∈ {1,2}（§11.3）', () => {
    for (const pov of [[], ['CH_A', 'CH_B', 'CH_A']]) {
      const result = blueprintSafeParse(baseBlueprint({ meta: { ...meta(), pov } }))
      expect(result.success, JSON.stringify(pov)).toBe(false)
    }
    expect(blueprintSafeParse(baseBlueprint({ meta: { ...meta(), pov: ['CH_A', 'CH_B'] } })).success).toBe(true)
  })

  it('pov 必须指向已定义角色', () => {
    const result = blueprintSafeParse(baseBlueprint({ meta: { ...meta(), pov: ['CH_ZZZ'] } }))
    expect(result.success).toBe(false)
  })

  it('structure / arc 的 ID 必须是 §11.1 的固定 ID（§11.2）', () => {
    const bad = baseBlueprint()
    const structure = { ...(bad.structure as Record<string, { id: string }>) }
    structure.beginning = { ...structure.beginning, id: 'BP_STR_START' }
    const result = blueprintSafeParse({ ...bad, structure })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('BP_STR_BEG')
  })

  it('truth_status 只允许 CONFIRMED（OQ-18 裁决）', () => {
    expect(TRUTH_STATUSES).toEqual(['CONFIRMED'])
    const bad = baseBlueprint()
    const knowledge = (bad.key_knowledge as Record<string, unknown>[])[0] as Record<string, unknown>
    const result = blueprintSafeParse({
      ...bad,
      key_knowledge: [{ ...knowledge, truth_status: 'PROPOSED' }],
    })
    expect(result.success).toBe(false)
  })

  it('known_by 必须是 character id 且必须包含每个 POV 角色（§13 POV Filter）', () => {
    const bad = baseBlueprint()
    const knowledge = (bad.key_knowledge as Record<string, unknown>[])[0] as Record<string, unknown>
    // 缺 CH_A（当前 POV）
    const missingPov = blueprintSafeParse({
      ...bad,
      key_knowledge: [{ ...knowledge, known_by: { CH_B: true } }],
    })
    expect(missingPov.success).toBe(false)
    expect(JSON.stringify(missingPov.error?.issues)).toContain('缺少当前 POV 角色')

    // 非角色 key
    const badKey = blueprintSafeParse({
      ...bad,
      key_knowledge: [{ ...knowledge, known_by: { CH_A: false, CH_B: true, NARRATOR: true } }],
    })
    expect(badKey.success).toBe(false)
  })

  it('relationship.target 必须存在、不能是自己、since_ref 必须引用 structure 位置', () => {
    const bad = baseBlueprint()
    const characters = JSON.parse(JSON.stringify(bad.characters)) as Record<string, unknown>[]
    const first = characters[0] as Record<string, unknown>
    first.relationships = [{ ...(first.relationships as Record<string, unknown>[])[0], target: 'CH_ZZZ' }]
    expect(blueprintSafeParse({ ...bad, characters }).success).toBe(false)

    const selfTarget = JSON.parse(JSON.stringify(bad.characters)) as Record<string, unknown>[]
    const selfFirst = selfTarget[0] as Record<string, unknown>
    selfFirst.relationships = [{ ...(selfFirst.relationships as Record<string, unknown>[])[0], target: 'CH_A' }]
    expect(blueprintSafeParse({ ...bad, characters: selfTarget }).success).toBe(false)

    const badSince = JSON.parse(JSON.stringify(bad.characters)) as Record<string, unknown>[]
    const badSinceFirst = badSince[0] as Record<string, unknown>
    badSinceFirst.relationships = [
      { ...(badSinceFirst.relationships as Record<string, unknown>[])[0], since_ref: 'scene-001' },
    ]
    const result = blueprintSafeParse({ ...bad, characters: badSince })
    expect(result.success).toBe(false)
  })

  it('inner_state_pov_visible 只能包含 meta.pov 中的角色（§11.3）', () => {
    const bad = baseBlueprint()
    const characters = JSON.parse(JSON.stringify(bad.characters)) as Record<string, unknown>[]
    ;(characters[0] as Record<string, unknown>).inner_state_pov_visible = ['CH_B']
    const result = blueprintSafeParse({ ...bad, characters })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('只能包含 meta.pov 中的角色')
  })

  it('observable_behavior_hints 必须声明 applicable_scene_types（§11.3）', () => {
    const bad = baseBlueprint()
    const characters = JSON.parse(JSON.stringify(bad.characters)) as Record<string, unknown>[]
    ;(characters[0] as Record<string, unknown>).observable_behavior_hints = [{ id: 'OBH_A_01', value: 'x', applicable_scene_types: [] }]
    expect(blueprintSafeParse({ ...bad, characters }).success).toBe(false)
  })

  it('style_direction 作为整体项：内部不分子 ID，多余字段被拒绝（§11.3）', () => {
    const bad = baseBlueprint()
    const result = blueprintSafeParse({
      ...bad,
      style_direction: { ...(bad.style_direction as Record<string, unknown>), narration_id: 'BP_STYLE_NARR' },
    })
    expect(result.success).toBe(false)
  })

  it('Blueprint 顶层必须有 seed_fidelity（OQ-01）', () => {
    const bad = baseBlueprint()
    delete (bad as Record<string, unknown>).seed_fidelity
    expect(blueprintSafeParse(bad).success).toBe(false)
  })

  it('theme.secondary 的 ID 必须按顺序编号', () => {
    const bad = baseBlueprint()
    const theme = bad.theme as Record<string, unknown>
    const result = blueprintSafeParse({
      ...bad,
      theme: { ...theme, secondary: [{ id: 'BP_THEME_09', value: 'x', source_refs: [] }] },
    })
    expect(result.success).toBe(false)
  })

  it('value 允许为 null（§11.1 的占位示例）', () => {
    const bad = baseBlueprint()
    const arc = bad.arc as Record<string, Record<string, unknown>>
    expect(
      blueprintSafeParse({ ...bad, arc: { ...arc, shift: { ...arc.shift, value: null } } }).success,
    ).toBe(true)
  })

  it('未知字段被拒绝（不发明平行结构）', () => {
    expect(blueprintSafeParse({ ...baseBlueprint(), extra_field: 1 }).success).toBe(false)
  })
})

describe('Blueprint 禁止直接引用 scene_id（§11 / §11.2）', () => {
  it('扫描出任何位置的 scene-### 值与 scene 相关字段名', () => {
    const withSceneValue = baseBlueprint()
    const structure = withSceneValue.structure as Record<string, Record<string, unknown>>
    const issues = scanBlueprint({
      ...withSceneValue,
      structure: { ...structure, beginning: { ...structure.beginning, value: '在 scene-001 里发生' } },
    })
    expect(issues.some((issue) => issue.code === 'SCENE_REFERENCE')).toBe(true)

    const issuesFromKey = scanBlueprint({ ...baseBlueprint(), reveal_scene: 'scene-001' })
    expect(issuesFromKey.some((issue) => issue.path === 'reveal_scene')).toBe(true)
  })

  it('reveal_at_structure 必须引用 structure 位置，写 scene_id 会被拒绝', () => {
    const bad = baseBlueprint()
    const knowledge = (bad.key_knowledge as Record<string, unknown>[])[0] as Record<string, unknown>
    const result = blueprintSafeParse({ ...bad, key_knowledge: [{ ...knowledge, reveal_at_structure: 'scene-003' }] })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('必须引用 structure 位置')
  })

  it('validateBlueprint 会执行扫描（不是只有 schema 校验）', () => {
    const withScene = baseBlueprint()
    const structure = withScene.structure as Record<string, Record<string, unknown>>
    expect(() =>
      validateBlueprint({
        ...withScene,
        structure: { ...structure, climax: { ...structure.climax, value: '见 scene-004' } },
      }),
    ).toThrow(BlueprintValidationError)
  })
})

describe('Blueprint 内容项状态（原则 1 / 2 / 4）', () => {
  it('非 seed_fidelity 的 status 只能是 CONFIRMED', () => {
    const bad = baseBlueprint()
    const premise = bad.premise as Record<string, unknown>
    expect(() => validateBlueprint({ ...bad, premise: { ...premise, status: 'PROPOSED' } })).toThrow(
      BlueprintValidationError,
    )
    expect(scanBlueprint(baseBlueprint()).filter((issue) => issue.code !== 'SCENE_REFERENCE')).toEqual([])
  })

  it('seed_fidelity.added 保留 PROPOSED（Story 10 F 的原则 2 测试要求）', () => {
    const withAdded = baseBlueprint({
      seed_fidelity: {
        preserved: [],
        altered: [],
        added: [{ id: 'ADD_001', value: 'Harness 补出的设定', status: 'PROPOSED', source: 'harness' }],
        risk: [{ id: 'RISK_001', value: '风险', related_addition_refs: ['ADD_001'] }],
      },
    })
    expect(validateBlueprint(withAdded).seed_fidelity.added[0]?.status).toBe('PROPOSED')
    // 但 seed_fidelity 里出现 CONFIRMED 会被扫描拒绝（结构必须与 Proposal 一致）
    const wrong = baseBlueprint({
      seed_fidelity: {
        preserved: [],
        altered: [],
        added: [{ id: 'ADD_001', value: 'x', status: 'CONFIRMED', source: 'harness' }],
        risk: [],
      },
    })
    const issues = scanBlueprint(wrong)
    expect(issues.some((issue) => issue.code === 'UNEXPECTED_STATUS')).toBe(true)
  })
})

function meta(): Record<string, unknown> {
  return { title: '标题', genre: '类型', pov: ['CH_A'], target_length: 8000 }
}

function blueprintSafeParse(value: unknown): { success: boolean; error?: { issues: readonly unknown[] } } {
  try {
    validateBlueprint(value)
    return { success: true }
  } catch (error) {
    if (error instanceof BlueprintValidationError) {
      return { success: false, error: { issues: error.detail } }
    }
    throw error
  }
}
