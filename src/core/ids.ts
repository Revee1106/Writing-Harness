/**
 * ID 前缀登记表（Story 1，解读 I-11）
 *
 * 这里登记的每一个前缀都直接来自三份冻结基线文档中**已经出现**的示例；
 * Story 1 只做集中登记，不新增命名体系、不改变既有前缀。
 * 后续 Story 若要新增前缀，必须先在此登记并注明文档出处。
 *
 * 文档出处：
 * - `SEED_F###` / `SEED_Q###`  需求规格 §8.1 / §8.3
 * - `SEED_A###`                需求规格 §8.1 的 ambiguous 位（OQ-04 裁决：独立前缀）
 * - `PROP_X.field_path`       需求规格 §9.3（`<proposal_id>.<field_path>`）
 * - `BP_*`                     需求规格 §11.1（BP_PREMISE_01 / BP_STR_TURN / BP_FS_001 / BP_ARC_START / BP_STYLE_01）
 * - `CH_*` / `OBH_*` / `REL_*` 需求规格 §11.1
 * - `K###`                     需求规格 §11.1 / §13
 * - `OCC_K_*` / `OCC_REL_*`    需求规格 §18.1
 * - `scene-###`                需求规格 §29
 * - `ITEM_###`                 需求规格 §7 通用状态项示例
 */
export const ID_PATTERNS = {
  /** 需求规格 §8.1：原始 Seed 中直接抽取、status=USER_GIVEN / origin=raw_seed 的锚点 */
  seedAnchorFixed: /^SEED_F\d{3}$/,
  /** 需求规格 §8.1：Interpreter 判定的模糊项（OQ-04：无 status） */
  seedAmbiguous: /^SEED_A\d{3}$/,
  /** 需求规格 §8.3：Open Question，ID 在 seed.yaml 中稳定 */
  seedQuestion: /^SEED_Q\d{3}$/,
  /** 需求规格 §7.2：type=seed 的 source_ref 可指向任意 Seed item */
  seedItem: /^SEED_[FAQ]\d{3}$/,
  /** 需求规格 §9.1：Proposal 标识（示例 PROP_A / PROP_B / PROP_C） */
  proposalId: /^PROP_[A-Z0-9]+$/,
  /**
   * 需求规格 §9.3：Proposal 字段路径引用 `<proposal_id>.<field_path>`。
   * Story 3 扩展：允许 `[N]` 下标段（§9.1 的 seed_fidelity.added / risk 是列表，
   * 用户裁决要求 `seed_fidelity.added[N]` / `seed_fidelity.risk[N]` 可被引用）。
   */
  proposalFieldPath: /^PROP_[A-Z0-9]+\.[a-z][a-z0-9_]*(?:\[[0-9]+\])?(?:\.[a-z][a-z0-9_]*(?:\[[0-9]+\])?)*$/,
  /** 需求规格 §9.1 seed_fidelity.added[].id */
  proposalAddition: /^ADD_\d{3}$/,
  /** 需求规格 §9.1 seed_fidelity.risk[].id */
  proposalRisk: /^RISK_\d{3}$/,
  /** 需求规格 §9.1 conflicts[].id */
  proposalConflict: /^CONF_\d{3}$/,
  /** 需求规格 §11.1：Blueprint 可引用项（含 BP_STR_* / BP_FS_* / BP_ARC_* / BP_THEME_* / BP_STYLE_* / BP_CONFLICT_*） */
  blueprintItem: /^BP_[A-Z0-9_]+$/,
  character: /^CH_[A-Z0-9_]+$/,
  observableBehaviorHint: /^OBH_[A-Z0-9_]+$/,
  relationship: /^REL_[A-Z0-9_]+$/,
  keyKnowledge: /^K\d{3}$/,
  /** 需求规格 §18.1：OCC_K_<knowledge_id>_<scene_id> */
  occurredKnowledge: /^OCC_K_[A-Z0-9_]+_scene-\d{3}$/,
  /** 需求规格 §18.1：OCC_REL_<relationship_id>_<scene_id> */
  occurredRelationship: /^OCC_REL_[A-Z0-9_]+_scene-\d{3}$/,
  scene: /^scene-\d{3}$/,
  /** 需求规格 §7 通用状态项示例 id */
  genericItem: /^ITEM_\d{3}$/,
  /**
   * Scene 引用 Blueprint 项时使用的统一形态（§14 referenced_blueprint_items / §16 完整性检查）：
   * Blueprint 项包含 BP_*（premise/theme/structure/arc/foreshadowing/style）、K###（key knowledge）、
   * CH_*（角色）、OBH_*（可观察行为提示）、REL_*（关系）。
   */
  blueprintItemRef: /^(?:BP_[A-Z0-9_]+|K\d{3}|CH_[A-Z0-9_]+|OBH_[A-Z0-9_]+|REL_[A-Z0-9_]+)$/,
  /** Story 1 项目 id（OQ-20 / D7 裁决；形态为解读 I-5） */
  projectId: /^[a-z0-9][a-z0-9_-]{0,63}$/,
} as const

export type IdPatternName = keyof typeof ID_PATTERNS

/**
 * 允许出现在通用状态项 `source_ref`（单数，OQ-03 裁决）里的"稳定 ID 字符串"。
 * 不含 `projectId`：项目 id 不是故事状态引用。
 */
export const STABLE_ID_PATTERN_NAMES = [
  'seedAnchorFixed',
  'seedAmbiguous',
  'seedQuestion',
  'proposalId',
  'proposalFieldPath',
  'proposalAddition',
  'proposalRisk',
  'proposalConflict',
  'blueprintItem',
  'character',
  'observableBehaviorHint',
  'relationship',
  'keyKnowledge',
  'occurredKnowledge',
  'occurredRelationship',
  'scene',
  'genericItem',
] as const satisfies readonly IdPatternName[]

export function matchesIdPattern(name: IdPatternName, value: string): boolean {
  return ID_PATTERNS[name].test(value)
}

/**
 * 需求规格 §7.2：不允许使用无法解析的自由字符串作为 source ref。
 * 这里做的是"形态可解析"判定；跨文件的深层可解析性由各 Story 的 Store 负责。
 */
export function isStableId(value: string): boolean {
  return STABLE_ID_PATTERN_NAMES.some((name) => ID_PATTERNS[name].test(value))
}
