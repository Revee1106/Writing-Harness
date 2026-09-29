/**
 * Scene 类型与 tone 标签登记（Story 5，OQ-36 / OQ-41 裁决）。
 *
 * - `scene_type` 严格为四种（§14 的 `scene_type` 字段）：
 *   `dialogue / action / interior / transition`；
 * - `observable_behavior_hints[].applicable_scene_types`（§11.1）接受
 *   **scene_type ∪ tone 的联合白名单**：例如 `dialogue` 是 scene_type，`conflict` 是 tone；
 * - tone 侧是 dsh 提议的 v0.1 最小标签集（文档未枚举，见 OQ-41），**只增不改**。
 *
 * 注意：这里不修改需求规格 §23.1（Style Sample 的标签仍只有 pov / scene_type / tone），
 * 也不改任何字段名。
 */

export const SCENE_TYPES = ['dialogue', 'action', 'interior', 'transition'] as const
export type SceneType = (typeof SCENE_TYPES)[number]

/** dsh 提议的 v0.1 tone 标签集（OQ-41）。 */
export const TONE_TAGS = [
  'conflict',
  'tension',
  'tenderness',
  'restraint',
  'absurdity',
  'suspense',
  'warmth',
  'grief',
] as const
export type ToneTag = (typeof TONE_TAGS)[number]

/** OBH 的 `applicable_scene_types` 联合白名单。 */
export const OBSERVABLE_HINT_TAGS: readonly string[] = [...SCENE_TYPES, ...TONE_TAGS]

export function isSceneType(value: string): value is SceneType {
  return (SCENE_TYPES as readonly string[]).includes(value)
}

export function isObservableHintTag(value: string): boolean {
  return OBSERVABLE_HINT_TAGS.includes(value)
}

export function sceneTypeList(): string {
  return SCENE_TYPES.join(' / ')
}

export function observableHintTagList(): string {
  return OBSERVABLE_HINT_TAGS.join(' / ')
}
