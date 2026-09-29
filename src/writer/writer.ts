import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { hashContractInput } from '../core/hash.ts'
import { countNonWhitespaceCodePoints } from '../core/text.ts'
import { loadPromptContract, renderPrompt } from '../interpreter/prompt.ts'
import { dumpYaml, writeTextFile } from '../io/yaml.ts'
import type { ProjectPaths } from '../io/paths.ts'
import { compileContext, type CompileContextResult } from '../context/compiler.ts'
import { loadScenes } from '../scenes/service.ts'
import { loadBlueprint, loadSeed } from '../project/project.ts'
import type { Scene } from '../schema/scene.ts'
import type { LLMProvider } from '../providers/types.ts'
import { checkProseConstraints, type ProseCheckReport } from './checks.ts'

/**
 * Prose Writer —— 需求规格 §24；架构设计 §25；Story 7。
 *
 * 约束（Story 7 起始会裁决）：
 * - 输出**纯正文**（无 YAML 包裹 / 元数据 / 标题 / `---` 分隔符）；
 * - 逐场生成 `drafts/scene-NNN.md`，**不新增伴生文件**；
 * - 不读 `proposals.yaml`、不改 Blueprint / Scene / Story State、不推进 Future Scene、不自行升级状态；
 * - `target_length` 只作为外部校验，不放进 Prompt 当硬约束；
 * - Style Sample 复用 Story 6 的选择器（§23.1 四级降级），每场最多 3 个。
 */

export const PROSE_WRITER_CONTRACT_ID = 'prose_writer'
export const PROSE_WRITER_CONTRACT_VERSION = '0.1'

export class ProseWriterError extends Error {
  override readonly name = 'ProseWriterError'
  constructor(message: string) {
    super(message)
  }
}

/** 纯正文格式校验：出现 YAML 包裹 / 元数据 / 标题 / `---` 分隔符即视为违约。 */
export interface ProseFormatViolation {
  readonly code: 'YAML_WRAPPER' | 'METADATA_LINE' | 'TITLE_LINE' | 'SEPARATOR_LINE'
  readonly message: string
}

export function checkProseFormat(text: string): ProseFormatViolation[] {
  const violations: ProseFormatViolation[] = []
  const trimmed = text.trim()
  if (/^(prose|text|body|content|draft)\s*:/m.test(trimmed)) {
    violations.push({ code: 'YAML_WRAPPER', message: '正文出现 YAML 字段名（如 text: / prose:）；Contract 要求纯正文' })
  }
  if (/^```/.test(trimmed)) {
    violations.push({ code: 'YAML_WRAPPER', message: '正文以代码围栏开头；Contract 要求纯正文' })
  }
  if (/^#{1,6}\s/m.test(trimmed)) {
    violations.push({ code: 'TITLE_LINE', message: '正文出现 Markdown 标题行（#）；Contract 要求不含标题' })
  }
  if (/^-{3,}\s*$/m.test(trimmed)) {
    violations.push({ code: 'SEPARATOR_LINE', message: '正文出现 --- 分隔符；Contract 要求不含分隔符' })
  }
  if (/^(scene_id|order|pov)\s*:/m.test(trimmed)) {
    violations.push({ code: 'METADATA_LINE', message: '正文出现元数据字段；Contract 要求不含元数据' })
  }
  return violations
}

export interface ProseWriterOptions {
  readonly paths: ProjectPaths
  readonly provider: LLMProvider
  readonly sceneId: string
  readonly userNotes?: readonly string[] | undefined
  readonly dryRun?: boolean | undefined
  readonly now?: Date | undefined
}

export interface ProseWriterResult {
  readonly sceneId: string
  readonly text: string
  readonly countedCodePoints: number
  readonly targetLength: number
  readonly formatViolations: readonly ProseFormatViolation[]
  readonly checks: ProseCheckReport
  readonly context: CompileContextResult
  readonly prompt: string
  readonly inputSha256: string
  readonly provider: string
  readonly model: string
  readonly written: boolean
  readonly draftPath: string
  readonly rawOutput: string
}

/** 构造 Prompt Contract 的结构化输入（同时决定 recorded fixture 的查找键）。 */
export function buildProseWriterInput(context: CompileContextResult): Readonly<Record<string, unknown>> {
  const writerContext = context.writerContext
  return {
    scene_id: writerContext.scene_id,
    blueprint_version: writerContext.blueprint_version,
    pov: writerContext.pov,
    scene: writerContext.scene,
    characters: writerContext.characters,
    premise: writerContext.premise,
    theme: writerContext.theme,
    core_conflict: writerContext.core_conflict,
    allowed_reveals: writerContext.allowed_reveals,
    known_knowledge_ids: writerContext.known_knowledge_ids,
    style_direction: writerContext.style_direction,
    style_samples: writerContext.style_samples.map((sample) => ({
      sample_id: sample.sample_id,
      text: sample.text,
      matched_on: sample.matched_on,
    })),
    director_surface: writerContext.director_surface,
    draft_context: writerContext.draft_context,
  }
}

/** 项目状态快照（用于"Writer 不得修改任何状态文件"的硬校验）。 */
export function snapshotProjectState(paths: ProjectPaths): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const targets = [
    paths.seed,
    paths.projectConfig,
    paths.proposals,
    paths.blueprint,
    paths.storyState,
    paths.coverageReport,
    paths.contextManifestReport,
    paths.styleProfile,
  ]
  for (const file of targets) {
    if (existsSync(file)) snapshot[`file:${relative(paths.dir, file)}`] = readFileSync(file, 'utf8')
  }
  for (const dir of [paths.scenesDir, paths.historyDir, paths.blueprintHistoryDir]) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name)
      if (statSync(file).isFile()) snapshot[`file:${relative(paths.dir, file)}`] = readFileSync(file, 'utf8')
    }
  }
  return snapshot
}

export function diffProjectState(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const differences: string[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) differences.push(key)
  }
  return differences.sort()
}

export async function runProseWriter(options: ProseWriterOptions): Promise<ProseWriterResult> {
  const { paths, sceneId } = options
  const scenes = loadScenes(paths)
  const scene = scenes.find((candidate) => candidate.scene_id === sceneId)
  if (scene === undefined) {
    throw new ProseWriterError(`找不到 ${sceneId}（可用：${scenes.map((candidate) => candidate.scene_id).join(' / ')}）`)
  }
  const blueprint = loadBlueprint(paths)
  // seed 只用于检查层（例如未来的 open question 关联），这里显式读取以证明它在白名单内
  const seed = loadSeed(paths)

  // 受控上下文：唯一的故事信息入口（Story 6 的 Compiler）
  const context = compileContext({ paths, sceneId, userNotes: options.userNotes })
  const input = buildProseWriterInput(context)

  const contract = loadPromptContract(PROSE_WRITER_CONTRACT_ID, PROSE_WRITER_CONTRACT_VERSION)
  const styleSamplesText =
    context.writerContext.style_samples.length === 0
      ? '（本场没有匹配样本；不阻塞写作）'
      : context.writerContext.style_samples.map((sample) => `--- ${sample.sample_id} ---\n${sample.text}`).join('\n\n')
  const draftContextText =
    context.writerContext.draft_context === null
      ? '（无 Draft Context：本场是该 POV 的第一场）'
      : `（来自 ${context.writerContext.draft_context.scene_id} 的末尾 ${context.writerContext.draft_context.counted_code_points} 个非空白码点）\n${context.writerContext.draft_context.text}`

  const prompt = renderPrompt(contract, {
    writer_context: dumpYaml(input).trimEnd(),
    style_samples: styleSamplesText,
    draft_context: draftContextText,
  })

  const stateBefore = snapshotProjectState(paths)
  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出本场正文纯文本，不输出解释、标题或任何元数据。',
    temperature: 0.7,
  })

  const text = response.text.replace(/\s+$/u, '')
  const formatViolations = checkProseFormat(text)
  if (formatViolations.length > 0) {
    throw new ProseWriterError(
      `Writer 输出违反"纯正文"契约：\n- ${formatViolations.map((violation) => violation.message).join('\n- ')}`,
    )
  }

  const checks = checkProseConstraints({
    text,
    scene,
    blueprint,
    context,
    scenes,
    seed,
    originalSamples: context.writerContext.style_samples.map((sample) => ({
      sample_id: sample.sample_id,
      tags: { pov: context.writerContext.pov, scene_type: scene.scene_type, tone: scene.tone[0] as never },
      text: sample.original_text,
      de_entity: sample.de_entity,
      ...(sample.sanitized_text === undefined ? {} : { sanitized_text: sample.sanitized_text }),
    })),
  })

  // 硬校验：Writer 不得修改任何状态文件 / Blueprint / Scene
  const stateAfter = snapshotProjectState(paths)
  const stateDifferences = diffProjectState(stateBefore, stateAfter)
  if (stateDifferences.length > 0) {
    throw new ProseWriterError(`Writer 运行期间项目状态发生变化（不应发生）：${stateDifferences.join(', ')}`)
  }

  const draftPath = join(paths.draftsDir, `${sceneId}.md`)
  const dryRun = options.dryRun ?? false
  if (!dryRun) {
    writeTextFile(draftPath, `${text}\n`)
  }

  return {
    sceneId,
    text,
    countedCodePoints: countNonWhitespaceCodePoints(text),
    targetLength: scene.target_length,
    formatViolations,
    checks,
    context,
    prompt,
    inputSha256: hashContractInput(contract.id, contract.version, input),
    provider: response.provider,
    model: response.model,
    written: !dryRun,
    draftPath,
    rawOutput: response.text,
  }
}

export interface WriteAllResult {
  readonly results: readonly ProseWriterResult[]
  readonly failures: readonly { readonly sceneId: string; readonly message: string }[]
}

/** 按 `Scene.order` 逐场写作（Draft Context 依赖前序 Draft，因此必须按序）。 */
export async function runProseWriterAll(
  options: Omit<ProseWriterOptions, 'sceneId'>,
): Promise<WriteAllResult> {
  const results: ProseWriterResult[] = []
  const failures: { sceneId: string; message: string }[] = []
  for (const scene of loadScenes(options.paths)) {
    try {
      results.push(await runProseWriter({ ...options, sceneId: scene.scene_id }))
    } catch (error) {
      failures.push({ sceneId: scene.scene_id, message: (error as Error).message })
    }
  }
  return { results, failures }
}

export type { Scene, ProseCheckReport }
