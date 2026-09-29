import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { hashContractInput } from '../core/hash.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { extractYamlBlock } from '../interpreter/schema.ts'
import { dumpYaml } from '../io/yaml.ts'
import {
  checkProposalDistinctness,
  validateProposalsFile,
  type Proposal,
  type ProposalsFile,
} from '../schema/proposal.ts'
import type { SeedFile } from '../schema/seed.ts'
import type { LLMProvider } from '../providers/types.ts'

/**
 * Story Developer（Story 3；需求规格 §9；架构设计 §6）。
 *
 * 数据源（需求规格 §9「数据源」/ Story 3）：只读取
 *   seed.yaml + Gate 1 后的 Interpreter 结果 + 可选风格偏好。
 * 输出统一写入 `proposals.yaml`，不维护 `proposals.md`（Story 3 明文）。
 */

export const STORY_DEVELOPER_CONTRACT_ID = 'story_developer'
export const STORY_DEVELOPER_CONTRACT_VERSION = '0.1'

/** 模型原始输出：只要求候选内容，ID 由 Harness 规范化（I-13 / I-19）。 */
const rawProposalSchema = z.strictObject({
  title: z.string().min(1),
  genre: z.string().min(1),
  core_premise: z.string().min(1),
  core_conflict: z.string().min(1),
  truth_or_turn: z.string().min(1),
  character_arc: z.string().min(1),
  ending: z.string().min(1),
  pov: z.array(z.string().min(1)).min(1).max(2),
  target_length: z.number().int().positive(),
  tone: z.string().min(1),
  seed_fidelity: z.strictObject({
    preserved: z.array(
      z.strictObject({ seed_ref: z.string().min(1), value_in_proposal: z.string().min(1) }),
    ),
    altered: z.array(
      z.strictObject({
        seed_ref: z.string().min(1),
        original: z.string().min(1),
        changed_to: z.string().min(1),
      }),
    ),
    added: z.array(
      z.strictObject({
        id: z.string().min(1).optional(),
        value: z.string().min(1),
        status: z.literal('PROPOSED'),
        source: z.literal('harness'),
      }),
    ),
    risk: z.array(
      z.strictObject({
        id: z.string().min(1).optional(),
        value: z.string().min(1),
        related_addition_refs: z.array(z.string().min(1)),
      }),
    ),
  }),
  conflicts: z.array(
    z.strictObject({
      id: z.string().min(1).optional(),
      seed_ref: z.string().min(1),
      proposal_field: z.string().min(1),
      user_value: z.string().min(1),
      proposal_value: z.string().min(1),
      resolution: z.string().min(1),
    }),
  ),
})

const rawProposalsOutputSchema = z.strictObject({
  proposals: z.array(rawProposalSchema).min(2).max(3),
})

export class StoryDeveloperOutputError extends Error {
  override readonly name = 'StoryDeveloperOutputError'
  readonly detail: readonly string[]
  readonly rawOutput: string
  constructor(detail: readonly string[], rawOutput: string) {
    super(`Story Developer 输出不符合契约：\n- ${detail.join('\n- ')}`)
    this.detail = detail
    this.rawOutput = rawOutput
  }
}

export interface DeveloperNotice {
  readonly code: 'DISTINCTNESS' | 'SEED_REF_UNACCOUNTED' | 'SEED_REF_NOT_ANCHOR' | 'EMPTY_DENOMINATOR' | 'CONFLICT_PENDING'
  readonly message: string
}

export interface DeveloperResult {
  readonly contract: string
  readonly contractVersion: string
  readonly provider: string
  readonly model: string
  readonly inputSha256: string
  readonly prompt: string
  readonly rawOutput: string
  readonly file: ProposalsFile
  readonly notices: readonly DeveloperNotice[]
}

export interface RunStoryDeveloperOptions {
  readonly provider: LLMProvider
  readonly seed: SeedFile
  readonly stylePreference?: string | undefined
}

function pad3(index: number): string {
  return String(index + 1).padStart(3, '0')
}

/**
 * ID 规范化（I-13 / I-19）：无论模型写了什么 id，Harness 一律按数组顺序重新编号，
 * 并把 `risk.related_addition_refs` 通过"模型原 id → 规范 id"的映射重写。
 * 无法解析的引用视为契约违规（要求模型把引用写对，而不是让 Harness 猜）。
 */
function canonicalizeProposalIds(raw: z.infer<typeof rawProposalSchema>, proposalId: string): Proposal {
  const addedIdMap = new Map<string, string>()
  raw.seed_fidelity.added.forEach((entry, index) => {
    if (entry.id !== undefined) addedIdMap.set(entry.id, `ADD_${pad3(index)}`)
  })

  const resolveAdditionRef = (ref: string): string => {
    const mapped = addedIdMap.get(ref)
    if (mapped !== undefined) return mapped
    // 模型可能已经直接写了规范 id（ADD_001 且顺序一致）
    if (ID_PATTERNS.proposalAddition.test(ref)) {
      const index = Number(ref.slice(4)) - 1
      if (index >= 0 && index < raw.seed_fidelity.added.length) return `ADD_${pad3(index)}`
    }
    throw new StoryDeveloperOutputError(
      [`${proposalId} 的 risk.related_addition_refs 引用了无法解析的新增项 "${ref}"（需求规格 §9.1）`],
      '',
    )
  }

  const canonical: Record<string, unknown> = {
    proposal_id: proposalId,
    title: raw.title,
    genre: raw.genre,
    core_premise: raw.core_premise,
    core_conflict: raw.core_conflict,
    truth_or_turn: raw.truth_or_turn,
    character_arc: raw.character_arc,
    ending: raw.ending,
    pov: raw.pov,
    target_length: raw.target_length,
    tone: raw.tone,
    seed_fidelity: {
      preserved: raw.seed_fidelity.preserved,
      altered: raw.seed_fidelity.altered,
      added: raw.seed_fidelity.added.map((entry, index) => ({
        id: `ADD_${pad3(index)}`,
        value: entry.value,
        status: entry.status,
        source: entry.source,
      })),
      risk: raw.seed_fidelity.risk.map((entry, index) => ({
        id: `RISK_${pad3(index)}`,
        value: entry.value,
        related_addition_refs: entry.related_addition_refs.map(resolveAdditionRef),
      })),
    },
    conflicts: raw.conflicts.map((entry, index) => ({
      id: `CONF_${pad3(index)}`,
      seed_ref: entry.seed_ref,
      proposal_field: entry.proposal_field,
      user_value: entry.user_value,
      proposal_value: entry.proposal_value,
      resolution: entry.resolution,
    })),
  }
  return canonical as unknown as Proposal
}

const PROPOSAL_IDS = ['PROP_A', 'PROP_B', 'PROP_C'] as const

/**
 * 构造 Prompt Contract 的结构化输入。
 *
 * 这个函数同时决定 recorded fixture 的查找键，因此导出供工具链（fixture 生成）复用，
 * 保证"生成 fixture 时的输入"与"运行时的输入"逐字段一致。
 */
export function buildDeveloperInput(
  seed: SeedFile,
  stylePreference?: string | undefined,
): Readonly<Record<string, unknown>> {
  const storySeed = seed.story_seed
  return {
    raw_input: storySeed.raw_input,
    gate1_status: storySeed.gate1_status,
    raw_seed_anchor_ids: [...storySeed.raw_seed_anchor_ids],
    fixed_by_user: storySeed.fixed_by_user.map((item) => ({ id: item.id, value: item.value })),
    ambiguous: storySeed.ambiguous.map((item) => ({ id: item.id, value: item.value })),
    open_questions: storySeed.open_questions.map((item) => ({ id: item.id, value: item.value })),
    style_preference: stylePreference ?? '',
  }
}

export async function runStoryDeveloper(options: RunStoryDeveloperOptions): Promise<DeveloperResult> {
  const { seed } = options
  const contract = loadPromptContract(STORY_DEVELOPER_CONTRACT_ID, STORY_DEVELOPER_CONTRACT_VERSION)
  const storySeed = seed.story_seed

  const input = buildDeveloperInput(seed, options.stylePreference)

  const prompt = renderPrompt(contract, {
    raw_input: storySeed.raw_input,
    gate1_status: storySeed.gate1_status,
    raw_seed_anchor_ids: storySeed.raw_seed_anchor_ids.join(', ') || '（无）',
    fixed_by_user: dumpYaml(input.fixed_by_user).trimEnd(),
    ambiguous: dumpYaml(input.ambiguous).trimEnd(),
    open_questions: dumpYaml(input.open_questions).trimEnd(),
    style_preference: options.stylePreference ?? '（无）',
  })

  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出符合约定的 YAML，不输出解释。',
    temperature: 0,
  })

  const parsedRaw = parseDeveloperOutput(response.text)
  const canonicalProposals = parsedRaw.proposals.map((raw, index) =>
    canonicalizeProposalIds(raw, PROPOSAL_IDS[index] as string),
  )

  const file = validateProposalsFile({
    schema_version: '0.1',
    proposals: canonicalProposals,
  })

  assertSeedRefsResolvable(file, seed)
  const notices = collectNotices(file, storySeed.raw_seed_anchor_ids)

  return {
    contract: contract.id,
    contractVersion: contract.version,
    provider: response.provider,
    model: response.model,
    inputSha256: hashContractInput(contract.id, contract.version, input),
    prompt,
    rawOutput: response.text,
    file,
    notices,
  }
}

export class UnresolvableSeedRefError extends Error {
  override readonly name = 'UnresolvableSeedRefError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`Proposal 引用了不存在的 Seed item：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

/**
 * 需求规格 §7.2 / §9.1："引用必须可解析"。
 * 这里校验 `seed_ref` 真实存在于当前 `seed.yaml` 的 fixed_by_user ∪ ambiguous。
 */
export function assertSeedRefsResolvable(file: ProposalsFile, seed: SeedFile): void {
  const liveIds = new Set<string>([
    ...seed.story_seed.fixed_by_user.map((item) => item.id),
    ...seed.story_seed.ambiguous.map((item) => item.id),
  ])
  const problems: string[] = []
  for (const proposal of file.proposals) {
    const refs = [
      ...proposal.seed_fidelity.preserved.map((entry) => entry.seed_ref),
      ...proposal.seed_fidelity.altered.map((entry) => entry.seed_ref),
      ...proposal.conflicts.map((conflict) => conflict.seed_ref),
    ]
    for (const ref of refs) {
      if (!liveIds.has(ref)) {
        problems.push(`${proposal.proposal_id} 引用了 seed.yaml 中不存在的 Seed item：${ref}`)
      }
    }
  }
  if (problems.length > 0) {
    throw new UnresolvableSeedRefError(problems)
  }
}

function parseDeveloperOutput(rawOutput: string): z.infer<typeof rawProposalsOutputSchema> {
  let parsed: unknown
  try {
    parsed = parseYaml(extractYamlBlock(rawOutput))
  } catch (error) {
    throw new StoryDeveloperOutputError([`YAML 解析失败：${(error as Error).message}`], rawOutput)
  }
  const result = rawProposalsOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new StoryDeveloperOutputError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      rawOutput,
    )
  }
  return result.data
}

/**
 * 语义检查（需求规格 §10.2 / §9.4；用户裁决第 1 项）：
 * - 每个 seed_ref 必须真实存在于 seed.yaml 的 fixed_by_user ∪ ambiguous，否则报错（"必须可解析"）；
 * - 每个原始锚点都必须被 preserved / altered / conflicts 明确处置，否则 warning；
 * - 分裂度不足、冲突待裁决同样以 notice 形式呈现（不阻塞，§28）。
 */
function collectNotices(file: ProposalsFile, rawSeedAnchorIds: readonly string[]): DeveloperNotice[] {
  const notices: DeveloperNotice[] = []
  const anchorSet = new Set(rawSeedAnchorIds)

  for (const warning of checkProposalDistinctness(file.proposals).warnings) {
    notices.push({ code: 'DISTINCTNESS', message: warning })
  }

  for (const proposal of file.proposals) {
    const mentioned = new Set<string>()
    for (const entry of proposal.seed_fidelity.preserved) mentioned.add(entry.seed_ref)
    for (const entry of proposal.seed_fidelity.altered) mentioned.add(entry.seed_ref)
    for (const conflict of proposal.conflicts) mentioned.add(conflict.seed_ref)

    for (const anchorId of rawSeedAnchorIds) {
      if (!mentioned.has(anchorId)) {
        notices.push({
          code: 'SEED_REF_UNACCOUNTED',
          message: `${proposal.proposal_id} 未对核心锚点 ${anchorId} 做任何处置（preserved / altered / conflicts 都没有），该锚点不计入 Seed Preservation Rate 分子`,
        })
      }
    }
    for (const ref of mentioned) {
      if (!anchorSet.has(ref)) {
        notices.push({
          code: 'SEED_REF_NOT_ANCHOR',
          message: `${proposal.proposal_id} 引用了不属于 raw_seed_anchor_ids 的 Seed item ${ref}（Gate 1 提升项）：作为额外约束记录，不参与分子分母（需求规格 §10.2）`,
        })
      }
    }
    for (const conflict of proposal.conflicts) {
      if (conflict.resolution === 'pending') {
        notices.push({
          code: 'CONFLICT_PENDING',
          message: `${proposal.proposal_id} 的 ${conflict.id} 与用户已明确内容冲突（${conflict.seed_ref}.${conflict.proposal_field}），等待 Gate 2 裁决（需求规格 §9.2）`,
        })
      }
    }
  }

  if (rawSeedAnchorIds.length === 0) {
    notices.push({
      code: 'EMPTY_DENOMINATOR',
      message: 'raw_seed_anchor_ids 为空：Seed Preservation Rate 记为 null',
    })
  }
  return notices
}
