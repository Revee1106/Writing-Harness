import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { PROPOSAL_FIELD_PATHS, isProposalFieldPathAllowed, normalizeFieldPath } from '../core/proposal-field-paths.ts'

/**
 * Story Proposal Schema —— 需求规格 §9.1（唯一版本）/ 架构设计 §9.1；Story 3。
 *
 * 与本文件相关的用户裁决与解读：
 * - OQ-09：`proposals.yaml` 顶层为 `schema_version` + `proposals: [...]`；
 * - I-13/I-19：ID 由 Harness 规范化分配（`PROP_A/B/C`、`ADD_###`、`RISK_###`、`CONF_###`）；
 * - OQ-01：`seed_fidelity` 先在 Proposal 侧落地（Story 4 再落到 Blueprint 顶层）；
 * - 用户裁决第 3 项：`source_refs.type=proposal` 的字段路径受白名单约束（OQ-31）。
 */

export const PROPOSALS_SCHEMA_VERSION = '0.1'

/** 需求规格 §9.1：冲突处理结果枚举（必须可执行）。 */
export const CONFLICT_RESOLUTIONS = ['pending', 'kept_user', 'changed_user', 'dropped'] as const
export const conflictResolutionSchema = z.enum(CONFLICT_RESOLUTIONS)

/** Seed item 引用：`SEED_F###`（原始锚点）或 `SEED_A###`（Gate 1 提升项，§10.2 允许但不进分母）。 */
export const seedFidelityRefSchema = z
  .string()
  .regex(/^SEED_[FA]\d{3}$/, 'seed_ref 必须指向 Seed item（SEED_F### 或 SEED_A###）')

export const preservedEntrySchema = z.strictObject({
  seed_ref: seedFidelityRefSchema,
  value_in_proposal: z.string().min(1),
})

export const alteredEntrySchema = z.strictObject({
  seed_ref: seedFidelityRefSchema,
  original: z.string().min(1),
  changed_to: z.string().min(1),
})

/** 需求规格 §9.1：Harness 新增内容 —— 原则 2 在 Schema 层强制（必须 PROPOSED / harness）。 */
export const addedEntrySchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.proposalAddition, '新增项 ID 必须形如 ADD_001'),
  value: z.string().min(1),
  status: z.literal('PROPOSED'),
  source: z.literal('harness'),
})

export const riskEntrySchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.proposalRisk, '风险项 ID 必须形如 RISK_001'),
  value: z.string().min(1),
  related_addition_refs: z.array(z.string().regex(ID_PATTERNS.proposalAddition, '必须引用 ADD_### ID')),
})

export const seedFidelitySchema = z
  .strictObject({
    preserved: z.array(preservedEntrySchema),
    altered: z.array(alteredEntrySchema),
    added: z.array(addedEntrySchema),
    risk: z.array(riskEntrySchema),
  })
  .superRefine((fidelity, ctx) => {
    const addIds = new Set(fidelity.added.map((entry) => entry.id))
    for (const risk of fidelity.risk) {
      for (const ref of risk.related_addition_refs) {
        if (!addIds.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            path: ['risk'],
            message: `risk ${risk.id} 的 related_addition_refs 引用了不存在的新增项 ${ref}（需求规格 §9.1）`,
          })
        }
      }
    }
    const seenRefs = new Set<string>()
    for (const entry of fidelity.preserved) {
      if (seenRefs.has(entry.seed_ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['preserved'],
          message: `preserved 中 ${entry.seed_ref} 重复出现；同一 Seed Anchor 每份 Proposal 只能记一次（Seed Preservation Rate 去重口径）`,
        })
      }
      seenRefs.add(entry.seed_ref)
    }
  })

export const conflictSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.proposalConflict, '冲突项 ID 必须形如 CONF_001'),
  seed_ref: seedFidelityRefSchema,
  proposal_field: z.string().min(1).refine(isProposalFieldPathAllowed, {
    error: () => ({ message: `proposal_field 不在字段路径白名单内（Story 3 提议，见 OQ-31）：${PROPOSAL_FIELD_PATHS.join(' / ')}` }),
  }),
  user_value: z.string().min(1),
  proposal_value: z.string().min(1),
  resolution: conflictResolutionSchema,
})

/** 需求规格 §9.1 的 Proposal 字段；`proposal_id` 由 Harness 规范化后写入。 */
export const proposalSchema = z.strictObject({
  proposal_id: z.string().regex(ID_PATTERNS.proposalId, 'proposal_id 必须形如 PROP_A'),
  title: z.string().min(1),
  genre: z.string().min(1),
  core_premise: z.string().min(1),
  core_conflict: z.string().min(1),
  truth_or_turn: z.string().min(1),
  character_arc: z.string().min(1),
  ending: z.string().min(1),
  /** 需求规格 §11.3 的 POV 规则同样适用于 Proposal：长度 ∈ {1,2}，元素为 character id。 */
  pov: z.array(z.string().regex(ID_PATTERNS.character, 'pov 元素必须是 CH_* 角色 ID')).min(1).max(2),
  target_length: z.number().int().positive(),
  tone: z.string().min(1),
  seed_fidelity: seedFidelitySchema,
  conflicts: z.array(conflictSchema),
})
export type Proposal = z.infer<typeof proposalSchema>

export const proposalsFileSchema = z
  .strictObject({
    schema_version: z.literal(PROPOSALS_SCHEMA_VERSION),
    proposals: z.array(proposalSchema).min(2).max(3),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>()
    for (const proposal of file.proposals) {
      if (ids.has(proposal.proposal_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['proposals'],
          message: `proposal_id 重复：${proposal.proposal_id}`,
        })
      }
      ids.add(proposal.proposal_id)
      const conflictIds = new Set<string>()
      for (const conflict of proposal.conflicts) {
        if (conflictIds.has(conflict.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['proposals'],
            message: `${proposal.proposal_id} 内 conflicts[].id 重复：${conflict.id}`,
          })
        }
        conflictIds.add(conflict.id)
      }
    }
  })
export type ProposalsFile = z.infer<typeof proposalsFileSchema>

export class ProposalValidationError extends Error {
  override readonly name = 'ProposalValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`proposals.yaml 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateProposalsFile(value: unknown): ProposalsFile {
  const parsed = proposalsFileSchema.safeParse(value)
  if (!parsed.success) {
    throw new ProposalValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data) as ProposalsFile
}

// ---------------------------------------------------------------------------
// Seed Preservation Rate（需求规格 §10.2；用户裁决第 1 项）
// ---------------------------------------------------------------------------

export const SEED_PRESERVATION_NOTICE_CODES = [
  'UNACCOUNTED_ANCHOR',
  'SEED_REF_NOT_ANCHOR',
  'EMPTY_DENOMINATOR',
] as const
export type SeedPreservationNoticeCode = (typeof SEED_PRESERVATION_NOTICE_CODES)[number]

export interface SeedPreservationNotice {
  readonly code: SeedPreservationNoticeCode
  readonly message: string
  readonly seed_ref?: string | undefined
}

export interface SeedPreservationRate {
  readonly proposal_id: string
  /** 分子：preserved 中命中 raw_seed_anchor_ids 的锚点数（去重后）。 */
  readonly numerator: number
  /** 分母：首次 Interpreter 冻结的 raw_seed_anchor_ids 总数。 */
  readonly denominator: number
  /** 0～1；分母为 0 时为 null（不产生 0/0）。 */
  readonly rate: number | null
  readonly rate_percent: number | null
  readonly preserved_anchor_ids: readonly string[]
  /** 既不在 preserved、也不在 altered、也不在 conflicts 中的锚点（warning，不计分子）。 */
  readonly unaccounted_anchor_ids: readonly string[]
  /** preserved/altered/conflicts 中引用、但不属于分母的 Seed item（例如 Gate 1 提升项，§10.2）。 */
  readonly out_of_denominator_refs: readonly string[]
  readonly notices: readonly SeedPreservationNotice[]
}

/**
 * 计算 Seed Preservation Rate。
 *
 * 边界（用户裁决第 1 项）：
 * 1. 分母 = `raw_seed_anchor_ids`（首次 Interpreter 冻结，不随 Gate 1 漂移，§10.1）；
 * 2. 分子 = `preserved` 中出现、且属于分母的锚点数；**`altered` 与 `conflicts` 不计入分子**；
 * 3. 某个 raw_seed_anchor 在 preserved / altered / conflicts 中都没有出现 → 产生
 *    `UNACCOUNTED_ANCHOR` warning，且不计入分子；
 * 4. 引用不在分母内的 Seed item（如 Gate 1 提升项）→ 记入 `out_of_denominator_refs`，
 *    不参与分子分母（§10.2「Gate 1 确认的推测可作为额外约束，但不进入分母」）；
 * 5. 同一锚点在 preserved 中出现多次只计一次；
 * 6. 分母为 0 时 rate = null，并给出 `EMPTY_DENOMINATOR` notice。
 */
export function computeSeedPreservationRate(
  proposal: Pick<Proposal, 'proposal_id' | 'seed_fidelity' | 'conflicts'>,
  rawSeedAnchorIds: readonly string[],
): SeedPreservationRate {
  const denominatorSet = new Set(rawSeedAnchorIds)
  const preservedAnchorIds = new Set<string>()
  const outOfDenominatorRefs = new Set<string>()
  const mentionedAnchors = new Set<string>()

  for (const entry of proposal.seed_fidelity.preserved) {
    if (denominatorSet.has(entry.seed_ref)) {
      preservedAnchorIds.add(entry.seed_ref)
      mentionedAnchors.add(entry.seed_ref)
    } else {
      outOfDenominatorRefs.add(entry.seed_ref)
    }
  }
  for (const entry of proposal.seed_fidelity.altered) {
    if (denominatorSet.has(entry.seed_ref)) {
      mentionedAnchors.add(entry.seed_ref)
    } else {
      outOfDenominatorRefs.add(entry.seed_ref)
    }
  }
  for (const conflict of proposal.conflicts) {
    if (denominatorSet.has(conflict.seed_ref)) {
      mentionedAnchors.add(conflict.seed_ref)
    } else {
      outOfDenominatorRefs.add(conflict.seed_ref)
    }
  }

  const unaccountedAnchorIds = rawSeedAnchorIds.filter((anchorId) => !mentionedAnchors.has(anchorId))
  const notices: SeedPreservationNotice[] = []

  for (const anchorId of unaccountedAnchorIds) {
    notices.push({
      code: 'UNACCOUNTED_ANCHOR',
      message: `${anchorId} 既没有出现在 preserved，也没有出现在 altered / conflicts 中；该锚点不计入分子，且说明 Proposal 未对该核心做出明确处置（用户裁决第 1 项）`,
      seed_ref: anchorId,
    })
  }
  for (const ref of outOfDenominatorRefs) {
    notices.push({
      code: 'SEED_REF_NOT_ANCHOR',
      message: `${ref} 不属于 raw_seed_anchor_ids（常见于 Gate 1 用户提升项）：作为额外约束记录，不参与 Seed Preservation Rate 分子分母（需求规格 §10.2）`,
      seed_ref: ref,
    })
  }

  const numerator = preservedAnchorIds.size
  const denominator = rawSeedAnchorIds.length
  if (denominator === 0) {
    notices.push({
      code: 'EMPTY_DENOMINATOR',
      message: 'raw_seed_anchor_ids 为空（Seed 中没有 origin=raw_seed 的锚点）：Seed Preservation Rate 记为 null',
    })
  }
  const rate = denominator === 0 ? null : numerator / denominator

  return {
    proposal_id: proposal.proposal_id,
    numerator,
    denominator,
    rate,
    rate_percent: rate === null ? null : Math.round(rate * 1000) / 10,
    preserved_anchor_ids: [...preservedAnchorIds].sort(),
    unaccounted_anchor_ids: unaccountedAnchorIds,
    out_of_denominator_refs: [...outOfDenominatorRefs].sort(),
    notices,
  }
}

// ---------------------------------------------------------------------------
// Proposal 差异度（Story 3 验收：「差异不是措辞差异」；用户裁决第 2 项）
// ---------------------------------------------------------------------------

/**
 * 差异度判定维度（5 个结构性维度）。
 *
 * 判定规则（用户裁决第 2 项 + Story 3 提议）：
 * - 硬性条件 A：`core_conflict` / `truth_or_turn` / `ending` 三个维度中 **≥2 个不同**；
 * - 硬性条件 B：5 个维度中 **≥3 个不同**（条件 A 的超集，整体上"差异明显"）；
 * - 标题 / tone 等表达性字段不参与判定（避免把"措辞差异"算成结构差异）。
 *
 * 判定失败只是 **warning**（需求规格 §28：差异不足时用户可以"重做"，不得卡住用户）。
 */
export const DISTINCTNESS_DIMENSIONS = [
  'core_conflict',
  'truth_or_turn',
  'ending',
  'character_arc',
  'core_premise',
] as const
export type DistinctnessDimension = (typeof DISTINCTNESS_DIMENSIONS)[number]

/** 必须至少有 2 个不同的核心维度（用户指定的三元组）。 */
export const REQUIRED_CORE_DIMENSIONS = ['core_conflict', 'truth_or_turn', 'ending'] as const
export const MIN_CORE_DIMENSION_DIFFS = 2
export const MIN_TOTAL_DIMENSION_DIFFS = 3

export interface ProposalPairDistinctness {
  readonly pair: readonly [string, string]
  readonly differing_dimensions: readonly DistinctnessDimension[]
  readonly differing_core_dimensions: readonly DistinctnessDimension[]
  readonly ok: boolean
  readonly reason: string
}

export interface ProposalDistinctnessReport {
  readonly pairs: readonly ProposalPairDistinctness[]
  readonly ok: boolean
  readonly warnings: readonly string[]
}

function normalizeForComparison(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').replace(/[，。、；：！？"'（）()【】\[\]]/gu, '')
}

export function compareProposalPair(a: Proposal, b: Proposal): ProposalPairDistinctness {
  const differing: DistinctnessDimension[] = []
  for (const dimension of DISTINCTNESS_DIMENSIONS) {
    if (normalizeForComparison(a[dimension]) !== normalizeForComparison(b[dimension])) {
      differing.push(dimension)
    }
  }
  const differingCore = differing.filter((dimension) =>
    (REQUIRED_CORE_DIMENSIONS as readonly string[]).includes(dimension),
  )
  const ok = differingCore.length >= MIN_CORE_DIMENSION_DIFFS && differing.length >= MIN_TOTAL_DIMENSION_DIFFS
  return {
    pair: [a.proposal_id, b.proposal_id],
    differing_dimensions: differing,
    differing_core_dimensions: differingCore,
    ok,
    reason: ok
      ? `差异维度 ${differing.length} 个（核心维度 ${differingCore.length} 个）：${differing.join(' / ')}`
      : `差异不足：核心维度不同 ${differingCore.length} 个（要求 ≥${MIN_CORE_DIMENSION_DIFFS}）、总差异维度 ${differing.length} 个（要求 ≥${MIN_TOTAL_DIMENSION_DIFFS}）；实际差异：${differing.join(' / ') || '无'}`,
  }
}

export function checkProposalDistinctness(proposals: readonly Proposal[]): ProposalDistinctnessReport {
  const pairs: ProposalPairDistinctness[] = []
  for (let i = 0; i < proposals.length; i += 1) {
    for (let j = i + 1; j < proposals.length; j += 1) {
      const a = proposals[i] as Proposal
      const b = proposals[j] as Proposal
      pairs.push(compareProposalPair(a, b))
    }
  }
  const warnings = pairs
    .filter((pair) => !pair.ok)
    .map(
      (pair) =>
        `差异度不足（${pair.pair.join(' vs ')}）：${pair.reason}。需求规格 §28 允许用户"重做" Proposal，本次不阻塞。`,
    )
  return { pairs, ok: warnings.length === 0, warnings }
}

/** 校验 `source_refs.type=proposal` 之外的另一半：Proposal 内容里引用的字段路径是否合法。 */
export function listProposalFieldPaths(): readonly string[] {
  return PROPOSAL_FIELD_PATHS
}

export { isProposalFieldPathAllowed, normalizeFieldPath }
