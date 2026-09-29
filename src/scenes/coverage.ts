import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ARC_IDS, ARC_KEYS, STRUCTURE_IDS, STRUCTURE_KEYS, listBlueprintItemIds, type Blueprint } from '../schema/blueprint.ts'
import type { Scene } from '../schema/scene.ts'
import type { ResolutionWarning } from './resolver.ts'
import { resolveStructure } from './resolver.ts'

/**
 * Blueprint Coverage Check —— 需求规格 §16；Story 5；Story 5 起始会的 OQ-15 / OQ-43 / OQ-44 裁决。
 *
 * 检查项（全部结构化 warning，不阻塞；§28 精神：用户可继续创作）：
 * - `structure_coverage`：每个 structure 位置是否被至少 1 个 Scene 覆盖；
 * - `arc_coverage`：每个非空 arc 位置是否被直接引用或其映射的 structure 位置被覆盖（OQ-42）；
 * - `ending_coverage`：是否存在 `narrative_role_ref = BP_STR_END` 的 Scene（OQ-15）；
 * - `length_coverage`：Σ scene.target_length 与 meta.target_length 的偏差（±30% 容差，OQ-15）；
 * - `reveal_alignment`：每个 Blueprint reveal 计划被且只被一个 Scene 的 allowed_reveals 覆盖（§16）；
 * - `blueprint_reference_integrity`：Scene 是否引用不存在的 Blueprint ID。
 *
 * severity（OQ-44）：structure / ending / reveal_alignment / blueprint_reference_integrity = high；
 * length / arc = medium。
 */

export const COVERAGE_SCHEMA_VERSION = '0.1'

export const COVERAGE_WARNING_TYPES = [
  'structure_coverage',
  'arc_coverage',
  'ending_coverage',
  'length_coverage',
  'reveal_alignment',
  'blueprint_reference_integrity',
] as const
export type CoverageWarningType = (typeof COVERAGE_WARNING_TYPES)[number]

export const COVERAGE_SEVERITIES = ['high', 'medium', 'low'] as const
export type CoverageSeverity = (typeof COVERAGE_SEVERITIES)[number]

/** OQ-15：length 容差 ±30%。 */
export const LENGTH_TOLERANCE_RATIO = 0.3

/** OQ-42：arc 位置 → 映射的 structure 位置。 */
export const ARC_TO_STRUCTURE: Readonly<Record<string, string>> = {
  [ARC_IDS.start]: STRUCTURE_IDS.beginning,
  [ARC_IDS.shift]: STRUCTURE_IDS.turning_point,
  [ARC_IDS.end]: STRUCTURE_IDS.ending,
}

export const coverageWarningSchema = z.strictObject({
  id: z.string().regex(/^COV_\d{3}$/, 'coverage warning ID 必须形如 COV_001'),
  type: z.enum(COVERAGE_WARNING_TYPES),
  severity: z.enum(COVERAGE_SEVERITIES),
  message: z.string().min(1),
  refs: z.array(z.string()),
})

export const coverageReportSchema = z.strictObject({
  schema_version: z.literal(COVERAGE_SCHEMA_VERSION),
  blueprint_version: z.number().int().min(1),
  generated_at: z.string().min(1),
  summary: z.strictObject({
    scenes: z.number().int().min(0),
    structure_covered: z.number().int().min(0),
    arc_covered: z.number().int().min(0),
    reveals_resolved: z.number().int().min(0),
    reveals_planned: z.number().int().min(0),
    references_checked: z.number().int().min(0),
    total_target_length: z.number().int().min(0),
  }),
  warnings: z.array(coverageWarningSchema),
})
export type CoverageReport = z.infer<typeof coverageReportSchema>

export class CoverageValidationError extends Error {
  override readonly name = 'CoverageValidationError'
  readonly detail: readonly string[]
  constructor(detail: readonly string[]) {
    super(`coverage 报告校验失败：\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export function validateCoverageReport(value: unknown): CoverageReport {
  const parsed = coverageReportSchema.safeParse(value)
  if (!parsed.success) {
    throw new CoverageValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return deepFreeze(parsed.data) as CoverageReport
}

export interface CoverageCheckOptions {
  readonly blueprint: Blueprint
  readonly scenes: readonly Scene[]
  readonly generatedAt?: string | undefined
}

export interface CoverageCheckResult {
  readonly report: CoverageReport
  /** Resolver 产生的解析类 warning（也会并入 report.warnings）。 */
  readonly resolutionWarnings: readonly ResolutionWarning[]
}

export function runCoverageCheck(options: CoverageCheckOptions): CoverageCheckResult {
  const { blueprint, scenes } = options
  const resolution = resolveStructure(blueprint, scenes)
  const warnings: CoverageReport['warnings'] = []
  const nextId = (): string => `COV_${String(warnings.length + 1).padStart(3, '0')}`

  // 1. structure 覆盖（§16）
  let structureCovered = 0
  for (const key of STRUCTURE_KEYS) {
    const structureId = STRUCTURE_IDS[key]
    const matching = scenes.filter((scene) => scene.narrative_role_ref === structureId)
    if (matching.length === 0) {
      warnings.push({
        id: nextId(),
        type: 'structure_coverage',
        severity: 'high',
        message: `structure 位置 ${structureId}（${key}）没有被任何 Scene 的 narrative_role_ref 覆盖（需求规格 §16）`,
        refs: [structureId],
      })
    } else {
      structureCovered += 1
    }
  }

  // 2. arc 覆盖（OQ-42：直接引用，或其映射的 structure 位置已被覆盖）
  let arcCovered = 0
  for (const key of ARC_KEYS) {
    const arcId = ARC_IDS[key]
    const arcItem = blueprint.arc[key]
    const direct = scenes.some((scene) => scene.narrative_role_ref === arcId)
    const mappedStructure = ARC_TO_STRUCTURE[arcId] as string
    const mappedCovered = scenes.some((scene) => scene.narrative_role_ref === mappedStructure)
    if (arcItem.value === null || arcItem.value === '') {
      continue
    }
    if (direct || mappedCovered) {
      arcCovered += 1
    } else {
      warnings.push({
        id: nextId(),
        type: 'arc_coverage',
        severity: 'medium',
        message: `arc 位置 ${arcId}（${key}）既没有被 Scene 直接引用，其映射的 structure 位置 ${mappedStructure} 也没有被覆盖（OQ-42）`,
        refs: [arcId, mappedStructure],
      })
    }
  }

  // 3. ending 覆盖（OQ-15）
  const endingCovered = scenes.some((scene) => scene.narrative_role_ref === STRUCTURE_IDS.ending)
  if (!endingCovered) {
    warnings.push({
      id: nextId(),
      type: 'ending_coverage',
      severity: 'high',
      message: `没有任何 Scene 的 narrative_role_ref = ${STRUCTURE_IDS.ending}：结局没有被落实（OQ-15）`,
      refs: [STRUCTURE_IDS.ending],
    })
  }

  // 4. length 覆盖（±30% 容差）
  const totalTarget = scenes.reduce((sum, scene) => sum + scene.target_length, 0)
  const planned = blueprint.meta.target_length
  const lower = planned * (1 - LENGTH_TOLERANCE_RATIO)
  const upper = planned * (1 + LENGTH_TOLERANCE_RATIO)
  if (totalTarget < lower || totalTarget > upper) {
    warnings.push({
      id: nextId(),
      type: 'length_coverage',
      severity: 'medium',
      message: `Scene 目标字数合计 ${totalTarget}，与 Blueprint 的 target_length ${planned} 偏差超过 ±${LENGTH_TOLERANCE_RATIO * 100}%（允许区间 ${Math.round(lower)}～${Math.round(upper)}）（OQ-15）`,
      refs: [String(planned), String(totalTarget)],
    })
  }

  // 5. reveal alignment（§16：检查 Scene 中实际声明的 allowed_reveals，
  //    即"每个 Blueprint reveal 计划被且只被一个 Scene 覆盖"）
  const knowledgeIds = new Set(blueprint.key_knowledge.map((knowledge) => knowledge.id))
  const declaredCoverage = new Map<string, string[]>()
  for (const scene of scenes) {
    for (const reveal of scene.allowed_reveals) {
      declaredCoverage.set(reveal, [...(declaredCoverage.get(reveal) ?? []), scene.scene_id])
    }
  }
  for (const knowledge of blueprint.key_knowledge) {
    const covering = declaredCoverage.get(knowledge.id) ?? []
    if (covering.length === 0) {
      warnings.push({
        id: nextId(),
        type: 'reveal_alignment',
        severity: 'high',
        message: `${knowledge.id} 的 reveal 计划没有被任何 Scene 的 allowed_reveals 覆盖（需求规格 §16：reveal_alignment 要求恰好一个）`,
        refs: [knowledge.id],
      })
    } else if (covering.length > 1) {
      warnings.push({
        id: nextId(),
        type: 'reveal_alignment',
        severity: 'high',
        message: `${knowledge.id} 被多个 Scene 的 allowed_reveals 覆盖：${covering.join(' / ')}（需求规格 §15 / §16：一个计划 reveal 只能解析到一个 Scene）`,
        refs: [knowledge.id, ...covering],
      })
    }
  }
  for (const warning of resolution.warnings) {
    const isReveal = warning.type.startsWith('reveal_') || warning.type === 'foreshadowing_payoff_before_setup'
    warnings.push({
      id: nextId(),
      type: isReveal ? 'reveal_alignment' : 'blueprint_reference_integrity',
      severity: 'high',
      message: warning.message,
      refs: [...warning.refs],
    })
  }
  for (const scene of scenes) {
    for (const reveal of scene.allowed_reveals) {
      if (!knowledgeIds.has(reveal)) {
        warnings.push({
          id: nextId(),
          type: 'reveal_alignment',
          severity: 'high',
          message: `${scene.scene_id}.allowed_reveals 引用了不存在的 Key Knowledge：${reveal}（需求规格 §15：只能引用 key_knowledge.id）`,
          refs: [scene.scene_id, reveal],
        })
      }
    }
  }

  // 6. blueprint reference integrity（§16）
  const knownIds = new Set(listBlueprintItemIds(blueprint))
  let referencesChecked = 0
  for (const scene of scenes) {
    for (const reference of scene.referenced_blueprint_items) {
      referencesChecked += 1
      if (!knownIds.has(reference)) {
        warnings.push({
          id: nextId(),
          type: 'blueprint_reference_integrity',
          severity: 'high',
          message: `${scene.scene_id}.referenced_blueprint_items 引用了不存在的 Blueprint 项：${reference}（需求规格 §16）`,
          refs: [scene.scene_id, reference],
        })
      }
    }
    if (!knownIds.has(scene.narrative_role_ref)) {
      warnings.push({
        id: nextId(),
        type: 'blueprint_reference_integrity',
        severity: 'high',
        message: `${scene.scene_id}.narrative_role_ref 引用了不存在的 Blueprint 项：${scene.narrative_role_ref}`,
        refs: [scene.scene_id, scene.narrative_role_ref],
      })
    }
    for (const characterId of scene.characters) {
      referencesChecked += 1
      if (!blueprint.characters.some((character) => character.id === characterId)) {
        warnings.push({
          id: nextId(),
          type: 'blueprint_reference_integrity',
          severity: 'high',
          message: `${scene.scene_id}.characters 引用了不存在的角色：${characterId}`,
          refs: [scene.scene_id, characterId],
        })
      }
    }
    if (!blueprint.meta.pov.includes(scene.pov)) {
      warnings.push({
        id: nextId(),
        type: 'blueprint_reference_integrity',
        severity: 'high',
        message: `${scene.scene_id}.pov=${scene.pov} 不在 Blueprint meta.pov（${blueprint.meta.pov.join(' / ')}）之内`,
        refs: [scene.scene_id, scene.pov],
      })
    }
  }

  const report: CoverageReport = {
    schema_version: COVERAGE_SCHEMA_VERSION,
    blueprint_version: blueprint.blueprint_version,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    summary: {
      scenes: scenes.length,
      structure_covered: structureCovered,
      arc_covered: arcCovered,
      reveals_resolved: resolution.reveals.filter((reveal) => reveal.scene_id !== null).length,
      reveals_planned: blueprint.key_knowledge.length,
      references_checked: referencesChecked,
      total_target_length: totalTarget,
    },
    warnings,
  }
  return { report: validateCoverageReport(report), resolutionWarnings: resolution.warnings }
}
