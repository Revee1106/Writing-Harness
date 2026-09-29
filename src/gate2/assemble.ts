import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { parseProposalFieldPath } from '../core/proposal-field-paths.ts'
import type { SourceRef } from '../core/source-ref.ts'
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
import type { ProposalsFile } from '../schema/proposal.ts'
import { extractYamlBlock } from '../interpreter/schema.ts'
import {
  BlueprintBuilderOutputError,
  MERGEABLE_FIELDS,
  parseDerivedFrom,
  type MergeableField,
  type ResolvedFieldPlan,
} from './builder.ts'

/**
 * Blueprint 装配（Story 4）。
 *
 * 输入：`blueprint_builder` 的原始输出（内容 + `derived_from`）
 * 输出：通过 `validateBlueprint()` 的、带稳定 ID 与结构化 `source_refs` 的 Blueprint。
 */

const derivedFromStringSchema = z.string().min(1)

const rawValueItemSchema = z.strictObject({
  value: z.string().min(1),
  derived_from: derivedFromStringSchema,
})

const rawCharacterSchema = z.strictObject({
  id: z.string().regex(/^CH_[A-Z0-9_]+$/, 'character id 必须形如 CH_LIN_YU'),
  name: z.string().min(1),
  role: z.string().min(1),
  desire: z.string().min(1),
  fear: z.string().min(1),
  contradiction: z.string().min(1),
  voice_hint: z.string().min(1),
  /** §11.3：单 POV 可省略（Harness 默认填入）；双 POV 必须显式。 */
  inner_state_pov_visible: z.array(z.string().min(1)).optional(),
  observable_behavior_hints: z.array(
    z.strictObject({
      value: z.string().min(1),
      applicable_scene_types: z.array(z.string().min(1)).min(1),
      derived_from: derivedFromStringSchema,
    }),
  ),
  relationships: z.array(
    z.strictObject({
      target: z.string().regex(/^CH_[A-Z0-9_]+$/, 'relationship.target 必须是 CH_* 角色 ID'),
      kind: z.string().min(1),
      state: z.string().min(1),
      since_ref: z.string().min(1),
      derived_from: derivedFromStringSchema,
    }),
  ),
  derived_from: derivedFromStringSchema,
})

const rawKeyKnowledgeSchema = z.strictObject({
  truth: z.string().min(1),
  truth_status: z.literal('CONFIRMED').optional(),
  known_by: z.record(z.string().min(1), z.boolean()),
  reader_knows: z.boolean(),
  reveal_at_structure: z.string().min(1),
  reveal_order: z.number().int().min(1),
  reveal_to: z.array(z.string().min(1)),
  reveal_to_reader: z.boolean(),
  derived_from: derivedFromStringSchema,
})

const rawForeshadowingSchema = z.strictObject({
  value: z.string().min(1),
  setup_at_structure: z.string().min(1),
  setup_order: z.number().int().min(1),
  payoff_at_structure: z.string().min(1),
  payoff_order: z.number().int().min(1),
  derived_from: derivedFromStringSchema,
})

export const rawBlueprintOutputSchema = z.strictObject({
  meta: z.strictObject({
    title: z.string().min(1),
    genre: z.string().min(1),
    pov: z.array(z.string().min(1)).min(1).max(2),
    target_length: z.number().int().positive(),
  }),
  premise: rawValueItemSchema,
  theme: z.strictObject({
    primary: rawValueItemSchema,
    secondary: z.array(rawValueItemSchema),
  }),
  characters: z.array(rawCharacterSchema).min(1),
  core_conflict: rawValueItemSchema,
  arc: z.strictObject({ start: rawValueItemSchema, shift: rawValueItemSchema, end: rawValueItemSchema }),
  structure: z.strictObject({
    beginning: rawValueItemSchema,
    development: rawValueItemSchema,
    turning_point: rawValueItemSchema,
    climax: rawValueItemSchema,
    ending: rawValueItemSchema,
  }),
  key_knowledge: z.array(rawKeyKnowledgeSchema),
  foreshadowing: z.array(rawForeshadowingSchema),
  style_direction: z.strictObject({
    narration: z.string().min(1),
    dialogue: z.string().min(1),
    rhythm: z.string().min(1),
    derived_from: derivedFromStringSchema,
  }),
})
export type RawBlueprintOutput = z.infer<typeof rawBlueprintOutputSchema>

export interface UserEditInput {
  readonly id: string
  readonly field: MergeableField
  readonly value: string
}

export interface AssembleContext {
  readonly rawOutput: string
  readonly plan: ResolvedFieldPlan
  readonly proposals: ProposalsFile
  readonly userEdits: readonly UserEditInput[]
  readonly gate2ActionId: string
  readonly blueprintVersion: number
  /** 仅 manual 模式使用：Seed 中现存的原始锚点（用于构造 seed_fidelity.preserved）。 */
  readonly seedAnchors: readonly { readonly id: string; readonly value: string }[]
}

export interface FieldProvenance {
  readonly field: MergeableField
  readonly from: string
  readonly source_refs: readonly SourceRef[]
}

export interface AssembleResult {
  readonly blueprint: Blueprint
  readonly provenance: readonly FieldProvenance[]
}

function characterSuffix(characterId: string): string {
  return characterId.replace(/^CH_/, '')
}

export function parseRawBlueprintOutput(rawOutput: string): RawBlueprintOutput {
  let parsed: unknown
  try {
    parsed = parseYaml(extractYamlBlock(rawOutput))
  } catch (error) {
    throw new BlueprintBuilderOutputError([`YAML 解析失败：${(error as Error).message}`], rawOutput)
  }
  const result = rawBlueprintOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new BlueprintBuilderOutputError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      rawOutput,
    )
  }
  return result.data
}

/** 合并被选中 Proposal 的 seed_fidelity（OQ-01：Blueprint 顶层保留同一结构）。 */
export function mergeSeedFidelity(
  proposals: ProposalsFile,
  participatingProposalIds: readonly string[],
  seedAnchors: readonly { readonly id: string; readonly value: string }[],
): Blueprint['seed_fidelity'] {
  const participating = proposals.proposals.filter((proposal) =>
    participatingProposalIds.includes(proposal.proposal_id),
  )

  if (participating.length === 0) {
    // manual 模式（用户完全手写，没有参与提案）：锚点由 Seed 直接给出，其余为空。
    return {
      preserved: seedAnchors.map((anchor) => ({
        seed_ref: anchor.id,
        value_in_proposal: anchor.value,
      })),
      altered: [],
      added: [],
      risk: [],
    }
  }

  const preserved: Blueprint['seed_fidelity']['preserved'] = []
  const altered: Blueprint['seed_fidelity']['altered'] = []
  const added: Blueprint['seed_fidelity']['added'] = []
  const riskRaw: { value: string; refs: string[] }[] = []
  const seenPreserved = new Set<string>()
  const seenAltered = new Set<string>()
  const seenAddedValues = new Set<string>()

  for (const proposal of participating) {
    // 该提案的 ADD 原 ID → Blueprint 级新 ID（保持 risk 引用可解析）
    const addedIdMap = new Map<string, string>()
    for (const entry of proposal.seed_fidelity.added) {
      if (seenAddedValues.has(entry.value)) {
        addedIdMap.set(entry.id, `ADD_${String(added.length).padStart(3, '0')}`)
        continue
      }
      seenAddedValues.add(entry.value)
      const newId = `ADD_${String(added.length + 1).padStart(3, '0')}`
      addedIdMap.set(entry.id, newId)
      added.push({ id: newId, value: entry.value, status: 'PROPOSED', source: 'harness' })
    }
    for (const entry of proposal.seed_fidelity.preserved) {
      if (seenPreserved.has(entry.seed_ref)) continue
      seenPreserved.add(entry.seed_ref)
      preserved.push({ seed_ref: entry.seed_ref, value_in_proposal: entry.value_in_proposal })
    }
    for (const entry of proposal.seed_fidelity.altered) {
      if (seenAltered.has(entry.seed_ref)) continue
      seenAltered.add(entry.seed_ref)
      altered.push({ seed_ref: entry.seed_ref, original: entry.original, changed_to: entry.changed_to })
    }
    for (const entry of proposal.seed_fidelity.risk) {
      riskRaw.push({
        value: entry.value,
        refs: entry.related_addition_refs
          .map((ref) => addedIdMap.get(ref))
          .filter((ref): ref is string => ref !== undefined),
      })
    }
  }

  const risk: Blueprint['seed_fidelity']['risk'] = riskRaw.map((entry, index) => ({
    id: `RISK_${String(index + 1).padStart(3, '0')}`,
    value: entry.value,
    related_addition_refs: entry.refs,
  }))

  return { preserved, altered, added, risk }
}

function resolveProposalRef(proposalId: string, fieldPath: string, context: AssembleContext, field: MergeableField): SourceRef {
  const refId = `${proposalId}.${fieldPath}`
  if (parseProposalFieldPath(refId) === null) {
    throw new BlueprintBuilderOutputError(
      [`${field} 的 derived_from="${refId}" 不在 proposal 字段路径白名单内（需求规格 §9.3 / OQ-31）`],
      context.rawOutput,
    )
  }
  return { type: 'proposal', ref_id: refId }
}

/**
 * 把 `derived_from` 转成结构化 `source_refs`。
 *
 * 规则（解读 I-32，落实用户裁决"每个字段必须带 source_refs"）：
 * - `harness` → `{type: blueprint_gate2, ref_id: GATE2_<NNN>}`（本次 Gate 2 动作产生）；
 * - `user_edit:<field>` → `{type: user_edit, ref_id: EDIT_<NNN>}`（用户必须确实改过该字段）；
 * - `<提案>.<字段>` → `{type: proposal, ref_id: ...}`，且该提案必须是该字段字段计划里指定的来源
 *   （或该字段由用户手写时，允许引用参与提案作为辅助来源）；引用其它提案会被拒绝，
 *   避免"逐字段指定的来源"被静默替换。
 */
function resolveSourceRefs(
  derivedFrom: string,
  field: MergeableField,
  context: AssembleContext,
): SourceRef {
  const derived = parseDerivedFrom(derivedFrom)
  if (derived === null) {
    throw new BlueprintBuilderOutputError(
      [`${field} 的 derived_from="${derivedFrom}" 形态非法（只能是 <提案>.<字段> / user_edit:<字段> / harness）`],
      context.rawOutput,
    )
  }
  if (derived.kind === 'harness') {
    return { type: 'blueprint_gate2', ref_id: context.gate2ActionId }
  }
  if (derived.kind === 'user_edit') {
    const edit = context.userEdits.find((candidate) => candidate.field === derived.field)
    if (edit === undefined) {
      throw new BlueprintBuilderOutputError(
        [`${field} 声明 derived_from=user_edit:${derived.field}，但用户并没有手改该字段`],
        context.rawOutput,
      )
    }
    return { type: 'user_edit', ref_id: edit.id }
  }

  const planSource = context.plan.sources.find((source) => source.field === field)?.from
  if (planSource === 'user') {
    // 用户手写该字段：允许引用参与提案作为辅助溯源，但必须是参与提案
    if (!context.plan.participatingProposalIds.includes(derived.proposalId)) {
      throw new BlueprintBuilderOutputError(
        [`${field} 引用了未参与本次 Gate 2 的提案 ${derived.proposalId}`],
        context.rawOutput,
      )
    }
    return resolveProposalRef(derived.proposalId, derived.fieldPath, context, field)
  }
  if (planSource !== derived.proposalId) {
    throw new BlueprintBuilderOutputError(
      [
        `${field} 的字段计划来源是 ${String(planSource)}，但输出声明 derived_from=${derivedFrom}；Gate 2 不允许静默换源（用户裁决：逐字段指定来源）`,
      ],
      context.rawOutput,
    )
  }
  return resolveProposalRef(derived.proposalId, derived.fieldPath, context, field)
}

export function assembleBlueprint(raw: RawBlueprintOutput, context: AssembleContext): AssembleResult {
  /**
   * 字段级来源登记（用户裁决：合并产物**每个字段**必须带 source_refs）。
   * 每个 Blueprint 字段的 refs 由该字段下所有可引用项的 `derived_from` 汇总而来，
   * 因此像 characters / arc / structure 这类"多条目字段"也会有非空 refs。
   */
  const fieldRefs = new Map<MergeableField, SourceRef[]>()
  const register = (field: MergeableField, ref: SourceRef): SourceRef => {
    const list = fieldRefs.get(field) ?? []
    if (!list.some((existing) => existing.type === ref.type && existing.ref_id === ref.ref_id)) {
      list.push(ref)
      fieldRefs.set(field, list)
    }
    return ref
  }
  const resolveAndRegister = (field: MergeableField, derivedFrom: string): SourceRef =>
    register(field, resolveSourceRefs(derivedFrom, field, context))

  const povIds = raw.meta.pov
  const singlePov = povIds.length === 1
  const povDefault = povIds[0] as string

  const characters = raw.characters.map((character) => {
    const suffix = characterSuffix(character.id)
    // 解读 I-34：单 POV 默认规则 —— POV 角色自身可见 [self]，非 POV 角色为 []（物理隔离，架构设计 §21）；
    // 双 POV 必须由 Blueprint Builder 显式给出。
    const innerVisible =
      character.inner_state_pov_visible !== undefined && character.inner_state_pov_visible.length > 0
        ? character.inner_state_pov_visible
        : singlePov
          ? character.id === povDefault
            ? [povDefault]
            : []
          : undefined
    if (innerVisible === undefined) {
      throw new BlueprintBuilderOutputError(
        [
          `双 POV 必须显式声明 inner_state_pov_visible（角色 ${character.id} 缺失）；单 POV 才允许由 Builder 默认填入（需求规格 §11.3）`,
        ],
        context.rawOutput,
      )
    }
    const hintIds = new Set<string>()
    const relationshipIds = new Set<string>()
    return {
      id: character.id,
      name: character.name,
      role: character.role,
      desire: character.desire,
      fear: character.fear,
      contradiction: character.contradiction,
      voice_hint: character.voice_hint,
      inner_state_pov_visible: innerVisible,
      observable_behavior_hints: character.observable_behavior_hints.map((hint, index) => {
        let id = `OBH_${suffix}_${String(index + 1).padStart(2, '0')}`
        while (hintIds.has(id)) id = `${id}_2`
        hintIds.add(id)
        return {
          id,
          value: hint.value,
          applicable_scene_types: hint.applicable_scene_types,
        }
      }),
      relationships: character.relationships.map((relationship) => {
        let id = `REL_${suffix}_${characterSuffix(relationship.target)}`
        while (relationshipIds.has(id)) id = `${id}_2`
        relationshipIds.add(id)
        return {
          id,
          target: relationship.target,
          kind: relationship.kind,
          state: relationship.state,
          since_ref: relationship.since_ref,
          source_refs: [resolveAndRegister('characters', relationship.derived_from)],
        }
      }),
      source_refs: [resolveAndRegister('characters', character.derived_from)],
    }
  })

  const blueprint: Blueprint = {
    schema_version: BLUEPRINT_SCHEMA_VERSION,
    blueprint_version: context.blueprintVersion,
    meta: {
      title: raw.meta.title,
      genre: raw.meta.genre,
      pov: raw.meta.pov,
      target_length: raw.meta.target_length,
    },
    premise: {
      id: PREMISE_ID,
      value: raw.premise.value,
      status: 'CONFIRMED',
      source_refs: [resolveAndRegister('premise', raw.premise.derived_from)],
    },
    theme: {
      primary: {
        id: 'BP_THEME_01',
        value: raw.theme.primary.value,
        source_refs: [resolveAndRegister('theme', raw.theme.primary.derived_from)],
      },
      secondary: raw.theme.secondary.map((item, index) => ({
        id: `BP_THEME_${String(index + 2).padStart(2, '0')}`,
        value: item.value,
        source_refs: [resolveAndRegister('theme', item.derived_from)],
      })),
    },
    characters,
    core_conflict: {
      id: CORE_CONFLICT_ID,
      value: raw.core_conflict.value,
      source_refs: [resolveAndRegister('core_conflict', raw.core_conflict.derived_from)],
    },
    arc: {
      start: {
        id: ARC_IDS.start,
        value: raw.arc.start.value,
        source_refs: [resolveAndRegister('arc', raw.arc.start.derived_from)],
      },
      shift: {
        id: ARC_IDS.shift,
        value: raw.arc.shift.value,
        source_refs: [resolveAndRegister('arc', raw.arc.shift.derived_from)],
      },
      end: {
        id: ARC_IDS.end,
        value: raw.arc.end.value,
        source_refs: [resolveAndRegister('arc', raw.arc.end.derived_from)],
      },
    },
    structure: Object.fromEntries(
      STRUCTURE_KEYS.map((key) => [
        key,
        {
          id: STRUCTURE_IDS[key],
          value: raw.structure[key].value,
          source_refs: [resolveAndRegister('structure', raw.structure[key].derived_from)],
        },
      ]),
    ) as Blueprint['structure'],
    key_knowledge: raw.key_knowledge.map((item, index) => ({
      id: `K${String(index + 1).padStart(3, '0')}`,
      truth: item.truth,
      truth_status: 'CONFIRMED' as const,
      known_by: item.known_by,
      reader_knows: item.reader_knows,
      reveal_at_structure: item.reveal_at_structure,
      reveal_order: item.reveal_order,
      reveal_to: item.reveal_to,
      reveal_to_reader: item.reveal_to_reader,
      source_refs: [resolveAndRegister('key_knowledge', item.derived_from)],
    })),
    foreshadowing: raw.foreshadowing.map((item, index) => ({
      id: `BP_FS_${String(index + 1).padStart(3, '0')}`,
      value: item.value,
      setup_at_structure: item.setup_at_structure,
      setup_order: item.setup_order,
      payoff_at_structure: item.payoff_at_structure,
      payoff_order: item.payoff_order,
      source_refs: [resolveAndRegister('foreshadowing', item.derived_from)],
    })),
    style_direction: {
      id: STYLE_DIRECTION_ID,
      narration: raw.style_direction.narration,
      dialogue: raw.style_direction.dialogue,
      rhythm: raw.style_direction.rhythm,
      source_refs: [resolveAndRegister('style_direction', raw.style_direction.derived_from)],
    },
    seed_fidelity: mergeSeedFidelity(
      context.proposals,
      context.plan.participatingProposalIds,
      context.seedAnchors,
    ),
  }

  // meta 字段的溯源（title / genre / pov / target_length）：内容来自来源提案或用户手写，无 derived_from。
  for (const field of ['title', 'genre', 'pov', 'target_length'] as const) {
    const source = context.plan.sources.find((candidate) => candidate.field === field)
    if (source === undefined) continue
    if (source.from === 'user') {
      const edit = context.userEdits.find((candidate) => candidate.field === field)
      register(
        field,
        edit === undefined
          ? { type: 'blueprint_gate2', ref_id: context.gate2ActionId }
          : { type: 'user_edit', ref_id: edit.id },
      )
    } else {
      register(field, resolveProposalRef(source.from, FIELD_PATH_FOR_META[field], context, field))
    }
  }

  const validated = validateBlueprint(blueprint)

  // 用户裁决：合并产物**每个字段**都必须带 source_refs —— 缺失即视为装配缺陷。
  const provenance: FieldProvenance[] = MERGEABLE_FIELDS.map((field) => ({
    field,
    from: context.plan.sources.find((source) => source.field === field)?.from ?? 'harness',
    source_refs: fieldRefs.get(field) ?? [],
  }))
  const missing = provenance.filter((entry) => entry.source_refs.length === 0)
  if (missing.length > 0) {
    throw new BlueprintBuilderOutputError(
      [
        `以下字段没有任何 source_refs：${missing.map((entry) => entry.field).join(' / ')}；Gate 2 要求每个字段都可溯源到 Proposal 字段路径或 user_edit（用户裁决）`,
      ],
      context.rawOutput,
    )
  }

  return { blueprint: validated, provenance: deepFreeze(provenance) as readonly FieldProvenance[] }
}

const FIELD_PATH_FOR_META: Record<'title' | 'genre' | 'pov' | 'target_length', string> = {
  title: 'title',
  genre: 'genre',
  pov: 'pov',
  target_length: 'target_length',
}

export { BlueprintBuilderOutputError }
