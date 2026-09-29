import { describe, expect, it } from 'vitest'
import { SCENE_TYPES, TONE_TAGS, OBSERVABLE_HINT_TAGS, isObservableHintTag, isSceneType } from '../../src/core/scene-types.ts'
import { DIRECTOR_NOTE_SOURCES, SceneValidationError, validateScene } from '../../src/schema/scene.ts'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'

function baseScene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '0.1',
    scene_id: 'scene-001',
    order: 1,
    pov: 'CH_A',
    scene_type: 'dialogue',
    purpose: '目的',
    target_length: 1200,
    narrative_role_ref: 'BP_STR_BEG',
    characters: ['CH_A', 'CH_B'],
    location: '地点',
    start_state: '开场',
    conflict: '冲突',
    turn: '转折',
    end_state: '收场',
    allowed_reveals: [],
    director_notes: [],
    referenced_blueprint_items: [],
    proposed_additions: [],
    ...overrides,
  }
}

describe('Scene 类型与 tone 标签（OQ-36 / OQ-41）', () => {
  it('scene_type 严格为四种', () => {
    expect(SCENE_TYPES).toEqual(['dialogue', 'action', 'interior', 'transition'])
    expect(isSceneType('dialogue')).toBe(true)
    expect(isSceneType('conflict')).toBe(false)
  })

  it('OBH 联合白名单 = scene_type ∪ tone，且包含 conflict（tone）与 dialogue（scene_type）', () => {
    expect(OBSERVABLE_HINT_TAGS).toEqual([...SCENE_TYPES, ...TONE_TAGS])
    expect(isObservableHintTag('dialogue')).toBe(true)
    expect(isObservableHintTag('conflict')).toBe(true)
    expect(isObservableHintTag('whatever')).toBe(false)
  })

  it('Scene Schema 只接受四种 scene_type', () => {
    for (const sceneType of SCENE_TYPES) {
      expect(validateScene(baseScene({ scene_type: sceneType })).scene_type).toBe(sceneType)
    }
    expect(() => validateScene(baseScene({ scene_type: 'conflict' }))).toThrow(SceneValidationError)
  })
})

describe('Scene Schema（需求规格 §14）', () => {
  it('接受最小合法 Scene 且字段完整', () => {
    const scene = validateScene(baseScene())
    expect(Object.keys(scene).sort()).toEqual([
      'allowed_reveals',
      'characters',
      'conflict',
      'director_notes',
      'end_state',
      'location',
      'narrative_role_ref',
      'order',
      'pov',
      'proposed_additions',
      'purpose',
      'referenced_blueprint_items',
      'scene_id',
      'scene_type',
      'schema_version',
      'start_state',
      'target_length',
      'turn',
    ])
  })

  it('scene_id / order / pov / target_length 形态受约束', () => {
    expect(() => validateScene(baseScene({ scene_id: 'scene-1' }))).toThrow(SceneValidationError)
    expect(() => validateScene(baseScene({ order: 0 }))).toThrow(SceneValidationError)
    expect(() => validateScene(baseScene({ pov: 'LIN_YU' }))).toThrow(SceneValidationError)
    expect(() => validateScene(baseScene({ target_length: 0 }))).toThrow(SceneValidationError)
  })

  it('narrative_role_ref 允许 structure 与 arc 位置（OQ-42），拒绝其它形态', () => {
    for (const ref of ['BP_STR_BEG', 'BP_STR_END', 'BP_ARC_START', 'BP_ARC_SHIFT', 'BP_ARC_END']) {
      expect(validateScene(baseScene({ narrative_role_ref: ref })).narrative_role_ref).toBe(ref)
    }
    for (const bad of ['scene-001', 'BP_THEME_01', 'BP_STR_UNKNOWN']) {
      expect(() => validateScene(baseScene({ narrative_role_ref: bad })), bad).toThrow(SceneValidationError)
    }
  })

  it('allowed_reveals 只能引用 K###（§15）', () => {
    expect(validateScene(baseScene({ allowed_reveals: ['K001', 'K002'] })).allowed_reveals).toEqual(['K001', 'K002'])
    expect(() => validateScene(baseScene({ allowed_reveals: ['BP_STR_BEG'] }))).toThrow(SceneValidationError)
    expect(() => validateScene(baseScene({ allowed_reveals: ['scene-002'] }))).toThrow(SceneValidationError)
  })

  it('director_notes 按 OQ-11：ID 前缀与 source 一致，blueprint 必须带 blueprint_ref', () => {
    expect(DIRECTOR_NOTE_SOURCES).toEqual(['user', 'blueprint', 'scene'])
    const ok = validateScene(
      baseScene({
        director_notes: [
          { id: 'DIR_USER_001', instruction: '对白再短一点', source: 'user' },
          { id: 'DIR_BLUEPRINT_001', instruction: '按 style_direction 的节奏', source: 'blueprint', blueprint_ref: 'BP_STYLE_01' },
          { id: 'DIR_SCENE_001', instruction: '不写内心', source: 'scene' },
        ],
      }),
    )
    expect(ok.director_notes).toHaveLength(3)
    // ID 前缀与 source 不一致
    expect(() =>
      validateScene(baseScene({ director_notes: [{ id: 'DIR_USER_001', instruction: 'x', source: 'scene' }] })),
    ).toThrow(/ID 前缀必须与 source 一致/)
    // blueprint 来源缺 blueprint_ref
    expect(() =>
      validateScene(baseScene({ director_notes: [{ id: 'DIR_BLUEPRINT_001', instruction: 'x', source: 'blueprint' }] })),
    ).toThrow(/必须携带 blueprint_ref/)
    // 非 blueprint 来源不得带 blueprint_ref
    expect(() =>
      validateScene(
        baseScene({ director_notes: [{ id: 'DIR_USER_001', instruction: 'x', source: 'user', blueprint_ref: 'BP_STYLE_01' }] }),
      ),
    ).toThrow(/只有 source=blueprint/)
  })

  it('proposed_additions 永久 PROPOSED / scene_breakdown（OQ-14）', () => {
    const scene = validateScene(
      baseScene({ proposed_additions: [{ id: 'ADD_001', value: '新增内容', status: 'PROPOSED', source: 'scene_breakdown' }] }),
    )
    expect(scene.proposed_additions[0]?.source).toBe('scene_breakdown')
    // 不允许伪装成已确认内容
    expect(() =>
      validateScene(
        baseScene({ proposed_additions: [{ id: 'ADD_001', value: 'x', status: 'CONFIRMED', source: 'scene_breakdown' }] }),
      ),
    ).toThrow(SceneValidationError)
    expect(() =>
      validateScene(baseScene({ proposed_additions: [{ id: 'ADD_001', value: 'x', status: 'PROPOSED', source: 'harness' }] })),
    ).toThrow(SceneValidationError)
  })

  it('proposed_additions / director_notes 的 ID 在同一 Scene 内唯一', () => {
    expect(() =>
      validateScene(
        baseScene({
          proposed_additions: [
            { id: 'ADD_001', value: 'a', status: 'PROPOSED', source: 'scene_breakdown' },
            { id: 'ADD_001', value: 'b', status: 'PROPOSED', source: 'scene_breakdown' },
          ],
        }),
      ),
    ).toThrow(/必须唯一/)
  })

  it('referenced_blueprint_items 接受 Blueprint 项 ID 的并集形态（§16 由 Coverage 校验存在性）', () => {
    const scene = validateScene(
      baseScene({ referenced_blueprint_items: ['BP_PREMISE_01', 'K001', 'CH_A', 'OBH_A_01', 'REL_A_B'] }),
    )
    expect(scene.referenced_blueprint_items).toHaveLength(5)
    expect(() => validateScene(baseScene({ referenced_blueprint_items: ['scene-002'] }))).toThrow(SceneValidationError)
    expect(() => validateScene(baseScene({ referenced_blueprint_items: ['随便写的'] }))).toThrow(SceneValidationError)
  })

  it('未知字段被拒绝', () => {
    expect(() => validateScene(baseScene({ extra: 1 }))).toThrow(SceneValidationError)
  })

  it('YAML 往返一致', () => {
    const scene = validateScene(baseScene())
    expect(validateScene(loadYaml(dumpYaml(scene)))).toEqual(scene)
  })
})
