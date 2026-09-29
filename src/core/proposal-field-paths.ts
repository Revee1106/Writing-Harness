/**
 * Proposal 字段路径白名单（Story 3，用户裁决第 3 项）。
 *
 * 需求规格 §9.3 规定 `source_refs.type=proposal` 的 `ref_id` 采用
 * `<proposal_id>.<field_path>`，且"必须可解析到真实 Proposal 和字段路径"。
 * 文档没有枚举合法的字段路径集合，Story 3 提议并冻结以下白名单
 * （最小覆盖用户指定项：core_premise / core_conflict / truth_or_turn /
 *  character_arc / ending / seed_fidelity.added[N] / seed_fidelity.risk[N]）。
 *
 * 白名单只增不改：新增路径必须回到本文件并注明出处（见 docs/OPEN-QUESTIONS.md OQ-31）。
 */

/** 顶层标量字段（可直接被引用）。 */
export const PROPOSAL_SCALAR_FIELD_PATHS = [
  'title',
  'genre',
  'core_premise',
  'core_conflict',
  'truth_or_turn',
  'character_arc',
  'ending',
  'pov',
  'target_length',
  'tone',
] as const

/** seed_fidelity 内部的容器与叶子路径。 */
export const PROPOSAL_SEED_FIDELITY_FIELD_PATHS = [
  'seed_fidelity',
  'seed_fidelity.preserved',
  'seed_fidelity.altered',
  'seed_fidelity.added',
  'seed_fidelity.risk',
  'seed_fidelity.preserved[N].value_in_proposal',
  'seed_fidelity.altered[N].changed_to',
  'seed_fidelity.added[N].value',
  'seed_fidelity.risk[N].value',
] as const

/** conflicts 内部可被引用的字段。 */
export const PROPOSAL_CONFLICT_FIELD_PATHS = ['conflicts[N].proposal_value'] as const

/** 不带 proposal_id 前缀的字段路径白名单（用于 conflicts[].proposal_field 校验）。 */
export const PROPOSAL_FIELD_PATHS: readonly string[] = [
  ...PROPOSAL_SCALAR_FIELD_PATHS,
  ...PROPOSAL_SEED_FIDELITY_FIELD_PATHS,
  ...PROPOSAL_CONFLICT_FIELD_PATHS,
]

const FIELD_PATH_SET = new Set(PROPOSAL_FIELD_PATHS)
const PROPOSAL_REF_PATTERN = /^(PROP_[A-Z0-9]+)\.(.+)$/

export interface ParsedProposalFieldPath {
  readonly proposalId: string
  readonly fieldPath: string
}

/**
 * 解析 `PROP_A.core_premise` 形式的引用；返回 null 表示形态或白名单不匹配。
 * `[N]` 下标段在解析时被归一化为字面量 `[N]`，以便与白名单逐字符比较。
 */
export function parseProposalFieldPath(refId: string): ParsedProposalFieldPath | null {
  const match = PROPOSAL_REF_PATTERN.exec(refId)
  if (match === null) return null
  const proposalId = match[1] as string
  const fieldPath = normalizeFieldPath(match[2] as string)
  if (!FIELD_PATH_SET.has(fieldPath)) return null
  return { proposalId, fieldPath }
}

/** 校验不带前缀的字段路径（conflicts[].proposal_field）。 */
export function isProposalFieldPathAllowed(fieldPath: string): boolean {
  return FIELD_PATH_SET.has(normalizeFieldPath(fieldPath))
}

/** 把任意数字下标归一化成 `[N]`，使 `added[0]` / `added[3]` 都命中白名单中的 `added[N]`。 */
export function normalizeFieldPath(fieldPath: string): string {
  return fieldPath.replace(/\[\d+\]/g, '[N]')
}

export function proposeProposalRef(proposalId: string, fieldPath: string): string {
  return `${proposalId}.${fieldPath}`
}
