import { countNonWhitespaceCodePoints } from '../core/text.ts'
import type { CompileContextResult } from '../context/compiler.ts'
import type { Blueprint } from '../schema/blueprint.ts'
import type { Scene } from '../schema/scene.ts'
import type { SeedFile } from '../schema/seed.ts'
import { sampleTextForWriter, type StyleSample } from '../schema/style-profile.ts'

/**
 * Writer 输出约束检查 —— Story 7 起始会裁决。
 *
 * - **硬**（命中即失败）：
 *   ① 不含后续 Scene 的 `purpose` / `end_state` 关键短语；
 *   ② 不含未授权 truth 原文；
 *   ③ 运行期间不修改任何状态文件（由 `runProseWriter` 的快照比对承担）；
 *   ④ 不修改 Blueprint / Scene（同上）；
 *   ⑤ 使用了 `de_entity=true` 的样本时，不含被去实体化的实体原值。
 * - **软**（只产生 warning）：
 *   ⑥ POV 越界：非 POV 角色 name 与内心动词共现；
 *   ⑦ 篇幅偏离 `target_length`（外部校验）；
 *   ⑧ `end_state` 关键短语未出现（场景目标一致性提示）。
 *
 * Story 7 **不做语义判断**（作者总结 / 潜台词直说 / 情绪重复 / 声音趋同 / 解释过度属于 Story 9）。
 */

export const INNER_STATE_VERBS = [
  '心里',
  '心中',
  '想到',
  '想着',
  '觉得',
  '感到',
  '意识到',
  '明白',
  '希望',
  '害怕',
  '后悔',
  '委屈',
  '以为',
  '暗自',
  '其实他',
  '其实她',
] as const

export const PROSE_CHECK_CODES = [
  'FUTURE_LEAK',
  'UNAUTHORIZED_TRUTH',
  'DE_ENTITY_ENTITY_LEAK',
  'POV_HEAD_HOPPING',
  'LENGTH_DEVIATION',
  'END_STATE_MISSING',
  'UNCONFIRMED_CONTENT_MENTION',
] as const
export type ProseCheckCode = (typeof PROSE_CHECK_CODES)[number]

export interface ProseCheckFinding {
  readonly code: ProseCheckCode
  readonly severity: 'hard' | 'warning'
  readonly message: string
}

export interface ProseCheckReport {
  readonly hardFailures: readonly ProseCheckFinding[]
  readonly warnings: readonly ProseCheckFinding[]
  readonly lengthDeviationRatio: number | null
}

export interface ProseCheckInput {
  readonly text: string
  readonly scene: Scene
  readonly blueprint: Blueprint
  readonly context: CompileContextResult
  readonly scenes: readonly Scene[]
  /** 用于后续版本扩展（例如把 open question 与正文关联）；当前检查不读取。 */
  readonly seed: SeedFile
  /** 本场实际使用的原始 Style Sample（含 text / sanitized_text），用于去实体化硬断言。 */
  readonly originalSamples?: readonly StyleSample[] | undefined
}

/** 提取"关键短语"：取字符串中长度 ≥4 的中文/字母数字片段。 */
export function keyPhrases(value: string, minLength = 4): string[] {
  return value
    .split(/[，。；：、！？,.;:!?\s（）()《》"'"'…—-]+/u)
    .map((fragment) => fragment.trim())
    .filter((fragment) => countNonWhitespaceCodePoints(fragment) >= minLength)
}

/**
 * 从 `text` → `sanitized_text` 的差异中提取"被去实体化的实体原值"。
 *
 * 实现：码点级最长公共子序列（样本很短，代价可接受），
 * 只保留"在 text 中存在、在 sanitized_text 中不存在"的连续片段（长度 ≥2 且含非标点字符）。
 */
export function extractDeEntityRedactions(text: string, sanitizedText: string): string[] {
  const a = [...text]
  const b = [...sanitizedText]
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lengths[i] as number[]
      const nextRow = lengths[i + 1] as number[]
      row[j] = a[i] === b[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number)
    }
  }
  const diffSpans: string[] = []
  let buffer = ''
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      if (buffer !== '') {
        diffSpans.push(buffer)
        buffer = ''
      }
      i += 1
      j += 1
      continue
    }
    const row = lengths[i] as number[]
    const nextRow = lengths[i + 1] as number[]
    if ((nextRow[j] as number) >= (row[j + 1] as number)) {
      buffer += a[i]
      i += 1
    } else {
      j += 1
    }
  }
  while (i < a.length) {
    buffer += a[i]
    i += 1
  }
  if (buffer !== '') diffSpans.push(buffer)

  const isPunctuationOnly = (value: string): boolean => /^[\s\p{P}\p{S}]+$/u.test(value)
  return [...new Set(diffSpans.map((span) => span.trim()).filter((span) => span.length >= 2 && !isPunctuationOnly(span)))]
}

export function checkProseConstraints(input: ProseCheckInput): ProseCheckReport {
  const { text, scene, blueprint, context, scenes, seed } = input
  const hardFailures: ProseCheckFinding[] = []
  const warnings: ProseCheckFinding[] = []

  // ① 后续 Scene 泄漏（硬）
  const futureScenes = scenes.filter((candidate) => candidate.order > scene.order)
  for (const future of futureScenes) {
    for (const phrase of [...keyPhrases(future.purpose), ...keyPhrases(future.end_state)]) {
      if (text.includes(phrase)) {
        hardFailures.push({
          code: 'FUTURE_LEAK',
          severity: 'hard',
          message: `正文包含后续 Scene ${future.scene_id} 的关键短语「${phrase}」：Writer 不得推进 Future Scene（需求规格 §24）`,
        })
      }
    }
  }

  // ② 未授权真相（硬）
  const allowedIds = new Set(scene.allowed_reveals)
  for (const knowledge of blueprint.key_knowledge) {
    if (allowedIds.has(knowledge.id)) continue
    for (const phrase of keyPhrases(knowledge.truth)) {
      if (text.includes(phrase)) {
        hardFailures.push({
          code: 'UNAUTHORIZED_TRUTH',
          severity: 'hard',
          message: `正文写到了未授权真相 ${knowledge.id} 的内容「${phrase}」：本场 allowed_reveals=${scene.allowed_reveals.join(',') || '（空）'}（需求规格 §15.5/§15.6）`,
        })
      }
    }
  }

  // ⑤ 去实体化样本的实体泄漏（硬）
  const profile = context.writerContext.style_samples
  for (const sample of profile) {
    const source = findSample(input, sample.sample_id)
    if (source === undefined || !source.de_entity || source.sanitized_text === undefined) continue
    for (const entity of extractDeEntityRedactions(source.text, source.sanitized_text)) {
      if (text.includes(entity)) {
        hardFailures.push({
          code: 'DE_ENTITY_ENTITY_LEAK',
          severity: 'hard',
          message: `正文搬运了样本 ${sample.sample_id} 中已去实体化的实体原值「${entity}」（Story 7：de_entity=true 时硬断言）`,
        })
      }
    }
  }

  // ⑥ POV 越界（软）：非 POV 角色 name 与内心动词共现
  const nonPovCharacters = blueprint.characters.filter((character) => character.id !== scene.pov)
  for (const character of nonPovCharacters) {
    const nameIndex = text.indexOf(character.name)
    if (nameIndex < 0) continue
    const window = text.slice(Math.max(0, nameIndex - 40), nameIndex + character.name.length + 40)
    const verb = INNER_STATE_VERBS.find((candidate) => window.includes(candidate))
    if (verb !== undefined) {
      warnings.push({
        code: 'POV_HEAD_HOPPING',
        severity: 'warning',
        message: `疑似 POV 越界：非 POV 角色「${character.name}」附近出现内心动词「${verb}」；Story 7 只做共现提示，语义判定属于 Story 9`,
      })
    }
  }

  // ③' 未确认内容（Scene 的 proposed_additions 是永久 PROPOSED，Writer 不应把它当既成事实展开）
  for (const addition of scene.proposed_additions) {
    for (const phrase of keyPhrases(addition.value)) {
      if (text.includes(phrase)) {
        warnings.push({
          code: 'UNCONFIRMED_CONTENT_MENTION',
          severity: 'warning',
          message: `正文提到了本场 proposed_additions（永久 PROPOSED）的内容「${phrase}」：该内容未经 Gate 2 确认（OQ-14）`,
        })
      }
    }
  }

  // ⑦ 篇幅偏离（软，外部校验）
  const counted = countNonWhitespaceCodePoints(text)
  const ratio = scene.target_length === 0 ? null : counted / scene.target_length
  if (ratio !== null && (ratio < 0.5 || ratio > 1.8)) {
    warnings.push({
      code: 'LENGTH_DEVIATION',
      severity: 'warning',
      message: `本场正文 ${counted} 个非空白码点，目标 ${scene.target_length}（偏差 ${Math.round((ratio - 1) * 100)}%）；target_length 只做外部校验（Story 7 裁决）`,
    })
  }

  // ⑧ end_state 关键短语缺失（软）
  const endPhrases = keyPhrases(scene.end_state)
  if (endPhrases.length > 0 && !endPhrases.some((phrase) => text.includes(phrase))) {
    warnings.push({
      code: 'END_STATE_MISSING',
      severity: 'warning',
      message: `正文没有出现 Scene end_state 的任何关键短语（${endPhrases.join(' / ')}）；场景目标一致性属于软检查（Story 8/9 后续）`,
    })
  }

  return { hardFailures, warnings, lengthDeviationRatio: ratio }
}

/** 从项目的 style profile 中取原始样本（用于 de_entity 实体泄漏的硬断言）。 */
function findSample(input: ProseCheckInput, sampleId: string): StyleSample | undefined {
  return input.originalSamples?.find((sample) => sample.sample_id === sampleId)
}

export { sampleTextForWriter }
