import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { hashContractInput } from '../core/hash.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { extractYamlBlock } from '../interpreter/schema.ts'
import { dumpYaml } from '../io/yaml.ts'
import {
  ARC_IDS,
  ARC_KEYS,
  BLUEPRINT_SCHEMA_VERSION,
  CORE_CONFLICT_ID,
  PREMISE_ID,
  STYLE_DIRECTION_ID,
  STRUCTURE_IDS,
  STRUCTURE_KEYS,
  validateBlueprint,
  type Blueprint,
} from '../schema/blueprint.ts'
import type { Proposal, ProposalsFile } from '../schema/proposal.ts'
import type { SourceRef } from '../core/source-ref.ts'
import type { LLMProvider } from '../providers/types.ts'

/**
 * Blueprint Builder（Story 4；需求规格 §11；架构设计 §10）。
 *
 * 职责（架构设计 §10）：选择 / 合并 Proposal、接受用户手改、把用户接受的内容转为 CONFIRMED、
 * 生成 Blueprint 与快照。
 *
 * 本模块负责"确定性"的部分：
 * - 校验字段计划（两 Proposal 都有该字段而用户未指定 → 报错，不自动取 A）；
 * - 调用 `blueprint_builder@0.1` 整理 Blueprint 内容；
 * - 为所有可引用项分配稳定 ID；
 * - 把 `derived_from` 转换为结构化 `source_refs`；
 * - 校验 Blueprint（含"禁止引用 scene_id"扫描）。
 */

export const BLUEPRINT_BUILDER_CONTRACT_ID = 'blueprint_builder'
export const BLUEPRINT_BUILDER_CONTRACT_VERSION = '0.1'

/** Gate 2 可逐字段指定来源的 Blueprint 字段集合。 */
export const MERGEABLE_FIELDS = [
  'title',
  'genre',
  'pov',
  'target_length',
  'premise',
  'theme',
  'characters',
  'core_conflict',
  'arc',
  'structure',
  'key_knowledge',
  'foreshadowing',
  'style_direction',
] as const
export type MergeableField = (typeof MERGEABLE_FIELDS)[number]

/** `seed_fidelity` 不作为可合并字段：它由被选中 Proposal 的 seed_fidelity 合并而成（OQ-01）。 */
export const SEED_FIDELITY_FIELD = 'seed_fidelity'

export class Gate2PlanError extends Error {
  override readonly name = 'Gate2PlanError'
  readonly detail: readonly string[]
  constructor(message: string, detail: readonly string[] = []) {
    super(detail.length === 0 ? message : `${message}\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export class BlueprintBuilderOutputError extends Error {
  override readonly name = 'BlueprintBuilderOutputError'
  readonly detail: readonly string[]
  readonly rawOutput: string
  constructor(detail: readonly string[], rawOutput: string) {
    super(`Blueprint Builder 输出不符合契约：\n- ${detail.join('\n- ')}`)
    this.detail = detail
    this.rawOutput = rawOutput
  }
}

// ---------------------------------------------------------------------------
// 字段计划
// ---------------------------------------------------------------------------

export interface FieldSource {
  readonly field: MergeableField
  /** Proposal ID（如 `PROP_A`），或 `user`（用户手写；需要提供 user_edits）。 */
  readonly from: string
}

export interface FieldPlanInput {
  /** `--from PROP_A` 的单来源快捷方式。 */
  readonly fromProposal?: string | undefined
  /** `--field <field>=<source>` 的逐字段指定。 */
  readonly fields?: Readonly<Record<string, string>> | undefined
  readonly proposals: ProposalsFile
}

export interface ResolvedFieldPlan {
  readonly mode: 'single' | 'merge' | 'manual'
  readonly sources: readonly FieldSource[]
  readonly participatingProposalIds: readonly string[]
  readonly userFields: readonly MergeableField[]
}

/**
 * 解析并校验字段计划（用户裁决：合并必须逐字段指定；未指定则报错，不自动取 A）。
 */
export function resolveFieldPlan(input: FieldPlanInput): ResolvedFieldPlan {
  const proposalIds = input.proposals.proposals.map((proposal) => proposal.proposal_id)
  const explicit = input.fields ?? {}
  const sources: FieldSource[] = []
  const problems: string[] = []

  for (const key of Object.keys(explicit)) {
    if (!(MERGEABLE_FIELDS as readonly string[]).includes(key)) {
      problems.push(`--field 出现未知字段 "${key}"；可指定字段：${MERGEABLE_FIELDS.join(' / ')}`)
    }
  }

  const defaultFrom = input.fromProposal
  if (defaultFrom !== undefined && !proposalIds.includes(defaultFrom)) {
    problems.push(`--from 指定的提案不存在：${defaultFrom}（可用：${proposalIds.join(' / ')}）`)
  }
  for (const [field, source] of Object.entries(explicit)) {
    if (source !== 'user' && !proposalIds.includes(source)) {
      problems.push(`--field ${field}=${source} 的来源无效：必须是 ${proposalIds.join(' / ')} 之一，或 "user"`)
    }
  }

  for (const field of MERGEABLE_FIELDS) {
    const chosen = explicit[field]
    if (chosen !== undefined) {
      sources.push({ field, from: chosen })
      continue
    }
    if (defaultFrom !== undefined) {
      sources.push({ field, from: defaultFrom })
      continue
    }
    // 用户裁决：字段在两个 Proposal 都有而用户未指定 → 报错，不自动取 A
    problems.push(
      `字段 "${field}" 没有指定来源：${proposalIds.length} 个 Proposal 都包含该字段，Gate 2 不自动选择（用户裁决）。请用 --from <提案> 或 --field ${field}=<提案|user>`,
    )
  }

  if (problems.length > 0) {
    throw new Gate2PlanError('Gate 2 字段计划不完整', problems)
  }

  const participating = [...new Set(sources.map((source) => source.from).filter((from) => from !== 'user'))].sort()
  const userFields = sources.filter((source) => source.from === 'user').map((source) => source.field)
  const mode: ResolvedFieldPlan['mode'] =
    participating.length === 0 ? 'manual' : participating.length === 1 && userFields.length === 0 ? 'single' : 'merge'

  return {
    mode,
    sources,
    participatingProposalIds: participating,
    userFields,
  }
}

// ---------------------------------------------------------------------------
// 结构化来源引用
// ---------------------------------------------------------------------------

/** Blueprint 字段 → 该字段在 Proposal 中的代表字段路径（用于 `source_refs`）。 */
export const FIELD_TO_PROPOSAL_PATH: Readonly<Record<MergeableField, string>> = {
  title: 'title',
  genre: 'genre',
  pov: 'pov',
  target_length: 'target_length',
  premise: 'core_premise',
  theme: 'core_conflict',
  characters: 'core_premise',
  core_conflict: 'core_conflict',
  arc: 'character_arc',
  structure: 'ending',
  key_knowledge: 'truth_or_turn',
  foreshadowing: 'core_conflict',
  style_direction: 'tone',
}

export interface BlueprintBuildInputs {
  readonly plan: ResolvedFieldPlan
  readonly userEdits: readonly { readonly id: string; readonly field: MergeableField; readonly value: string }[]
  readonly conflictResolutions: readonly {
    readonly id: string
    readonly proposal_id: string
    readonly seed_ref: string
    readonly resolution: string
  }[]
  /** 本次 Gate 2 动作 ID（`GATE2_<NNN>`）。 */
  readonly gate2ActionId: string
}

/** 构造 Prompt Contract 的结构化输入（同时决定 recorded fixture 的查找键）。 */
export function buildBlueprintBuilderInput(
  proposals: ProposalsFile,
  inputs: BlueprintBuildInputs,
): Readonly<Record<string, unknown>> {
  const participating = proposals.proposals.filter((proposal) =>
    inputs.plan.participatingProposalIds.includes(proposal.proposal_id),
  )
  return {
    field_plan: inputs.plan.sources.map((source) => ({ field: source.field, from: source.from })),
    proposals: participating.map((proposal) => ({
      proposal_id: proposal.proposal_id,
      title: proposal.title,
      genre: proposal.genre,
      core_premise: proposal.core_premise,
      core_conflict: proposal.core_conflict,
      truth_or_turn: proposal.truth_or_turn,
      character_arc: proposal.character_arc,
      ending: proposal.ending,
      pov: proposal.pov,
      target_length: proposal.target_length,
      tone: proposal.tone,
    })),
    user_edits: inputs.userEdits.map((edit) => ({ field: edit.field, value: edit.value })),
    conflict_resolutions: inputs.conflictResolutions.map((resolution) => ({
      id: resolution.id,
      proposal_id: resolution.proposal_id,
      seed_ref: resolution.seed_ref,
      resolution: resolution.resolution,
    })),
  }
}

/** `derived_from` 的三种形态（见 Prompt Contract）。 */
export type DerivedFrom =
  | { readonly kind: 'proposal'; readonly proposalId: string; readonly fieldPath: string }
  | { readonly kind: 'user_edit'; readonly field: string }
  | { readonly kind: 'harness' }

export function parseDerivedFrom(value: string): DerivedFrom | null {
  if (value === 'harness') return { kind: 'harness' }
  if (value.startsWith('user_edit:')) {
    return { kind: 'user_edit', field: value.slice('user_edit:'.length) }
  }
  const match = /^(PROP_[A-Z0-9]+)\.([a-z][a-z0-9_]*)$/.exec(value)
  if (match === null) return null
  return { kind: 'proposal', proposalId: match[1] as string, fieldPath: match[2] as string }
}
