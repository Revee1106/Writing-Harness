import { describe, expect, it } from 'vitest'
import { ID_PATTERNS, STABLE_ID_PATTERN_NAMES, isStableId, matchesIdPattern } from '../../src/core/ids.ts'

describe('ID 前缀登记表（Story 1，解读 I-11）', () => {
  it('登记了三份文档中已出现的全部 ID 形态', () => {
    const documentedExamples: Array<[string, string]> = [
      ['seedAnchorFixed', 'SEED_F001'], // 需求规格 §8.1
      ['seedAmbiguous', 'SEED_A001'], //           §8.1 ambiguous 位（OQ-04）
      ['seedQuestion', 'SEED_Q001'], //            §8.3
      ['proposalFieldPath', 'PROP_A.core_premise'], // §9.3
      ['blueprintItem', 'BP_PREMISE_01'], //       §11.1
      ['blueprintItem', 'BP_STR_TURN'], //         §11.1
      ['blueprintItem', 'BP_FS_001'], //           §11.1
      ['blueprintItem', 'BP_ARC_START'], //        §11.1
      ['blueprintItem', 'BP_STYLE_01'], //         §11.1
      ['character', 'CH_LIN_YU'], //               §11.1
      ['observableBehaviorHint', 'OBH_LINYU_01'], // §11.1
      ['relationship', 'REL_LINYU_CHENMO'], //     §11.1
      ['keyKnowledge', 'K001'], //                 §13
      ['occurredKnowledge', 'OCC_K_K001_scene-003'], // §18.1
      ['occurredRelationship', 'OCC_REL_REL_LINYU_CHENMO_scene-006'], // §18.1
      ['scene', 'scene-001'], //                   §29
      ['genericItem', 'ITEM_001'], //              §7 示例
      ['projectId', 'demo-01'], //                 OQ-20 / D7
    ]
    for (const [patternName, value] of documentedExamples) {
      expect(matchesIdPattern(patternName as keyof typeof ID_PATTERNS, value), `${patternName} 应接受 ${value}`).toBe(true)
    }
  })

  it('拒绝形态不符的 ID', () => {
    expect(matchesIdPattern('seedAnchorFixed', 'SEED_F01')).toBe(false)
    expect(matchesIdPattern('seedAnchorFixed', 'SEED_A001')).toBe(false)
    expect(matchesIdPattern('keyKnowledge', 'K1')).toBe(false)
    expect(matchesIdPattern('scene', 'scene-1')).toBe(false)
    expect(matchesIdPattern('proposalFieldPath', 'PROP_A')).toBe(false)
    expect(matchesIdPattern('projectId', 'Demo_01')).toBe(false)
    expect(matchesIdPattern('projectId', '-demo')).toBe(false)
  })

  it('isStableId 只接受可解析形态，拒绝自由字符串（需求规格 §7.2）', () => {
    expect(isStableId('SEED_F001')).toBe(true)
    expect(isStableId('PROP_A.core_premise')).toBe(true)
    expect(isStableId('BP_STR_TURN')).toBe(true)
    expect(isStableId('随便一句话')).toBe(false)
    expect(isStableId('proposal A')).toBe(false)
    expect(isStableId('')).toBe(false)
  })

  it('稳定 ID 集合不包含 projectId（项目 id 不是故事状态引用）', () => {
    expect(STABLE_ID_PATTERN_NAMES).not.toContain('projectId')
  })
})
