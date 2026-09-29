import { STRUCTURE_IDS, type Blueprint, type StructureKey } from '../schema/blueprint.ts'
import type { Scene } from '../schema/scene.ts'

/**
 * Structure Resolver —— 需求规格 §14.1 / §15 / §16；Story 5。
 *
 * 职责：把 `structure position → concrete scene` 解析出来：
 * - `reveal_at_structure + reveal_order` → 唯一 Scene → 写入该 Scene 的 `allowed_reveals`；
 * - foreshadowing 的 `setup_at_structure + setup_order` / `payoff_at_structure + payoff_order`
 *   → `resolved_setup_scene` / `resolved_payoff_scene`（写入 Story State）；
 * - **真实 scene_id 不反写 Blueprint**（§14.1 / §11.2）。
 *
 * 排序依据：全局 `Scene.order`（§14.1「按全局 Scene.order 排序」）。
 */

export const RESOLUTION_WARNING_TYPES = [
  'reveal_order_out_of_range',
  'reveal_duplicate_coverage',
  'reveal_unresolved',
  'foreshadowing_setup_unresolved',
  'foreshadowing_payoff_unresolved',
  'foreshadowing_payoff_before_setup',
] as const
export type ResolutionWarningType = (typeof RESOLUTION_WARNING_TYPES)[number]

export interface ResolutionWarning {
  readonly type: ResolutionWarningType
  readonly message: string
  readonly refs: readonly string[]
}

export interface RevealResolution {
  readonly knowledge_id: string
  /** 解析到的真实 Scene ID；未解析到时为 null。 */
  readonly scene_id: string | null
  readonly reveal_at_structure: string
  readonly reveal_order: number
}

export interface ForeshadowingResolution {
  readonly foreshadowing_id: string
  readonly resolved_setup_scene: string | null
  readonly resolved_payoff_scene: string | null
}

export interface StructureResolution {
  readonly reveals: readonly RevealResolution[]
  readonly foreshadowing: readonly ForeshadowingResolution[]
  /** scene_id → 该 Scene 允许发生的 reveal（K ID 列表）。 */
  readonly allowedRevealsByScene: ReadonlyMap<string, readonly string[]>
  readonly warnings: readonly ResolutionWarning[]
}

export function sortScenesByOrder(scenes: readonly Scene[]): Scene[] {
  return [...scenes].sort((a, b) => a.order - b.order)
}

/** 找出 `narrative_role_ref === structureId` 的全部 Scene，按全局 order 排序，取第 `order` 个（1-based）。 */
export function resolveStructurePosition(
  scenes: readonly Scene[],
  structureId: string,
  order: number,
): { scene: Scene | null; total: number } {
  const matching = sortScenesByOrder(scenes).filter((scene) => scene.narrative_role_ref === structureId)
  if (order < 1 || order > matching.length) {
    return { scene: null, total: matching.length }
  }
  return { scene: matching[order - 1] as Scene, total: matching.length }
}

export function resolveStructure(
  blueprint: Blueprint,
  scenes: readonly Scene[],
): StructureResolution {
  const warnings: ResolutionWarning[] = []
  const allowedRevealsByScene = new Map<string, string[]>()
  const reveals: RevealResolution[] = []
  const knowledgeCoverage = new Map<string, string[]>()

  for (const knowledge of blueprint.key_knowledge) {
    const { scene, total } = resolveStructurePosition(scenes, knowledge.reveal_at_structure, knowledge.reveal_order)
    if (scene === null) {
      warnings.push({
        type:
          total === 0
            ? 'reveal_unresolved'
            : 'reveal_order_out_of_range',
        message:
          total === 0
            ? `${knowledge.id} 计划在 ${knowledge.reveal_at_structure} 揭示，但没有任何 Scene 的 narrative_role_ref 指向该位置（需求规格 §16：解析失败为 high warning）`
            : `${knowledge.id} 的 reveal_order=${knowledge.reveal_order} 越界：${knowledge.reveal_at_structure} 段只有 ${total} 个 Scene（需求规格 §14.1：order 越界为 high warning）`,
        refs: [knowledge.id, knowledge.reveal_at_structure],
      })
      reveals.push({
        knowledge_id: knowledge.id,
        scene_id: null,
        reveal_at_structure: knowledge.reveal_at_structure,
        reveal_order: knowledge.reveal_order,
      })
      continue
    }
    reveals.push({
      knowledge_id: knowledge.id,
      scene_id: scene.scene_id,
      reveal_at_structure: knowledge.reveal_at_structure,
      reveal_order: knowledge.reveal_order,
    })
    const list = allowedRevealsByScene.get(scene.scene_id) ?? []
    list.push(knowledge.id)
    allowedRevealsByScene.set(scene.scene_id, list)
    knowledgeCoverage.set(knowledge.id, [...(knowledgeCoverage.get(knowledge.id) ?? []), scene.scene_id])
  }

  // §16：一个计划 reveal 默认只能解析到一个 Scene（重复覆盖为 high warning）
  for (const [knowledgeId, sceneIds] of knowledgeCoverage) {
    if (sceneIds.length > 1) {
      warnings.push({
        type: 'reveal_duplicate_coverage',
        message: `${knowledgeId} 被多个 Scene 覆盖：${sceneIds.join(' / ')}；一个计划 reveal 默认只能解析到一个 Scene（需求规格 §15 / §16）`,
        refs: [knowledgeId, ...sceneIds],
      })
    }
  }

  const foreshadowing: ForeshadowingResolution[] = []
  for (const item of blueprint.foreshadowing) {
    const setup = resolveStructurePosition(scenes, item.setup_at_structure, item.setup_order)
    const payoff = resolveStructurePosition(scenes, item.payoff_at_structure, item.payoff_order)
    if (setup.scene === null) {
      warnings.push({
        type: 'foreshadowing_setup_unresolved',
        message: `${item.id} 的 setup 位置 ${item.setup_at_structure}（order=${item.setup_order}）解析失败：该位置只有 ${setup.total} 个 Scene（需求规格 §16）`,
        refs: [item.id, item.setup_at_structure],
      })
    }
    if (payoff.scene === null) {
      warnings.push({
        type: 'foreshadowing_payoff_unresolved',
        message: `${item.id} 的 payoff 位置 ${item.payoff_at_structure}（order=${item.payoff_order}）解析失败：该位置只有 ${payoff.total} 个 Scene（需求规格 §16）`,
        refs: [item.id, item.payoff_at_structure],
      })
    }
    if (setup.scene !== null && payoff.scene !== null && payoff.scene.order < setup.scene.order) {
      warnings.push({
        type: 'foreshadowing_payoff_before_setup',
        message: `${item.id} 的 payoff Scene（${payoff.scene.scene_id}, order=${payoff.scene.order}）早于 setup Scene（${setup.scene.scene_id}, order=${setup.scene.order}）`,
        refs: [item.id, setup.scene.scene_id, payoff.scene.scene_id],
      })
    }
    foreshadowing.push({
      foreshadowing_id: item.id,
      resolved_setup_scene: setup.scene?.scene_id ?? null,
      resolved_payoff_scene: payoff.scene?.scene_id ?? null,
    })
  }

  return {
    reveals,
    foreshadowing,
    allowedRevealsByScene,
    warnings,
  }
}

/** 把解析结果写入 Scene（`allowed_reveals` 由 Resolver 生成，不由模型输出）。 */
export function applyAllowedReveals(scenes: readonly Scene[], resolution: StructureResolution): Scene[] {
  return scenes.map((scene) => ({
    ...scene,
    allowed_reveals: [...(resolution.allowedRevealsByScene.get(scene.scene_id) ?? [])],
  }))
}

export function structureKeyOfId(structureId: string): StructureKey | undefined {
  return (Object.keys(STRUCTURE_IDS) as StructureKey[]).find((key) => STRUCTURE_IDS[key] === structureId)
}
