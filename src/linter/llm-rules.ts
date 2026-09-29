import type { LinterSeverity } from '../schema/anti-ai-vocab.ts'

/**
 * LLM Linter 的语义类型 —— 需求规格 §25.2；Story 9。
 *
 * **只有这五类**（Rule Linter 不检测它们，避免重复报告；反之亦然）。
 */
export const LLM_LINTER_RULES = [
  'author_summary',
  'subtext_exposed',
  'emotion_repeated',
  'voice_blur',
  'over_explanation',
] as const
export type LlmRule = (typeof LLM_LINTER_RULES)[number]

/**
 * 语义类型的默认 severity（Story 9 起始会 dsh 提议，见 OQ-56）：
 * - `author_summary` / `subtext_exposed`：直接把主题或潜台词说破，最伤阅读体验 → high；
 * - 其余三类：medium。
 */
export const LLM_RULE_SEVERITY: Readonly<Record<LlmRule, LinterSeverity>> = {
  author_summary: 'high',
  subtext_exposed: 'high',
  emotion_repeated: 'medium',
  voice_blur: 'medium',
  over_explanation: 'medium',
}

/** 五类语义类型的判定准则（同时进入 Prompt Contract 的说明）。 */
export const LLM_RULE_CRITERIA: Readonly<Record<LlmRule, string>> = {
  author_summary: '作者总结：叙述者替读者总结意义、主题、教训',
  subtext_exposed: '潜台词直说：把本应靠行为与对白传达的潜台词直接说明',
  emotion_repeated: '情绪语义重复：同一情绪被反复命名或叠加',
  voice_blur: '角色声音趋同：不同角色的语气、句式、用词变得一样',
  over_explanation: '解释过度：为读者解释动机、因果、背景，超出场景需要',
}
