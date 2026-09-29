import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hashContractInput } from '../core/hash.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { dumpYaml, readYamlFile, writeYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import type { Blueprint } from '../schema/blueprint.ts'
import {
  GATE2_META_SCHEMA_VERSION,
  gate2ActionId,
  metaFileName,
  snapshotFileName,
  userEditId,
  validateGate2Meta,
  type Gate2Meta,
} from '../schema/gate2-meta.ts'
import type { Proposal, ProposalsFile } from '../schema/proposal.ts'
import type { SeedFile } from '../schema/seed.ts'
import { loadProposals, loadSeed } from '../project/project.ts'
import type { LLMProvider } from '../providers/types.ts'
import {
  BLUEPRINT_BUILDER_CONTRACT_ID,
  BLUEPRINT_BUILDER_CONTRACT_VERSION,
  BlueprintBuilderOutputError,
  Gate2PlanError,
  MERGEABLE_FIELDS,
  buildBlueprintBuilderInput,
  resolveFieldPlan,
  type FieldPlanInput,
  type MergeableField,
  type ResolvedFieldPlan,
} from './builder.ts'
import { assembleBlueprint, parseRawBlueprintOutput, type AssembleResult, type FieldProvenance } from './assemble.ts'

/**
 * Gate 2 服务（Story 4；需求规格 §5.2、§12；架构设计 §10、§12）。
 *
 * 流程：读取 seed + proposals → 解析字段计划 → 检查冲突是否已裁决 → 调 `blueprint_builder`
 *      → 装配（稳定 ID + 结构化 source_refs）→ 校验 → 写 blueprint.yaml
 *      → 写 history/blueprint-<NNN>.yaml 与 blueprint-history/<NNN>.meta.yaml（OQ-10）
 *
 * `blueprint_version` 每次 Gate 2 确认 +1（架构设计 §12）。
 */

export const GATE2_MODES = ['single', 'merge', 'manual'] as const

export class Gate2PreconditionError extends Error {
  override readonly name = 'Gate2PreconditionError'
  constructor(message: string) {
    super(message)
  }
}

export class Gate2ConflictPendingError extends Error {
  override readonly name = 'Gate2ConflictPendingError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(
      `存在未裁决的 USER_GIVEN 冲突，Gate 2 必须先处理（需求规格 §6.2 / §9.2）：\n- ${detail.join('\n- ')}`,
    )
    this.detail = detail
  }
}

export interface RunGate2Options {
  readonly paths: ProjectPaths
  readonly provider: LLMProvider
  /** `--from PROP_A`（单来源快捷方式）。 */
  readonly fromProposal?: string | undefined
  /** `--field <字段>=<来源>`（逐字段指定；与 --from 混用时覆盖）。 */
  readonly fields?: Readonly<Record<string, string>> | undefined
  /** `--edit <字段>=<内容>`（用户手写内容）。 */
  readonly edits?: Readonly<Record<string, string>> | undefined
  /** `--resolve CONF_001=kept_user`。 */
  readonly resolutions?: Readonly<Record<string, string>> | undefined
  readonly now?: Date | undefined
  /** 只读预览：完整构建但不写盘。 */
  readonly dryRun?: boolean | undefined
}

export interface Gate2RunResult {
  readonly blueprint: Blueprint
  readonly meta: Gate2Meta
  readonly provenance: readonly FieldProvenance[]
  readonly plan: ResolvedFieldPlan
  readonly userEdits: readonly { id: string; field: MergeableField; value: string }[]
  readonly conflictResolutions: readonly {
    id: string
    proposal_id: string
    seed_ref: string
    resolution: string
  }[]
  readonly rawOutput: string
  readonly prompt: string
  readonly inputSha256: string
  readonly provider: string
  readonly model: string
  readonly written: boolean
  readonly paths: {
    readonly blueprint: string
    readonly snapshot: string
    readonly meta: string
  }
}

/** 已知的 user_edit ID 集合（扫描既有 meta 文件）—— `source_refs.type=user_edit` 必须可解析（OQ-38）。 */
export function collectKnownUserEditIds(paths: ProjectPaths): string[] {
  return collectMetaFiles(paths).flatMap((meta) => meta.user_edits.map((edit) => edit.id))
}

export function collectKnownGate2ActionIds(paths: ProjectPaths): string[] {
  return collectMetaFiles(paths).map((meta) => meta.gate2_action_id)
}

export function collectMetaFiles(paths: ProjectPaths): Gate2Meta[] {
  if (!existsSync(paths.blueprintHistoryDir)) return []
  return readdirSync(paths.blueprintHistoryDir)
    .filter((name) => name.endsWith('.meta.yaml'))
    .sort()
    .map((name) => validateGate2Meta(readYamlFile(join(paths.blueprintHistoryDir, name))))
}

/** 下一个 blueprint_version = 现有快照 / meta 的最大编号 + 1。 */
export function nextBlueprintVersion(paths: ProjectPaths): number {
  const versions = new Set<number>()
  if (existsSync(paths.historyDir)) {
    for (const name of readdirSync(paths.historyDir)) {
      const match = /^blueprint-(\d{3})\.yaml$/.exec(name)
      if (match !== null) versions.add(Number(match[1]))
    }
  }
  for (const meta of collectMetaFiles(paths)) {
    versions.add(meta.blueprint_version)
  }
  if (existsSync(paths.blueprint)) versions.add(0)
  return versions.size === 0 ? 1 : Math.max(...versions) + 1
}

/** 跨版本全局递增的 EDIT 编号（OQ-38 / 解读 I-29）。 */
export function nextUserEditSequence(paths: ProjectPaths): number {
  const ids = collectKnownUserEditIds(paths)
  if (ids.length === 0) return 1
  return Math.max(...ids.map((id) => Number(id.replace(/^EDIT_/, '')))) + 1
}

function validateConflicts(
  proposals: ProposalsFile,
  participatingProposalIds: readonly string[],
  resolutions: Readonly<Record<string, string>>,
): { id: string; proposal_id: string; seed_ref: string; resolution: string }[] {
  const records: { id: string; proposal_id: string; seed_ref: string; resolution: string }[] = []
  const pending: string[] = []

  const participating = proposals.proposals.filter((proposal) =>
    participatingProposalIds.includes(proposal.proposal_id),
  )
  const allConflicts = new Map<string, { proposal: Proposal; index: number }>()
  for (const proposal of participating) {
    proposal.conflicts.forEach((conflict, index) => {
      allConflicts.set(`${proposal.proposal_id}:${conflict.id}`, { proposal, index })
    })
  }

  for (const [key, resolution] of Object.entries(resolutions)) {
    if (!/^(PROP_[A-Z0-9]+):(CONF_\d{3})$/.test(key)) {
      throw new Gate2PlanError(
        `--resolve 的键必须形如 PROP_A:CONF_001（需求规格 §9.2 的冲突记录带来源提案）`,
        Object.keys(resolutions),
      )
    }
    if (!allConflicts.has(key)) {
      throw new Gate2PlanError(`--resolve 指向的冲突不存在于本次参与的提案中：${key}`, [...allConflicts.keys()])
    }
    if (resolution !== undefined) {
      const allowed = ['pending', 'kept_user', 'changed_user', 'dropped']
      if (!allowed.includes(resolution)) {
        throw new Gate2PlanError(`--resolve ${key}=${resolution} 非法：只能是 ${allowed.join(' / ')}`)
      }
    }
  }

  for (const [key, entry] of allConflicts) {
    const [proposalId, conflictId] = key.split(':') as [string, string]
    const declared = resolutions[key] ?? entry.proposal.conflicts[entry.index]?.resolution ?? 'pending'
    if (declared === 'pending') {
      pending.push(
        `${proposalId}:${conflictId}（${entry.proposal.conflicts[entry.index]?.seed_ref} 的 ${entry.proposal.conflicts[entry.index]?.proposal_field}）`,
      )
      continue
    }
    records.push({
      id: conflictId,
      proposal_id: proposalId,
      seed_ref: entry.proposal.conflicts[entry.index]?.seed_ref as string,
      resolution: declared,
    })
  }

  if (pending.length > 0) {
    throw new Gate2ConflictPendingError(
      pending.map((item) => `${item}：请用 --resolve PROP_A:CONF_001=kept_user|changed_user|dropped 裁决`),
    )
  }
  return records
}

function seedAnchorsOf(seed: SeedFile): { id: string; value: string }[] {
  const byId = new Map<string, string>()
  for (const item of seed.story_seed.fixed_by_user) byId.set(item.id, item.value)
  for (const item of seed.story_seed.ambiguous) byId.set(item.id, item.value)
  return seed.story_seed.raw_seed_anchor_ids
    .filter((anchorId) => byId.has(anchorId))
    .map((anchorId) => ({ id: anchorId, value: byId.get(anchorId) as string }))
}

export async function runGate2(options: RunGate2Options): Promise<Gate2RunResult> {
  const { paths } = options
  if (!existsSync(paths.seed)) {
    throw new Gate2PreconditionError(`找不到 ${paths.seed}；请先建立项目并完成 Story 1–3`)
  }
  const seed = loadSeed(paths)
  if (seed.story_seed.gate1_status === 'pending') {
    throw new Gate2PreconditionError('Gate 1 尚未完成（gate1_status=pending）：请先执行 harness gate1')
  }
  if (!existsSync(paths.proposals)) {
    throw new Gate2PreconditionError(`找不到 ${paths.proposals}；请先执行 harness develop`)
  }
  const proposals = loadProposals(paths)

  const edits: Readonly<Record<string, string>> = options.edits ?? {}
  for (const field of Object.keys(edits)) {
    if (!(MERGEABLE_FIELDS as readonly string[]).includes(field)) {
      throw new Gate2PlanError(`--edit 出现未知字段 "${field}"；可指定字段：${MERGEABLE_FIELDS.join(' / ')}`)
    }
  }

  // 手改字段自动视为以 user 为来源（用户可以只写 --edit 而不再写 --field）
  const explicitFields: Record<string, string> = { ...(options.fields ?? {}) }
  for (const field of Object.keys(edits)) {
    explicitFields[field] = 'user'
  }

  const planInput: FieldPlanInput = {
    fromProposal: options.fromProposal,
    fields: explicitFields,
    proposals,
  }
  const plan = resolveFieldPlan(planInput)

  for (const field of plan.userFields) {
    if (edits[field] === undefined || (edits[field] as string).trim() === '') {
      throw new Gate2PlanError(
        `字段 "${field}" 被指定为 user 来源，但没有提供内容；请使用 --edit ${field}=<内容>`,
      )
    }
  }

  const conflictResolutions = validateConflicts(proposals, plan.participatingProposalIds, options.resolutions ?? {})

  const blueprintVersion = nextBlueprintVersion(paths)
  const actionId = gate2ActionId(blueprintVersion)
  const editSequenceStart = nextUserEditSequence(paths)
  const userEdits = plan.userFields.map((field, index) => ({
    id: userEditId(editSequenceStart + index),
    field,
    value: (edits[field] as string).trim(),
  }))

  const buildInputs = { plan, userEdits, conflictResolutions, gate2ActionId: actionId }
  const input = buildBlueprintBuilderInput(proposals, buildInputs)

  const contract = loadPromptContract(BLUEPRINT_BUILDER_CONTRACT_ID, BLUEPRINT_BUILDER_CONTRACT_VERSION)
  const prompt = renderPrompt(contract, {
    field_plan: dumpYaml(input.field_plan).trimEnd(),
    proposals: dumpYaml(input.proposals).trimEnd(),
    user_edits: dumpYaml(input.user_edits).trimEnd(),
    conflict_resolutions: dumpYaml(input.conflict_resolutions).trimEnd(),
  })

  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出符合约定的 YAML，不输出解释。',
    temperature: 0,
  })

  const raw = parseRawBlueprintOutput(response.text)
  const assembled: AssembleResult = assembleBlueprint(raw, {
    rawOutput: response.text,
    plan,
    proposals,
    userEdits,
    gate2ActionId: actionId,
    blueprintVersion,
    seedAnchors: seedAnchorsOf(seed),
  })

  const snapshotName = snapshotFileName(blueprintVersion)
  const metaName = metaFileName(blueprintVersion)
  const meta = validateGate2Meta({
    schema_version: GATE2_META_SCHEMA_VERSION,
    blueprint_version: blueprintVersion,
    gate2_action_id: actionId,
    created_at: (options.now ?? new Date()).toISOString(),
    mode: plan.mode,
    snapshot: snapshotName,
    source_proposal_ids: [...plan.participatingProposalIds],
    field_sources: plan.sources.map((source) => ({
      field: source.field,
      from: source.from,
      source_refs:
        assembled.provenance.find((entry) => entry.field === source.field)?.source_refs ?? [],
    })),
    user_edits: userEdits.map((edit) => ({ id: edit.id, field: edit.field, value: edit.value, source: 'user' as const })),
    conflict_resolutions: conflictResolutions,
  })

  const snapshotPath = join(paths.historyDir, snapshotName)
  const metaPath = join(paths.blueprintHistoryDir, metaName)
  const dryRun = options.dryRun ?? false

  if (!dryRun) {
    // 当前生效版本始终是 blueprint.yaml（需求规格 §12）
    writeYamlFile(paths.blueprint, assembled.blueprint)
    writeYamlFile(snapshotPath, assembled.blueprint)
    writeYamlFile(metaPath, meta)
  }

  return {
    blueprint: assembled.blueprint,
    meta,
    provenance: assembled.provenance,
    plan,
    userEdits,
    conflictResolutions,
    rawOutput: response.text,
    prompt,
    inputSha256: hashContractInput(contract.id, contract.version, input),
    provider: response.provider,
    model: response.model,
    written: !dryRun,
    paths: { blueprint: paths.blueprint, snapshot: snapshotPath, meta: metaPath },
  }
}

export { BlueprintBuilderOutputError, Gate2PlanError }
