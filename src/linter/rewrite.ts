import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hashContractInput } from '../core/hash.ts'
import { countNonWhitespaceCodePoints } from '../core/text.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { dumpYaml, readTextFile, readYamlFile, writeTextFile, writeYamlFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { loadBlueprint } from '../project/project.ts'
import { loadScenes } from '../scenes/service.ts'
import { validateLinterReport, type LinterReport, type LinterWarning } from '../schema/linter-report.ts'
import { checkProseConstraints } from '../writer/checks.ts'
import { compileContext } from '../context/compiler.ts'
import { loadSeed } from '../project/project.ts'
import type { LinterProvider } from '../providers/types.ts'
import { keyPhrases } from '../writer/checks.ts'
import { relintAfterRewrite, type RelintScope } from './relint.ts'

/**
 * Local Rewrite —— 需求规格 §27；架构设计 §29；Story 9。
 *
 * 契约（Story 9 起始会裁决 3 / 4）：
 * - 输入：span + 原文切片 + warning + 前后一段 + Scene 元信息 + Style Samples；
 * - 输出：**纯文本替换内容**（无引号、无前缀、无 Markdown）；
 * - 长度 ≤ 原 span 的 3 倍；无法改写时输出原文本（记 `applied=false`）；
 * - 不得引入 Scene 中没有的实体、不得引入未授权 truth、不得改变 end_state 语义；
 * - 拼接后**除 span 外字节级一致**；
 * - 落回：原地改写 `drafts/scene-NNN.md`；`reports/linter.yaml` 对应 warning 加 `rewrite`
 *   记录；**不新增备份文件**；v0.1 不实现自动回滚。
 */

export const LOCAL_REWRITE_CONTRACT_ID = 'local_rewrite'
export const LOCAL_REWRITE_CONTRACT_VERSION = '0.1'

/** 替换文本的长度上限倍数（Story 9 裁决）。 */
export const REWRITE_MAX_LENGTH_RATIO = 3

export class LocalRewriteError extends Error {
  override readonly name = 'LocalRewriteError'
  constructor(message: string) {
    super(message)
  }
}

export interface RewriteWarningInput {
  readonly warning_id: string
  readonly rule: string
  readonly severity: string
  readonly span: { readonly start: number; readonly end: number }
  readonly text: string
  readonly message: string
}

/** 构造 Prompt Contract 的结构化输入（同时决定 recorded fixture 的查找键）。 */
export function buildLocalRewriteInput(params: {
  readonly sceneMeta: Readonly<Record<string, unknown>>
  readonly warning: RewriteWarningInput
  readonly spanText: string
  readonly precedingParagraph: string
  readonly followingParagraph: string
  readonly styleSamples: readonly { readonly sample_id: string; readonly text: string }[]
}): Readonly<Record<string, unknown>> {
  return {
    scene_meta: params.sceneMeta,
    warning: {
      warning_id: params.warning.warning_id,
      rule: params.warning.rule,
      severity: params.warning.severity,
      message: params.warning.message,
    },
    span: { start: params.warning.span.start, end: params.warning.span.end },
    span_text: params.spanText,
    preceding_paragraph: params.precedingParagraph,
    following_paragraph: params.followingParagraph,
    style_samples: params.styleSamples.map((sample) => ({ sample_id: sample.sample_id, text: sample.text })),
  }
}

/** 纯文本校验：无引号包裹、无前缀、无 Markdown。 */
export function checkRewriteTextFormat(text: string): string[] {
  const problems: string[] = []
  const trimmed = text.trim()
  if (/^```/.test(trimmed)) problems.push('替换文本不得含代码围栏')
  if (/^#{1,6}\s/m.test(trimmed)) problems.push('替换文本不得含 Markdown 标题')
  if (/^[-*+]\s/m.test(trimmed)) problems.push('替换文本不得含 Markdown 列表')
  if (/^(改写|替换|建议|输出|回答)[：:]/u.test(trimmed)) problems.push('替换文本不得带前缀说明')
  if (/^(「[\s\S]*」|“[\s\S]*”|"[\s\S]*"|'[\s\S]*')$/u.test(trimmed)) problems.push('替换文本不得被引号整体包裹')
  return problems
}

export interface RewriteValidation {
  readonly ok: boolean
  readonly problems: readonly string[]
}

export interface ValidateRewriteParams {
  readonly originalSpanText: string
  readonly rewrittenText: string
  readonly sceneText: string
  readonly blueprintCharacterNames: readonly string[]
  readonly forbiddenTruthPhrases: readonly string[]
  readonly endStatePhrases: readonly string[]
}

/** 契约校验（必须在拼接前通过）。 */
export function validateRewrite(params: ValidateRewriteParams): RewriteValidation {
  const problems: string[] = [...checkRewriteTextFormat(params.rewrittenText)]
  const originalLength = countNonWhitespaceCodePoints(params.originalSpanText)
  const rewrittenLength = countNonWhitespaceCodePoints(params.rewrittenText)
  if (rewrittenLength > originalLength * REWRITE_MAX_LENGTH_RATIO) {
    problems.push(
      `替换文本过长：${rewrittenLength} > 原 span ${originalLength} × ${REWRITE_MAX_LENGTH_RATIO}`,
    )
  }
  // 不得引入 Scene 中没有的实体（保守口径：不得出现"Blueprint 角色名但当前 Scene 不存在"的名字）
  for (const name of params.blueprintCharacterNames) {
    if (params.rewrittenText.includes(name) && !params.sceneText.includes(name)) {
      problems.push(`替换文本引入了 Scene 中不存在的角色名「${name}」`)
    }
  }
  for (const phrase of params.forbiddenTruthPhrases) {
    if (params.rewrittenText.includes(phrase)) {
      problems.push(`替换文本写到了未授权真相「${phrase}」`)
    }
  }
  // 不得造成"紧邻重复"：替换文本与紧邻上下文的最长重叠片段 ≥4 码点即视为重复粘贴
  const scenePoints = [...params.sceneText]
  const spanStart = params.sceneText.indexOf(params.originalSpanText)
  if (spanStart >= 0) {
    const startOffset = [...params.sceneText.slice(0, spanStart)].length
    const spanLength = [...params.originalSpanText].length
    const precedingPoints = scenePoints.slice(0, startOffset)
    const followingPoints = scenePoints.slice(startOffset + spanLength)
    const replacementPoints = [...params.rewrittenText]
    // I-71 裁决：4 码点重叠属正常衔接（不拒绝），5 码点起视为重复粘贴
    const MIN_OVERLAP = 5
    const MAX_OVERLAP = 12
    for (let length = MIN_OVERLAP; length <= MAX_OVERLAP; length += 1) {
      const prefix = replacementPoints.slice(0, length).join('')
      if (prefix.length < length) break
      const precedingSuffix = precedingPoints.slice(-length).join('')
      if (precedingSuffix.length === length && precedingSuffix === prefix) {
        problems.push(`替换文本与前文形成重叠重复（「${prefix}」）：不得用重复粘贴的方式凑长度`)
        break
      }
      const suffix = replacementPoints.slice(-length).join('')
      const followingPrefix = followingPoints.slice(0, length).join('')
      if (followingPrefix.length === length && followingPrefix === suffix) {
        problems.push(`替换文本与后文形成重叠重复（「${suffix}」）：不得用重复粘贴的方式凑长度`)
        break
      }
    }
  }

  // 不得改变 end_state 语义：改写前存在的 end_state 关键短语，改写后必须仍然存在
  const survivingEndPhrases = params.endStatePhrases.filter((phrase) => params.sceneText.includes(phrase))
  const rewrittenScene = params.sceneText.replace(params.originalSpanText, params.rewrittenText)
  for (const phrase of survivingEndPhrases) {
    if (!rewrittenScene.includes(phrase)) {
      problems.push(`替换后丢失了 Scene end_state 的关键短语「${phrase}」`)
    }
  }
  return { ok: problems.length === 0, problems }
}

export interface LocalRewriteOptions {
  readonly paths: ProjectPaths
  /** 仓库根：用于加载仓库级词表 fallback（Rule Linter 局部重跑需要）。 */
  readonly repoRoot: string
  readonly provider: LinterProvider
  readonly sceneId: string
  readonly warningId: string
  readonly now?: Date | undefined
  readonly dryRun?: boolean | undefined
  readonly scope?: RelintScope | undefined
}

export interface LocalRewriteResult {
  readonly sceneId: string
  readonly warningId: string
  readonly applied: boolean
  readonly before: string
  readonly after: string
  readonly span: { readonly start: number; readonly end: number }
  readonly report: LinterReport
  readonly relint: { readonly replacedRange: { readonly start: number; readonly end: number }; readonly ids: readonly string[] }
  readonly prompt: string
  readonly inputSha256: string
  readonly provider: string
  readonly model: string
  readonly written: boolean
}

/** 段落定位（局部二次检查的范围基础）。 */
export function locateParagraphs(text: string, offset: number): { index: number; start: number; end: number; paragraphs: { start: number; end: number }[] } {
  const points = [...text]
  const paragraphs: { start: number; end: number }[] = []
  let start = 0
  const flush = (end: number): void => {
    paragraphs.push({ start, end })
    start = end
  }
  let pendingNewlines = 0
  points.forEach((point, index) => {
    if (point === '\n') {
      pendingNewlines += 1
      if (pendingNewlines >= 2) {
        flush(index + 1 - pendingNewlines + 1)
        pendingNewlines = 0
        start = index + 1
      }
      return
    }
    pendingNewlines = 0
  })
  flush(points.length)
  const index = Math.max(
    0,
    paragraphs.findIndex((paragraph) => offset >= paragraph.start && offset < paragraph.end),
  )
  const target = paragraphs[index] ?? { start: 0, end: points.length }
  return { index, start: target.start, end: target.end, paragraphs }
}

export interface PreparedRewrite {
  readonly sceneText: string
  readonly spanText: string
  readonly sceneMeta: Readonly<Record<string, unknown>>
  readonly preceding: string
  readonly following: string
  readonly styleSamples: readonly { readonly sample_id: string; readonly text: string }[]
  readonly input: Readonly<Record<string, unknown>>
}

/** 构造 Rewrite 的输入（运行时与 recorded fixture 的工具链共用同一函数）。 */
export function prepareRewrite(
  paths: ProjectPaths,
  sceneId: string,
  warning: RewriteWarningInput,
): PreparedRewrite {
  const draftPath = join(paths.draftsDir, `${sceneId}.md`)
  const sceneText = readTextFile(draftPath)
  const points = [...sceneText]
  const spanText = points.slice(warning.span.start, warning.span.end).join('')
  const scenes = loadScenes(paths)
  const scene = scenes.find((candidate) => candidate.scene_id === sceneId)
  if (scene === undefined) throw new LocalRewriteError(`找不到 ${sceneId}`)
  const location = locateParagraphs(sceneText, warning.span.start)
  const previousParagraph = location.paragraphs[location.index - 1]
  const nextParagraph = location.paragraphs[location.index + 1]
  const preceding = previousParagraph === undefined ? '' : points.slice(previousParagraph.start, previousParagraph.end).join('')
  const following = nextParagraph === undefined ? '' : points.slice(nextParagraph.start, nextParagraph.end).join('')
  const context = compileContext({ paths, sceneId })
  const styleSamples = context.writerContext.style_samples.map((sample) => ({
    sample_id: sample.sample_id,
    text: sample.text,
  }))
  const sceneMeta = {
    scene_id: scene.scene_id,
    pov: scene.pov,
    scene_type: scene.scene_type,
    tone: [...scene.tone],
    purpose: scene.purpose,
    location: scene.location,
    end_state: scene.end_state,
  }
  const input = buildLocalRewriteInput({
    sceneMeta,
    warning,
    spanText,
    precedingParagraph: preceding,
    followingParagraph: following,
    styleSamples,
  })
  return { sceneText, spanText, sceneMeta, preceding, following, styleSamples, input }
}

export async function runLocalRewrite(options: LocalRewriteOptions): Promise<LocalRewriteResult> {
  const { paths, sceneId, warningId } = options
  if (!existsSync(paths.linterReport)) {
    throw new LocalRewriteError(`找不到 ${paths.linterReport}；请先执行 harness lint`)
  }
  const report = validateLinterReport(readYamlFile(paths.linterReport))
  if (report.scene_id !== sceneId) {
    throw new LocalRewriteError(
      `reports/linter.yaml 是 ${report.scene_id} 的报告；请先对 ${sceneId} 运行 harness lint`,
    )
  }
  const warning = report.warnings.find((candidate) => candidate.id === warningId)
  if (warning === undefined) {
    throw new LocalRewriteError(
      `报告里没有 ${warningId}（可用：${report.warnings.map((candidate) => candidate.id).join(' / ') || '（无 warning）'}）`,
    )
  }
  if (warning.span === null) {
    throw new LocalRewriteError(`${warningId} 没有 span，无法局部改写（统计型问题请人工处理）`)
  }

  const rewriteWarning: RewriteWarningInput = {
    warning_id: warning.id,
    rule: warning.rule,
    severity: warning.severity,
    span: { start: warning.span.start, end: warning.span.end },
    text: warning.text,
    message: warning.message,
  }
  const draftPath = join(paths.draftsDir, `${sceneId}.md`)
  const { sceneText, spanText, sceneMeta, preceding, following, styleSamples, input } = prepareRewrite(
    paths,
    sceneId,
    rewriteWarning,
  )
  if (spanText.trim() === '') {
    throw new LocalRewriteError(`${warningId} 的 span 回切为空，无法改写`)
  }

  const contract = loadPromptContract(LOCAL_REWRITE_CONTRACT_ID, LOCAL_REWRITE_CONTRACT_VERSION)
  const prompt = renderPrompt(contract, {
    scene_meta: dumpYaml(sceneMeta).trimEnd(),
    warning: dumpYaml({
      warning_id: rewriteWarning.warning_id,
      rule: rewriteWarning.rule,
      severity: rewriteWarning.severity,
      message: rewriteWarning.message,
    }).trimEnd(),
    span_text: spanText,
    preceding_paragraph: preceding === '' ? '（无：本 span 在第一段）' : preceding,
    following_paragraph: following === '' ? '（无：本 span 在最后一段）' : following,
    style_samples:
      styleSamples.length === 0
        ? '（本场没有匹配样本）'
        : styleSamples.map((sample) => `${sample.sample_id}: ${sample.text}`).join('\n'),
  })

  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出替换后的纯文本，不输出解释、引号或 Markdown。',
    temperature: 0.4,
  })
  const rewritten = response.text.replace(/\s+$/u, '').trim()

  const blueprint = loadBlueprint(paths)
  const seed = loadSeed(paths)
  const scenes = loadScenes(paths)
  const scene = scenes.find((candidate) => candidate.scene_id === sceneId) as NonNullable<(typeof scenes)[number]>
  const context = compileContext({ paths, sceneId })
  const allowedReveals = new Set(scene.allowed_reveals)
  const forbiddenTruthPhrases = blueprint.key_knowledge
    .filter((knowledge) => !allowedReveals.has(knowledge.id))
    .flatMap((knowledge) => keyPhrases(knowledge.truth))
  const validation = validateRewrite({
    originalSpanText: spanText,
    rewrittenText: rewritten,
    sceneText,
    blueprintCharacterNames: blueprint.characters.map((character) => character.name),
    forbiddenTruthPhrases,
    endStatePhrases: keyPhrases(scene.end_state),
  })
  if (!validation.ok) {
    throw new LocalRewriteError(`替换文本违反 Rewrite 契约：\n- ${validation.problems.join('\n- ')}`)
  }

  const inputSha256 = hashContractInput(contract.id, contract.version, input)
  // 模型原样返回 → 未改动
  if (rewritten === spanText.trim() || rewritten === spanText) {
    return {
      sceneId,
      warningId,
      applied: false,
      before: spanText,
      after: spanText,
      span: { start: warning.span.start, end: warning.span.end },
      report,
      relint: { replacedRange: { start: warning.span.start, end: warning.span.end }, ids: [] },
      prompt,
      inputSha256,
      provider: response.provider,
      model: response.model,
      written: false,
    }
  }

  const points = [...sceneText]
  const spliced = `${points.slice(0, warning.span.start).join('')}${rewritten}${points.slice(warning.span.end).join('')}`
  if (
    !spliced.startsWith(points.slice(0, warning.span.start).join('')) ||
    !spliced.endsWith(points.slice(warning.span.end).join(''))
  ) {
    throw new LocalRewriteError('拼接结果在 span 之外发生了变化（违反"除 span 外字节级一致"契约）')
  }

  const checks = checkProseConstraints({ text: spliced, scene, blueprint, context, scenes, seed })
  const hard = checks.hardFailures.filter(
    (finding) => finding.code === 'FUTURE_LEAK' || finding.code === 'UNAUTHORIZED_TRUTH',
  )
  if (hard.length > 0) {
    throw new LocalRewriteError(
      `Rewrite 引入了 future / secret leak：\n- ${hard.map((finding) => finding.message).join('\n- ')}`,
    )
  }

  const rewrittenAt = (options.now ?? new Date()).toISOString()
  const updatedWarnings: LinterWarning[] = report.warnings.map((candidate) =>
    candidate.id === warningId
      ? {
          ...candidate,
          rewrite: {
            applied: true,
            before: spanText,
            after: rewritten,
            rewrite_contract: `${LOCAL_REWRITE_CONTRACT_ID}@${LOCAL_REWRITE_CONTRACT_VERSION}`,
            rewritten_at: rewrittenAt,
          },
        }
      : candidate,
  )
  const dryRun = options.dryRun ?? false

  if (dryRun) {
    return {
      sceneId,
      warningId,
      applied: false,
      before: spanText,
      after: rewritten,
      span: { start: warning.span.start, end: warning.span.end },
      report: validateLinterReport({ ...report, warnings: updatedWarnings }),
      relint: { replacedRange: { start: warning.span.start, end: warning.span.end }, ids: [] },
      prompt,
      inputSha256,
      provider: response.provider,
      model: response.model,
      written: false,
    }
  }

  writeTextFile(draftPath, spliced)

  const relint = await relintAfterRewrite({
    paths,
    repoRoot: options.repoRoot,
    sceneId,
    span: { start: warning.span.start, end: warning.span.end },
    text: spliced,
    scope: options.scope ?? 'paragraph',
    now: options.now,
    // 被改写的目标 warning 保留（含 rewrite 审计记录），其余范围内旧 warning 被局部重跑替换
    keepWarningId: warningId,
    previousReport: validateLinterReport({ ...report, warnings: updatedWarnings }),
  })

  return {
    sceneId,
    warningId,
    applied: true,
    before: spanText,
    after: rewritten,
    span: { start: warning.span.start, end: warning.span.end },
    report: relint.report,
    relint: { replacedRange: relint.replacedRange, ids: relint.report.warnings.map((candidate) => candidate.id) },
    prompt,
    inputSha256,
    provider: response.provider,
    model: response.model,
    written: true,
  }
}
