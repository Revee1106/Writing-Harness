import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { sourceRefSchema } from '../core/source-ref.ts'
import { OBSERVABLE_HINT_TAGS, observableHintTagList } from '../core/scene-types.ts'
import { seedFidelitySchema } from './proposal.ts'

/**
 * Story Blueprint Schema —— 需求规格 §11.1（唯一版本）/ 架构设计 §11.1；Story 4。
 *
 * 关键约束（文档 + 用户裁决）：
 * - **Blueprint 禁止直接引用 scene_id**：所有 reveal / foreshadowing 落点使用 `structure` 相对位置
 *   （§11「Blueprint 先于 Scene Breakdown 产生」、§11.2）；
 * - `len(meta.pov) ∈ {1,2}`（§11.3）；
 * - 单 POV 时 `inner_state_pov_visible` 由 Builder 默认填入 `[meta.pov[0]]`；双 POV 必须显式（§11.3）；
 * - `observable_behavior_hints` 结构化，带 `applicable_scene_types`（§11.3、Story 4）；
 * - relationship baseline：`characters[].relationships[]` 带稳定 ID（§11.1）；
 * - `style_direction` 作为整体 Blueprint Item 使用，内部不分子 ID（§11.3）；
 * - `key_knowledge.known_by` 用 character id 做 key；`truth` 只保存在 Blueprint（§13）；
 * - **OQ-01/OQ-18**：Blueprint 顶层新增 `seed_fidelity`（结构与 Proposal 一致）；`truth_status` v0.1 只允许 `CONFIRMED`。
 */

export const BLUEPRINT_SCHEMA_VERSION = '0.1'

/** 需求规格 §11.1 的 structure 相对位置 → 固定 ID 映射。 */
export const STRUCTURE_KEYS = ['beginning', 'development', 'turning_point', 'climax', 'ending'] as const
export type StructureKey = (typeof STRUCTURE_KEYS)[number]
export const STRUCTURE_IDS: Readonly<Record<StructureKey, string>> = {
  beginning: 'BP_STR_BEG',
  development: 'BP_STR_DEV',
  turning_point: 'BP_STR_TURN',
  climax: 'BP_STR_CLIMAX',
  ending: 'BP_STR_END',
}

export const ARC_KEYS = ['start', 'shift', 'end'] as const
export type ArcKey = (typeof ARC_KEYS)[number]
export const ARC_IDS: Readonly<Record<ArcKey, string>> = {
  start: 'BP_ARC_START',
  shift: 'BP_ARC_SHIFT',
  end: 'BP_ARC_END',
}

export const PREMISE_ID = 'BP_PREMISE_01'
export const CORE_CONFLICT_ID = 'BP_CONFLICT_01'
export const STYLE_DIRECTION_ID = 'BP_STYLE_01'

/** OQ-18 裁决：v0.1 只允许 CONFIRMED（保留未来扩展位，但当前 schema 写死单值）。 */
export const TRUTH_STATUSES = ['CONFIRMED'] as const
export const truthStatusSchema = z.enum(TRUTH_STATUSES)

const sourceRefsSchema = z.array(sourceRefSchema)

/** 可引用的 Blueprint 项（`value` 允许 null，见 §11.1 的占位示例）。 */
export const blueprintValueItemSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.blueprintItem, 'Blueprint 项 ID 必须形如 BP_xxx'),
  value: z.string().nullable(),
  source_refs: sourceRefsSchema,
})
export type BlueprintValueItem = z.infer<typeof blueprintValueItemSchema>

export const premiseSchema = z.strictObject({
  id: z.literal(PREMISE_ID),
  value: z.string().min(1),
  /** §11.1：premise 显式携带 status=CONFIRMED。 */
  status: z.literal('CONFIRMED'),
  source_refs: sourceRefsSchema,
})

export const themeSchema = z.strictObject({
  primary: blueprintValueItemSchema,
  secondary: z.array(blueprintValueItemSchema),
})

export const observableBehaviorHintSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.observableBehaviorHint, 'OBH ID 必须形如 OBH_LINYU_01'),
  value: z.string().min(1),
  /**
   * OQ-36 / OQ-41 裁决：scene_type ∪ tone 的联合白名单
   * （`dialogue` 是 scene_type，`conflict` 是 tone）。
   */
  applicable_scene_types: z
    .array(z.string().min(1))
    .min(1, 'observable hint 必须声明适用的 scene type（§11.3：只按匹配 Scene type 加载）')
    .refine(
      (tags) => tags.every((tag) => (OBSERVABLE_HINT_TAGS as readonly string[]).includes(tag)),
      { error: () => ({ message: `applicable_scene_types 只能取 scene_type ∪ tone 的联合白名单：${observableHintTagList()}（OQ-36 / OQ-41）` }) },
    ),
})

export const relationshipSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.relationship, 'relationship ID 必须形如 REL_LINYU_CHENMO'),
  target: z.string().regex(ID_PATTERNS.character, 'relationship.target 必须是 CH_* 角色 ID'),
  kind: z.string().min(1),
  state: z.string().min(1),
  /** §11.1：relationship baseline 的起始结构位置。 */
  since_ref: z.string().min(1),
  source_refs: sourceRefsSchema,
})

export const characterSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.character, '角色 ID 必须形如 CH_LIN_YU'),
  name: z.string().min(1),
  role: z.string().min(1),
  desire: z.string().min(1),
  fear: z.string().min(1),
  contradiction: z.string().min(1),
  voice_hint: z.string().min(1),
  /**
   * §11.3：单 POV 时由 Builder 默认填入；双 POV 必须显式。
   *
   * 语义（解读 I-34）：列出"哪些 POV 可以看到该角色的内心状态"。
   * 允许空数组 —— 非 POV 角色在单 POV 故事里对任何 POV 都不可见（架构设计 §21 的物理隔离）。
   */
  inner_state_pov_visible: z.array(z.string().regex(ID_PATTERNS.character)),
  observable_behavior_hints: z.array(observableBehaviorHintSchema),
  relationships: z.array(relationshipSchema),
  source_refs: sourceRefsSchema,
})

export const keyKnowledgeSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.keyKnowledge, 'Key Knowledge ID 必须形如 K001'),
  truth: z.string().min(1),
  truth_status: truthStatusSchema,
  /** §13：key 必须是 characters[].id；POV Filter 查询 known_by[current_pov]。 */
  known_by: z.record(z.string().regex(ID_PATTERNS.character, 'known_by 的 key 必须是 CH_* 角色 ID'), z.boolean()),
  reader_knows: z.boolean(),
  reveal_at_structure: z.string().min(1),
  reveal_order: z.number().int().min(1),
  reveal_to: z.array(z.string().regex(ID_PATTERNS.character, 'reveal_to 元素必须是 CH_* 角色 ID')),
  reveal_to_reader: z.boolean(),
  source_refs: sourceRefsSchema,
})

export const foreshadowingSchema = z.strictObject({
  id: z.string().regex(ID_PATTERNS.blueprintItem, 'foreshadowing ID 必须形如 BP_FS_001'),
  value: z.string().min(1),
  setup_at_structure: z.string().min(1),
  setup_order: z.number().int().min(1),
  payoff_at_structure: z.string().min(1),
  payoff_order: z.number().int().min(1),
  source_refs: sourceRefsSchema,
})

/** §11.3：style_direction 作为整体 Blueprint Item 使用；narration/dialogue/rhythm 不再分子 ID。 */
export const styleDirectionSchema = z.strictObject({
  id: z.literal(STYLE_DIRECTION_ID),
  narration: z.string().min(1),
  dialogue: z.string().min(1),
  rhythm: z.string().min(1),
  source_refs: sourceRefsSchema,
})

export const blueprintSchema = z
  .strictObject({
    schema_version: z.literal(BLUEPRINT_SCHEMA_VERSION),
    blueprint_version: z.number().int().min(1),
    meta: z.strictObject({
      title: z.string().min(1),
      genre: z.string().min(1),
      /** §11.3：长度 ∈ {1,2}。 */
      pov: z.array(z.string().regex(ID_PATTERNS.character, 'meta.pov 元素必须是 CH_* 角色 ID')).min(1).max(2),
      target_length: z.number().int().positive(),
    }),
    premise: premiseSchema,
    theme: themeSchema,
    characters: z.array(characterSchema).min(1),
    core_conflict: z.strictObject({
      id: z.literal(CORE_CONFLICT_ID),
      value: z.string().min(1),
      source_refs: sourceRefsSchema,
    }),
    arc: z.strictObject({
      start: blueprintValueItemSchema,
      shift: blueprintValueItemSchema,
      end: blueprintValueItemSchema,
    }),
    structure: z.strictObject({
      beginning: blueprintValueItemSchema,
      development: blueprintValueItemSchema,
      turning_point: blueprintValueItemSchema,
      climax: blueprintValueItemSchema,
      ending: blueprintValueItemSchema,
    }),
    key_knowledge: z.array(keyKnowledgeSchema),
    foreshadowing: z.array(foreshadowingSchema),
    style_direction: styleDirectionSchema,
    /** OQ-01：结构与 Proposal 的 seed_fidelity 一致。 */
    seed_fidelity: seedFidelitySchema,
  })
  .superRefine((blueprint, ctx) => {
    const structureIds = new Set(Object.values(STRUCTURE_IDS))
    const characterIds = new Set(blueprint.characters.map((character) => character.id))
    const povIds = blueprint.meta.pov

    const fail = (message: string, path: (string | number)[] = []): void => {
      ctx.addIssue({ code: 'custom', message, path })
    }

    // 角色 ID 唯一
    if (characterIds.size !== blueprint.characters.length) {
      fail('characters[].id 必须唯一（§11.1：所有可引用项都要有稳定 ID）', ['characters'])
    }
    // meta.pov 必须指向已定义角色
    for (const povId of povIds) {
      if (!characterIds.has(povId)) {
        fail(`meta.pov 引用了未定义的角色 ${povId}`, ['meta', 'pov'])
      }
    }
    if (new Set(povIds).size !== povIds.length) {
      fail('meta.pov 不允许重复角色', ['meta', 'pov'])
    }

    // 结构位置 ID 必须与 §11.1 的固定 ID 一致
    for (const key of STRUCTURE_KEYS) {
      const expected = STRUCTURE_IDS[key]
      if (blueprint.structure[key].id !== expected) {
        fail(`structure.${key}.id 必须是 ${expected}（需求规格 §11.2）`, ['structure', key, 'id'])
      }
    }
    for (const key of ARC_KEYS) {
      if (blueprint.arc[key].id !== ARC_IDS[key]) {
        fail(`arc.${key}.id 必须是 ${ARC_IDS[key]}`, ['arc', key, 'id'])
      }
    }
    if (blueprint.theme.primary.id !== 'BP_THEME_01') {
      fail('theme.primary.id 必须是 BP_THEME_01（§11.1）', ['theme', 'primary', 'id'])
    }
    blueprint.theme.secondary.forEach((item, index) => {
      if (item.id !== `BP_THEME_${String(index + 2).padStart(2, '0')}`) {
        fail(`theme.secondary[${index}].id 必须按顺序编号（BP_THEME_02…）`, ['theme', 'secondary', index, 'id'])
      }
    })

    // 角色内部约束
    const relationshipIds = new Set<string>()
    const hintIds = new Set<string>()
    for (const [index, character] of blueprint.characters.entries()) {
      const base: (string | number)[] = ['characters', index]
      for (const visiblePov of character.inner_state_pov_visible) {
        if (!povIds.includes(visiblePov)) {
          fail(
            `${character.id}.inner_state_pov_visible 只能包含 meta.pov 中的角色（收到 ${visiblePov}）；内心可见性是 POV 维度的概念（§11.3）`,
            [...base, 'inner_state_pov_visible'],
          )
        }
      }
      for (const hint of character.observable_behavior_hints) {
        if (hintIds.has(hint.id)) fail(`observable hint ID 重复：${hint.id}`, [...base, 'observable_behavior_hints'])
        hintIds.add(hint.id)
      }
      for (const relationship of character.relationships) {
        if (relationshipIds.has(relationship.id)) {
          fail(`relationship ID 重复：${relationship.id}`, [...base, 'relationships'])
        }
        relationshipIds.add(relationship.id)
        if (!characterIds.has(relationship.target)) {
          fail(`${relationship.id}.target 指向不存在的角色 ${relationship.target}`, [...base, 'relationships'])
        }
        if (relationship.target === character.id) {
          fail(`${relationship.id} 的 target 不能是角色自己`, [...base, 'relationships'])
        }
        if (!structureIds.has(relationship.since_ref)) {
          fail(
            `${relationship.id}.since_ref 必须引用 structure 位置（${[...structureIds].join(' / ')}），收到 ${relationship.since_ref}（§11.2）`,
            [...base, 'relationships'],
          )
        }
      }
    }

    // Key Knowledge（§13）
    const knowledgeIds = new Set<string>()
    for (const [index, knowledge] of blueprint.key_knowledge.entries()) {
      const base: (string | number)[] = ['key_knowledge', index]
      if (knowledgeIds.has(knowledge.id)) fail(`key_knowledge ID 重复：${knowledge.id}`, base)
      knowledgeIds.add(knowledge.id)
      for (const knownId of Object.keys(knowledge.known_by)) {
        if (!characterIds.has(knownId)) {
          fail(`${knowledge.id}.known_by 的 key ${knownId} 不是 characters[].id（§13）`, [...base, 'known_by'])
        }
      }
      for (const povId of povIds) {
        if (!(povId in knowledge.known_by)) {
          fail(
            `${knowledge.id}.known_by 缺少当前 POV 角色 ${povId} 的键；POV Filter 需要 known_by[current_pov] 能直接查询（§13）`,
            [...base, 'known_by'],
          )
        }
      }
      for (const revealTo of knowledge.reveal_to) {
        if (!characterIds.has(revealTo)) {
          fail(`${knowledge.id}.reveal_to 引用不存在的角色 ${revealTo}`, [...base, 'reveal_to'])
        }
      }
      if (!structureIds.has(knowledge.reveal_at_structure)) {
        fail(
          `${knowledge.id}.reveal_at_structure 必须引用 structure 位置（收到 ${knowledge.reveal_at_structure}）；Blueprint 禁止引用 scene_id（§11.2）`,
          [...base, 'reveal_at_structure'],
        )
      }
    }

    // Foreshadowing（§11.2）
    const foreshadowingIds = new Set<string>()
    for (const [index, item] of blueprint.foreshadowing.entries()) {
      const base: (string | number)[] = ['foreshadowing', index]
      if (foreshadowingIds.has(item.id)) fail(`foreshadowing ID 重复：${item.id}`, base)
      foreshadowingIds.add(item.id)
      if (!structureIds.has(item.setup_at_structure)) {
        fail(`${item.id}.setup_at_structure 必须引用 structure 位置（收到 ${item.setup_at_structure}）`, [
          ...base,
          'setup_at_structure',
        ])
      }
      if (!structureIds.has(item.payoff_at_structure)) {
        fail(`${item.id}.payoff_at_structure 必须引用 structure 位置（收到 ${item.payoff_at_structure}）`, [
          ...base,
          'payoff_at_structure',
        ])
      }
    }
  })
export type Blueprint = z.infer<typeof blueprintSchema>

export class BlueprintValidationError extends Error {
  override readonly name = 'BlueprintValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`blueprint.yaml 校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

/** 禁止出现在 Blueprint 里的引用形态（§11：Blueprint 禁止直接引用 scene_id）。 */
export const FORBIDDEN_BLUEPRINT_KEYS = [
  'reveal_scene',
  'setup_scene',
  'payoff_scene',
  'resolved_setup_scene',
  'resolved_payoff_scene',
  'scene_id',
  'scene_order',
] as const

const SCENE_ID_VALUE_PATTERN = /(^|[^a-z])scene-\d{3}($|[^0-9])/

export interface BlueprintScanIssue {
  readonly code: 'SCENE_REFERENCE' | 'PROPOSED_STATE_ITEM' | 'UNEXPECTED_STATUS'
  readonly path: string
  readonly message: string
}

/**
 * 递归扫描（不是 Schema 能表达的约束）：
 * 1. Blueprint 任何位置都不得引用 `scene-###`（§11）；
 * 2. 除 `seed_fidelity.added[].status` 之外，Blueprint 里不允许出现 PROPOSED / USER_GIVEN / OCCURRED
 *    —— 原则 2 的 Story 10 测试要求 Harness 新增内容在两个阶段都保持 `status=PROPOSED`，
 *    因此 seed_fidelity 这一段是**被文档要求保留的例外**。
 */
export function scanBlueprint(value: unknown, path: string[] = []): BlueprintScanIssue[] {
  const issues: BlueprintScanIssue[] = []
  const inSeedFidelity = path[0] === 'seed_fidelity'

  if (typeof value === 'string') {
    if (SCENE_ID_VALUE_PATTERN.test(value)) {
      issues.push({
        code: 'SCENE_REFERENCE',
        path: path.join('.'),
        message: `Blueprint 不允许出现 scene_id 引用（"${value}"）；所有 reveal / foreshadowing 落点必须使用 structure 相对位置（需求规格 §11 / §11.2）`,
      })
    }
    return issues
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      issues.push(...scanBlueprint(item, [...path, String(index)]))
    })
    return issues
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_BLUEPRINT_KEYS as readonly string[]).includes(key)) {
        issues.push({
          code: 'SCENE_REFERENCE',
          path: [...path, key].join('.'),
          message: `Blueprint 不允许出现字段 "${key}"：真实 scene_id 只在 Scene Breakdown 之后产生，且不反写 Blueprint（§11.2）`,
        })
        continue
      }
      if (key === 'status' && typeof child === 'string') {
        const childPath = [...path, key].join('.')
        if (inSeedFidelity) {
          if (child !== 'PROPOSED') {
            issues.push({
              code: 'UNEXPECTED_STATUS',
              path: childPath,
              message: `seed_fidelity 中 Harness 新增内容的 status 必须是 PROPOSED（原则 2 / Story 10 F），收到 ${child}`,
            })
          }
        } else if (child !== 'CONFIRMED') {
          issues.push({
            code: 'PROPOSED_STATE_ITEM',
            path: childPath,
            message: `Blueprint 内容项只能是 CONFIRMED，不允许出现 ${child}（需求规格 §6.4；Proposal 内容必须先经 Gate 2 确认）`,
          })
        }
        continue
      }
      issues.push(...scanBlueprint(child, [...path, key]))
    }
  }
  return issues
}

export function validateBlueprint(value: unknown): Blueprint {
  const parsed = blueprintSchema.safeParse(value)
  if (!parsed.success) {
    throw new BlueprintValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  const scanIssues = scanBlueprint(parsed.data)
  if (scanIssues.length > 0) {
    throw new BlueprintValidationError(scanIssues.map((issue) => `${issue.path}: ${issue.message}`))
  }
  return deepFreeze(parsed.data) as Blueprint
}

/** 列出 Blueprint 中全部可引用 ID（供 Coverage Check 与 Scene 引用校验使用）。 */
export function listBlueprintItemIds(blueprint: Blueprint): string[] {
  const ids: string[] = [blueprint.premise.id, blueprint.theme.primary.id, blueprint.core_conflict.id, blueprint.style_direction.id]
  ids.push(...Object.values(STRUCTURE_IDS), ...Object.values(ARC_IDS))
  ids.push(...blueprint.theme.secondary.map((item) => item.id))
  for (const character of blueprint.characters) {
    ids.push(character.id)
    ids.push(...character.observable_behavior_hints.map((hint) => hint.id))
    ids.push(...character.relationships.map((relationship) => relationship.id))
  }
  ids.push(...blueprint.key_knowledge.map((item) => item.id))
  ids.push(...blueprint.foreshadowing.map((item) => item.id))
  return ids
}
