#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PROJECT_FILE_NAMES, projectPaths } from '../io/paths.ts'
import {
  ProjectExistsError,
  createProject,
  loadProject,
  setRawSeedInput,
  type CreatedProject,
} from '../project/project.ts'
import {
  DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED,
  DRAFT_CONTEXT_MAX_CHARS_UNIT,
  TARGET_LENGTH_UNIT,
} from '../schema/project-config.ts'
import { runGate1, Gate1PreconditionError } from '../gate1/service.ts'
import { runStoryDeveloper, StoryDeveloperOutputError, UnresolvableSeedRefError } from '../developer/developer.ts'
import {
  Gate2ConflictPendingError,
  Gate2PreconditionError,
  collectKnownGate2ActionIds,
  collectKnownUserEditIds,
  runGate2,
} from '../gate2/service.ts'
import { BlueprintBuilderOutputError, Gate2PlanError, MERGEABLE_FIELDS } from '../gate2/builder.ts'
import { BlueprintValidationError } from '../schema/blueprint.ts'
import {
  SceneBreakdownOutputError,
  SceneBreakdownPreconditionError,
  SceneRerunRequiredError,
  loadCoverageReport,
  loadScenes,
  loadStoryState,
  runSceneBreakdown,
} from '../scenes/service.ts'
import { SceneValidationError } from '../schema/scene.ts'
import { CoverageValidationError } from '../scenes/coverage.ts'
import { StoryStateValidationError } from '../schema/story-state.ts'
import { unresolvedOrphans } from '../scenes/state.ts'
import { ContextCompileError, compileContext } from '../context/compiler.ts'
import {
  PROSE_WRITER_CONTRACT_ID,
  ProseWriterError,
  checkProseFormat,
  runProseWriter,
  runProseWriterAll,
} from '../writer/writer.ts'
import { ContextManifestValidationError } from '../schema/context-manifest.ts'
import {
  StyleProfileValidationError,
  createEmptyStyleProfile,
  nextSampleId,
  validateStyleProfile,
  type StyleProfile,
} from '../schema/style-profile.ts'
import { UnresolvedOrphanError } from '../scenes/state.ts'
import { SCENE_TYPES, TONE_TAGS } from '../core/scene-types.ts'
import { writeYamlFile } from '../io/yaml.ts'
import { readTextFile as readTextFileFromDisk, readYamlFile } from '../io/yaml.ts'
import { countNonWhitespaceCodePoints } from '../core/text.ts'
import { readdirSync } from 'node:fs'
import { Gate2MetaValidationError } from '../schema/gate2-meta.ts'
import { blueprintExists, loadBlueprint } from '../project/project.ts'
import { computeSeedPreservationRate, ProposalValidationError, conflictResolutionSchema } from '../schema/proposal.ts'
import { loadSeed, loadProposals, saveProposals, proposalsExist } from '../project/project.ts'
import { ProjectNotFoundError } from '../project/project.ts'
import { DEFAULT_RECORDED_FIXTURES_REL_PATH } from '../providers/index.ts'
import { Gate1OperationError, Gate1AlreadyClosedError, gate1OperationSchema, type Gate1Operation } from '../gate1/operations.ts'
import { PROVIDER_NAMES, resolveProvider, type ProviderName } from '../providers/index.ts'
import { ProviderConfigError, RecordedProviderMissError } from '../providers/types.ts'
import { InterpreterOutputError } from '../interpreter/schema.ts'
import { normalizeForEvidence } from '../interpreter/interpreter.ts'

/**
 * CLI 入口（Story 1 + Story 2）。
 *
 * Node 24 可直接执行 TypeScript，无需编译（`pnpm harness ...`）。
 * 命令面：init / seed set / seed show / config show（Story 1）
 *         gate1（Story 2，Seed Interpreter + Author Gate 1）
 *         develop（Story 3，Story Developer + Proposal）
 *         gate2 / blueprint show（Story 4，Blueprint Confirm / Merge / Edit）
 *         breakdown / scenes show / state show / coverage show（Story 5，Scene Breakdown + Story State + Coverage）
 *         context / style add / style show（Story 6，Context Compiler + Style Samples）
 *         write / drafts show（Story 7，Prose Writer）
 * Gate 3 的交互命令属于 Story 10。
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DEFAULT_PROJECTS_ROOT = resolve(REPO_ROOT, 'projects')

const USAGE = `Short-story-first Writing Harness v0.1 — 项目 / Seed / Gate 1

用法：
  harness init <projectId> [选项]       创建新短篇项目
  harness seed set <projectId> [选项]   保存 / 覆盖用户 raw input（Gate 1 之前）
  harness seed show <projectId> [选项]  显示 seed.yaml
  harness config show <projectId> [选项] 显示 project-config.yaml
  harness gate1 <projectId> [选项]      Seed Interpreter → Author Gate 1
  harness develop <projectId> [选项]    Story Developer → 2～3 个 Proposal
  harness proposals show <projectId>    显示 proposals.yaml 摘要与 Seed Preservation Rate
  harness gate2 <projectId> [选项]      Author Gate 2：确认 / 合并 / 手改 → Blueprint
  harness blueprint show <projectId>    显示当前 Blueprint 摘要
  harness breakdown <projectId> [选项]  Scene Breakdown → /scenes + story_state + coverage
  harness scenes show <projectId>       显示 Scene 列表摘要
  harness state show <projectId>        显示 story_state.yaml 摘要
  harness coverage show <projectId>     显示 coverage 报告（结构化 warning）
  harness context <projectId> [选项]    Context Compiler：为某个 Scene 编译受控上下文 + Manifest
  harness style add <projectId> [选项]  保存一个 Style Sample（SAMPLE_<NNN> 由 Harness 分配）
  harness style show <projectId>        显示 style/profile.yaml 摘要
  harness write <projectId> [选项]      Prose Writer：按 Scene 生成 drafts/scene-NNN.md
  harness drafts show <projectId>       显示已生成正文的长度与检查摘要
  harness help                          显示本帮助

通用选项：
  --projects-root <dir>   项目根目录（默认：${DEFAULT_PROJECTS_ROOT}）

init 选项：
  --title <text>          项目标题
  --target-length <n>     目标篇幅，单位：${TARGET_LENGTH_UNIT}（中文字数）
  --seed <text>           直接给出故事大概（一句话 / 多句话）
  --seed-file <path>      从文件读取故事大概（原样保留，含 Markdown）
  --now <iso8601>         注入创建时间（用于可复现的 golden 快照）

seed set 选项（二选一）：
  --text <text>           故事大概
  --file <path>           从文件读取（原样保留）

gate1 选项（必须给出一种选择）：
  --plan                  只读预览：运行 Interpreter 并打印分类，不写盘（Gate 1 非阻塞）
  --accept-all            接受全部（gate1_status=confirmed）
  --skip                  跳过 Gate 1（gate1_status=skipped）
  --op <spec>             修改操作，可重复：
                            promote:SEED_A001          ambiguous → fixed（source=user_gate1）
                            demote:SEED_F001           fixed → ambiguous（保留历史 anchor）
                            edit:SEED_F001=<新内容>     编辑条目
                            delete:SEED_A002           删除错误分类
  --provider <name>       ${PROVIDER_NAMES.join(' / ')}（默认 auto：有 fixtures 用 recorded，否则用环境变量）
  --fixtures <dir>        recorded fixture 目录（默认 tests/fixtures/recorded/seed-interpreter）

write 选项：
  --scene <scene-###>     只写这一场（默认按 order 逐场写全部）
  --note <文本>           降级路径：本场追加用户 director note（source=user_override，可重复）
  --plan                  只读预览：完整生成但不写 drafts/*.md
  --provider <name>       ${PROVIDER_NAMES.join(' / ')}
  --fixtures <dir>        recorded fixture 目录（默认 tests/fixtures/recorded/${PROSE_WRITER_CONTRACT_ID}）

context 选项：
  --scene <scene-###>     目标 Scene（必填）
  --all                   为全部 Scene 各编译一次（打印摘要；manifest 只写最后一个 Scene，见 I-45）
  --note <文本>           降级路径：为当前 Scene 追加用户 director note（source=user_override，可重复）
  --plan                  只读预览：完整编译但不写 reports/context-manifest.yaml
  --json                  以 JSON 输出 writer_context + manifest

style add 选项：
  --text <文本> | --file <path>   样本原文（原样保留）
  --pov <CH_X>            标签 pov（必填）
  --scene-type <类型>     标签 scene_type：${SCENE_TYPES.join(' / ')}（必填）
  --tone <标签>           标签 tone：${TONE_TAGS.join(' / ')}（必填）
  --sanitized <文本>      去实体化后的文本（给出即视为 de_entity=true）

breakdown 选项：
  --plan                  只读预览：完整解析但不写 /scenes、story_state、coverage
  --rerun                 显式重跑（覆盖 /scenes/*.yaml；confirmed_scenes 不变；消失的 scene 产生 ORPHANED）
  --note <scene-###>=<文本>  给某个 Scene 追加用户 director note（source=user；可重复）
  --provider <name>       ${PROVIDER_NAMES.join(' / ')}
  --fixtures <dir>        recorded fixture 目录（默认 tests/fixtures/recorded/scene_breakdown）

gate2 选项（三选一或组合）：
  --from <PROP_X>         以某个 Proposal 为全部字段来源（单来源确认）
  --field <字段>=<来源>   逐字段指定来源（来源为 PROP_X 或 user）；合并时必须覆盖全部字段
  --edit <字段>=<内容>    用户手写该字段（自动视为来源 user）
  --resolve <PROP_X:CONF_NNN>=<kept_user|changed_user|dropped>
                          裁决 USER_GIVEN 冲突（存在 pending 冲突时必须全部裁决）
  --plan                  只读预览：完整构建但不写 blueprint.yaml / 快照 / meta
  --provider <name>       ${PROVIDER_NAMES.join(' / ')}
  --fixtures <dir>        recorded fixture 目录（默认 tests/fixtures/recorded/blueprint_builder）

  可逐字段指定的字段：${MERGEABLE_FIELDS.join(' / ')}

develop 选项：
  --plan                  只读预览：生成 Proposal 但不写 proposals.yaml
  --style <text>          可选风格偏好（进入 Prompt Contract）
  --provider <name>       ${PROVIDER_NAMES.join(' / ')}
  --fixtures <dir>        recorded fixture 目录（默认 tests/fixtures/recorded/story_developer）

输出选项：
  --json                  以 JSON 输出

示例：
  pnpm harness init demo-01 --seed "一对情侣因为一件小事争吵，女方提出分手。"
  pnpm harness init demo-02 --seed-file tests/fixtures/seeds/markdown.md --title "微信"
  pnpm harness seed show demo-01
`

type CliValue = string | boolean | string[] | undefined

interface ParsedCli {
  readonly command: string | undefined
  readonly subcommand: string | undefined
  readonly projectId: string | undefined
  readonly values: Record<string, CliValue>
}

class UsageError extends Error {
  override readonly name = 'UsageError'
}

function parseCli(argv: string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'projects-root': { type: 'string' },
      title: { type: 'string' },
      'target-length': { type: 'string' },
      seed: { type: 'string' },
      'seed-file': { type: 'string' },
      now: { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
      plan: { type: 'boolean' },
      'accept-all': { type: 'boolean' },
      skip: { type: 'boolean' },
      op: { type: 'string', multiple: true },
      provider: { type: 'string' },
      fixtures: { type: 'string' },
      style: { type: 'string' },
      from: { type: 'string' },
      field: { type: 'string', multiple: true },
      edit: { type: 'string', multiple: true },
      resolve: { type: 'string', multiple: true },
      rerun: { type: 'boolean' },
      note: { type: 'string', multiple: true },
      scene: { type: 'string' },
      all: { type: 'boolean' },
      pov: { type: 'string' },
      'scene-type': { type: 'string' },
      tone: { type: 'string' },
      sanitized: { type: 'string' },
    },
  })
  const [command, second, third] = positionals
  const isSubcommandForm =
    command === 'seed' ||
    command === 'config' ||
    command === 'proposals' ||
    command === 'blueprint' ||
    command === 'scenes' ||
    command === 'state' ||
    command === 'coverage' ||
    command === 'style' ||
    command === 'drafts'
  return {
    command,
    subcommand: isSubcommandForm ? second : undefined,
    projectId: isSubcommandForm ? third : second,
    values: values as Record<string, CliValue>,
  }
}

function projectsRootOf(parsed: ParsedCli): string {
  const value = parsed.values['projects-root']
  return typeof value === 'string' ? resolve(value) : DEFAULT_PROJECTS_ROOT
}

function requireProjectId(parsed: ParsedCli): string {
  if (parsed.projectId === undefined || parsed.projectId.length === 0) {
    throw new UsageError('缺少 <projectId> 位置参数')
  }
  return parsed.projectId
}

function readTextFile(filePath: string): string {
  return readFileSync(resolve(filePath), { encoding: 'utf8' })
}

function printCreated(result: CreatedProject): void {
  const { seed, projectConfig } = result
  process.stdout.write(`已创建项目：${result.paths.dir}\n`)
  process.stdout.write(`  ${PROJECT_FILE_NAMES.seed}            schema_version=${seed.schema_version} gate1_status=${seed.story_seed.gate1_status}\n`)
  process.stdout.write(`  ${PROJECT_FILE_NAMES.projectConfig}   id=${projectConfig.project.id} created_at=${projectConfig.project.created_at}\n`)
  process.stdout.write(`  raw_input 字节数（UTF-8）：${Buffer.byteLength(seed.story_seed.raw_input, 'utf8')}\n`)
  process.stdout.write(
    `  draft_context: mode=${projectConfig.draft_context.mode} max_chars=${projectConfig.draft_context.max_chars}（推荐 ${DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED.min}～${DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED.max}）\n`,
  )
  for (const warning of result.warnings) {
    process.stdout.write(`  [warning] ${warning}\n`)
  }
}

function runInit(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const seedText = parsed.values['seed']
  const seedFile = parsed.values['seed-file']
  if (typeof seedText === 'string' && typeof seedFile === 'string') {
    throw new UsageError('--seed 与 --seed-file 只能给出一个')
  }
  const targetLengthRaw = parsed.values['target-length']
  const nowRaw = parsed.values['now']
  const title = parsed.values.title

  const result = createProject({
    projectsRoot: projectsRootOf(parsed),
    projectId,
    title: typeof title === 'string' ? title : null,
    targetLength: typeof targetLengthRaw === 'string' ? Number(targetLengthRaw) : null,
    rawInput: typeof seedText === 'string' ? seedText : typeof seedFile === 'string' ? readTextFile(seedFile) : '',
    now: typeof nowRaw === 'string' ? new Date(nowRaw) : undefined,
  })

  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    printCreated(result)
  }
  return 0
}

function runSeedSet(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const text = parsed.values.text
  const file = parsed.values.file
  if (typeof text === 'string' && typeof file === 'string') {
    throw new UsageError('--text 与 --file 只能给出一个')
  }
  if (typeof text !== 'string' && typeof file !== 'string') {
    throw new UsageError('seed set 需要 --text <text> 或 --file <path>')
  }
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const rawInput = typeof text === 'string' ? text : readTextFile(file as string)
  const seed = setRawSeedInput(paths, rawInput)
  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(seed, null, 2)}\n`)
  } else {
    process.stdout.write(`已保存 raw input：${paths.seed}\n`)
    process.stdout.write(`  gate1_status=${seed.story_seed.gate1_status}\n`)
  }
  return 0
}

function runSeedShow(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const { seed, paths } = loadProject(projectsRootOf(parsed), projectId)
  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(seed, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`# ${paths.seed}\n`)
  process.stdout.write(`schema_version: ${seed.schema_version}\n`)
  process.stdout.write(`gate1_status:   ${seed.story_seed.gate1_status}\n`)
  process.stdout.write(`anchors:        ${seed.story_seed.raw_seed_anchor_ids.length}\n`)
  process.stdout.write(`fixed/ambiguous/open_questions: ${seed.story_seed.fixed_by_user.length}/${seed.story_seed.ambiguous.length}/${seed.story_seed.open_questions.length}\n`)
  process.stdout.write('--- raw_input（原样） ---\n')
  process.stdout.write(seed.story_seed.raw_input)
  process.stdout.write('\n--- end raw_input ---\n')
  return 0
}

function runConfigShow(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const { projectConfig, paths } = loadProject(projectsRootOf(parsed), projectId)
  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(projectConfig, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`# ${paths.projectConfig}\n`)
  process.stdout.write(`schema_version: ${projectConfig.schema_version}\n`)
  process.stdout.write(`project: id=${projectConfig.project.id} title=${String(projectConfig.project.title)} target_length=${String(projectConfig.project.target_length)}（单位：${TARGET_LENGTH_UNIT}）\n`)
  for (const [key, enabled] of Object.entries(projectConfig.linter.rules)) {
    process.stdout.write(`linter.${key}: ${enabled ? 'on' : 'off'}\n`)
  }
  process.stdout.write(
    `draft_context: mode=${projectConfig.draft_context.mode} max_chars=${projectConfig.draft_context.max_chars}（口径：${DRAFT_CONTEXT_MAX_CHARS_UNIT}；OQ-16）\n`,
  )
  return 0
}


/** 解析 `--op` 规格文本（Story 2 Gate 1 的 6 种操作中除 accept_all / skip 之外的 4 种）。 */
export function parseGate1OperationSpec(spec: string): Gate1Operation {
  const trimmed = spec.trim()
  if (trimmed === 'accept_all' || trimmed === 'accept-all') return { kind: 'accept_all' }
  if (trimmed === 'skip') return { kind: 'skip' }
  const promote = /^promote:(\S+)$/.exec(trimmed)
  if (promote !== null) return gate1OperationSchema.parse({ kind: 'promote', id: promote[1] })
  const demote = /^demote:(\S+)$/.exec(trimmed)
  if (demote !== null) return gate1OperationSchema.parse({ kind: 'demote', id: demote[1] })
  const remove = /^delete:(\S+)$/.exec(trimmed)
  if (remove !== null) return gate1OperationSchema.parse({ kind: 'delete', id: remove[1] })
  const edit = /^edit:(\S+?)=([\s\S]+)$/.exec(trimmed)
  if (edit !== null) return gate1OperationSchema.parse({ kind: 'edit', id: edit[1], value: edit[2] })
  throw new UsageError(
    `无法解析 --op "${spec}"；支持：promote:SEED_A001 / demote:SEED_F001 / edit:SEED_F001=<新内容> / delete:SEED_A002`,
  )
}

function printInterpreterPreview(result: Awaited<ReturnType<typeof runGate1>>): void {
  const { interpreter } = result
  process.stdout.write(`provider=${interpreter.provider} model=${interpreter.model} contract=${interpreter.contract}@${interpreter.contractVersion}\n`)
  process.stdout.write(`input_sha256=${interpreter.inputSha256}\n\n`)
  const sections: Array<[string, typeof interpreter.fixed_by_user]> = [
    ['fixed_by_user（用户明确说的）', interpreter.fixed_by_user],
    ['ambiguous（模糊的）', interpreter.ambiguous],
    ['open_questions（未决定的）', interpreter.open_questions],
  ]
  for (const [label, items] of sections) {
    process.stdout.write(`${label}：${items.length} 条\n`)
    for (const item of items) {
      const evidence = item.evidence === '' ? '（无原文片段）' : `原文：「${item.evidence}」`
      process.stdout.write(`  - ${item.id}  ${item.value}    ${evidence}\n`)
    }
  }
  for (const notice of interpreter.notices) {
    process.stdout.write(`  [${notice.code}] ${notice.message}\n`)
  }
}

async function runGate1Command(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const operations: Gate1Operation[] = []
  if (parsed.values['accept-all'] === true) operations.push({ kind: 'accept_all' })
  if (parsed.values.skip === true) operations.push({ kind: 'skip' })
  const opValues = parsed.values.op
  if (Array.isArray(opValues)) {
    for (const spec of opValues) operations.push(parseGate1OperationSpec(spec))
  }

  const providerNameRaw = parsed.values.provider
  const providerName = typeof providerNameRaw === 'string' ? (providerNameRaw as ProviderName) : 'auto'
  const fixturesRaw = parsed.values.fixtures
  const resolved = resolveProvider({
    name: providerName,
    fixturesDir: typeof fixturesRaw === 'string' ? resolve(fixturesRaw) : undefined,
    repoRoot: REPO_ROOT,
  })

  const result = await runGate1({
    paths,
    provider: resolved.provider,
    operations,
    dryRun: parsed.values.plan === true,
  })

  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify({ provider: resolved.name, ...result }, null, 2)}\n`)
    return 0
  }

  printInterpreterPreview(result)

  if (parsed.values.plan === true) {
    process.stdout.write('\n[plan] 只读预览：未写盘、未改变 gate1_status（Gate 1 非阻塞，需求规格 §5.1）\n')
    process.stdout.write(`[plan] 若确认，可执行：--accept-all / --skip / --op ...\n`)
    return 0
  }

  process.stdout.write('\nGate 1 已应用：\n')
  for (const description of result.descriptions) {
    process.stdout.write(`  - ${description}\n`)
  }
  process.stdout.write(`  - raw_seed_anchor_ids 未改变：[${result.anchorsAfter.join(', ')}]（需求规格 §8.2）\n`)
  process.stdout.write(`已写入：${paths.seed}\n`)
  return 0
}


function providerFor(parsed: ParsedCli, defaultFixtureSubdir: string): ReturnType<typeof resolveProvider> {
  const providerNameRaw = parsed.values.provider
  const providerName = typeof providerNameRaw === 'string' ? (providerNameRaw as ProviderName) : 'auto'
  const fixturesRaw = parsed.values.fixtures
  return resolveProvider({
    name: providerName,
    fixturesDir:
      typeof fixturesRaw === 'string' ? resolve(fixturesRaw) : join(REPO_ROOT, DEFAULT_RECORDED_FIXTURES_REL_PATH, '..', defaultFixtureSubdir),
    repoRoot: REPO_ROOT,
  })
}

function printProposalSummary(
  result: Awaited<ReturnType<typeof runStoryDeveloper>>,
  rawSeedAnchorIds: readonly string[],
): void {
  process.stdout.write(`provider=${result.provider} model=${result.model} contract=${result.contract}@${result.contractVersion}\n`)
  process.stdout.write(`input_sha256=${result.inputSha256}\n\n`)
  for (const proposal of result.file.proposals) {
    const rate = computeSeedPreservationRate(proposal, rawSeedAnchorIds)
    process.stdout.write(`${proposal.proposal_id}  ${proposal.title}（${proposal.genre}）\n`)
    process.stdout.write(`  核心冲突：${proposal.core_conflict}\n`)
    process.stdout.write(`  真相/转折：${proposal.truth_or_turn}\n`)
    process.stdout.write(`  结局：${proposal.ending}\n`)
    process.stdout.write(`  POV：${proposal.pov.join(' / ')}  目标篇幅：${proposal.target_length}\n`)
    process.stdout.write(
      `  seed_fidelity：preserved ${proposal.seed_fidelity.preserved.length} / altered ${proposal.seed_fidelity.altered.length} / added ${proposal.seed_fidelity.added.length} / risk ${proposal.seed_fidelity.risk.length}\n`,
    )
    process.stdout.write(
      `  conflicts：${proposal.conflicts.length}${proposal.conflicts.length === 0 ? '' : `（${proposal.conflicts.map((conflict) => `${conflict.id}:${conflict.resolution}`).join(', ')}）`}\n`,
    )
    process.stdout.write(
      `  Seed Preservation Rate：${rate.rate === null ? 'null' : `${rate.rate_percent}%`}（${rate.numerator}/${rate.denominator}）\n`,
    )
  }
  for (const notice of result.notices) {
    process.stdout.write(`  [${notice.code}] ${notice.message}\n`)
  }
}

async function runDevelopCommand(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const seed = loadSeed(paths)
  const resolved = providerFor(parsed, 'story_developer')
  const styleRaw = parsed.values.style

  const result = await runStoryDeveloper({
    provider: resolved.provider,
    seed,
    stylePreference: typeof styleRaw === 'string' ? styleRaw : undefined,
  })

  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify({ ...result, provider_name: resolved.name, written: parsed.values.plan !== true }, null, 2)}\n`)
  } else {
    printProposalSummary(result, seed.story_seed.raw_seed_anchor_ids)
  }

  if (parsed.values.plan === true) {
    process.stdout.write('\n[plan] 只读预览：未写 proposals.yaml\n')
    return 0
  }
  saveProposals(paths, result.file)
  process.stdout.write(`\n已写入：${paths.proposals}\n`)
  return 0
}

async function runProposalsShowCommand(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const seed = loadSeed(paths)
  const file = loadProposals(paths)
  if (parsed.values.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...file,
          preservation: file.proposals.map((proposal) =>
            computeSeedPreservationRate(proposal, seed.story_seed.raw_seed_anchor_ids),
          ),
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }
  process.stdout.write(`# ${paths.proposals}\nschema_version: ${file.schema_version}\nproposals: ${file.proposals.length}\n\n`)
  for (const proposal of file.proposals) {
    const rate = computeSeedPreservationRate(proposal, seed.story_seed.raw_seed_anchor_ids)
    process.stdout.write(
      `${proposal.proposal_id}  ${proposal.title}  SPR=${rate.rate === null ? 'null' : `${rate.rate_percent}%`} (${rate.numerator}/${rate.denominator})  conflicts=${proposal.conflicts.length}\n`,
    )
  }
  return 0
}


function parseKeyValueList(
  values: string[] | undefined,
  flag: string,
  options: { allowEmpty?: boolean } = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  if (values === undefined) return result
  for (const raw of values) {
    const index = raw.indexOf('=')
    if (index <= 0) {
      throw new UsageError(`${flag} 需要 <键>=<值> 形式，收到 "${raw}"`)
    }
    const key = raw.slice(0, index).trim()
    const value = raw.slice(index + 1)
    if (options.allowEmpty !== true && value.trim() === '') {
      throw new UsageError(`${flag} 的值不能为空："${raw}"`)
    }
    result[key] = value
  }
  return result
}

function printBlueprintSummary(result: Awaited<ReturnType<typeof runGate2>>): void {
  const { blueprint, meta, provenance, plan } = result
  process.stdout.write(`provider=${result.provider} model=${result.model} blueprint_version=${blueprint.blueprint_version}\n`)
  process.stdout.write(`mode=${plan.mode} gate2_action_id=${meta.gate2_action_id} 参与提案=${plan.participatingProposalIds.join(' / ') || '（无，用户手写）'}\n`)
  process.stdout.write(`input_sha256=${result.inputSha256}\n\n`)
  process.stdout.write(`title: ${blueprint.meta.title}（${blueprint.meta.genre}）  pov: ${blueprint.meta.pov.join(' / ')}  target_length: ${blueprint.meta.target_length}\n`)
  process.stdout.write(`premise: ${blueprint.premise.value}\n`)
  process.stdout.write(`core_conflict: ${blueprint.core_conflict.value}\n`)
  process.stdout.write(`characters: ${blueprint.characters.map((character) => `${character.id}(内心可见=${character.inner_state_pov_visible.join(',')})`).join(' / ')}\n`)
  process.stdout.write(`key_knowledge: ${blueprint.key_knowledge.length} 条  foreshadowing: ${blueprint.foreshadowing.length} 条\n`)
  process.stdout.write(`seed_fidelity: preserved ${blueprint.seed_fidelity.preserved.length} / altered ${blueprint.seed_fidelity.altered.length} / added ${blueprint.seed_fidelity.added.length} / risk ${blueprint.seed_fidelity.risk.length}\n\n`)
  process.stdout.write('字段来源：\n')
  for (const entry of provenance) {
    process.stdout.write(`  ${entry.field} ← ${entry.from}  [${entry.source_refs.map((ref) => `${ref.type}:${ref.ref_id}`).join(', ')}]\n`)
  }
  if (result.userEdits.length > 0) {
    process.stdout.write(`user_edits: ${result.userEdits.map((edit) => `${edit.id}(${edit.field})`).join(', ')}\n`)
  }
  if (result.conflictResolutions.length > 0) {
    process.stdout.write(`冲突裁决：${result.conflictResolutions.map((record) => `${record.proposal_id}.${record.id}=${record.resolution}`).join(', ')}\n`)
  }
}

async function runGate2Command(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const fromRaw = parsed.values.from
  const fields = parseKeyValueList(parsed.values.field as string[] | undefined, '--field')
  const edits = parseKeyValueList(parsed.values.edit as string[] | undefined, '--edit')
  const resolutions = parseKeyValueList(parsed.values.resolve as string[] | undefined, '--resolve')
  const resolved = providerFor(parsed, 'blueprint_builder')

  const result = await runGate2({
    paths,
    provider: resolved.provider,
    fromProposal: typeof fromRaw === 'string' ? fromRaw : undefined,
    fields,
    edits,
    resolutions,
    dryRun: parsed.values.plan === true,
  })

  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify({ ...result, provider_name: resolved.name }, null, 2)}\n`)
    return 0
  }

  printBlueprintSummary(result)
  if (result.written) {
    process.stdout.write(`\n已写入当前版本：${result.paths.blueprint}\n`)
    process.stdout.write(`快照：${result.paths.snapshot}\n`)
    process.stdout.write(`Gate 2 元数据：${result.paths.meta}\n`)
    process.stdout.write(`（可解析的 user_edit IDs：${collectKnownUserEditIds(paths).join(', ') || '无'}；Gate 2 动作：${collectKnownGate2ActionIds(paths).join(', ')}）\n`)
  } else {
    process.stdout.write('\n[plan] 只读预览：未写 blueprint.yaml / 快照 / meta\n')
  }
  return 0
}

function runBlueprintShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  if (!blueprintExists(paths)) {
    throw new ProjectNotFoundError(`找不到 ${paths.blueprint}（尚未执行 Gate 2）`)
  }
  const blueprint = loadBlueprint(paths)
  process.stdout.write(`# ${paths.blueprint}\nschema_version: ${blueprint.schema_version}\nblueprint_version: ${blueprint.blueprint_version}\n`)
  process.stdout.write(`title: ${blueprint.meta.title}（${blueprint.meta.genre}）\npov: ${blueprint.meta.pov.join(' / ')}\ntarget_length: ${blueprint.meta.target_length}\n`)
  process.stdout.write(`premise: ${blueprint.premise.value}\ncore_conflict: ${blueprint.core_conflict.value}\n`)
  process.stdout.write(`structure: ${Object.values(blueprint.structure).map((item) => item.id).join(' / ')}\n`)
  process.stdout.write(`key_knowledge: ${blueprint.key_knowledge.map((item) => `${item.id}@${item.reveal_at_structure}#${item.reveal_order}`).join(' / ') || '（无）'}\n`)
  process.stdout.write(`foreshadowing: ${blueprint.foreshadowing.map((item) => `${item.id}(${item.setup_at_structure}→${item.payoff_at_structure})`).join(' / ') || '（无）'}\n`)
  process.stdout.write(`seed_fidelity: preserved ${blueprint.seed_fidelity.preserved.length} / altered ${blueprint.seed_fidelity.altered.length} / added ${blueprint.seed_fidelity.added.length} / risk ${blueprint.seed_fidelity.risk.length}\n`)
  return 0
}


function parseNotes(values: string[] | undefined): Record<string, string[]> {
  const notes: Record<string, string[]> = {}
  for (const raw of values ?? []) {
    const index = raw.indexOf('=')
    if (index <= 0) throw new UsageError(`--note 需要 <scene-###>=<文本> 形式，收到 "${raw}"`)
    const key = raw.slice(0, index).trim()
    const value = raw.slice(index + 1).trim()
    if (value === '') throw new UsageError(`--note 的文本不能为空："${raw}"`)
    notes[key] = [...(notes[key] ?? []), value]
  }
  return notes
}

function printBreakdownSummary(result: Awaited<ReturnType<typeof runSceneBreakdown>>): void {
  process.stdout.write(`provider=${result.provider} model=${result.model} blueprint_version=${result.coverage.blueprint_version}\n`)
  process.stdout.write(`scenes=${result.scenes.length} input_sha256=${result.inputSha256}\n\n`)
  for (const scene of result.scenes) {
    const reveals = scene.allowed_reveals.length > 0 ? ` allowed_reveals=${scene.allowed_reveals.join(',')}` : ''
    process.stdout.write(
      `${scene.scene_id}  order=${scene.order}  ${scene.scene_type}  pov=${scene.pov}  ${scene.narrative_role_ref}  ${scene.target_length}字${reveals}\n`,
    )
    process.stdout.write(`    purpose: ${scene.purpose}\n`)
    process.stdout.write(`    ${scene.start_state} → ${scene.conflict} → ${scene.turn} → ${scene.end_state}\n`)
    if (scene.proposed_additions.length > 0) {
      process.stdout.write(`    proposed_additions（永久 PROPOSED）: ${scene.proposed_additions.map((item) => item.value).join(' / ')}\n`)
    }
    if (scene.director_notes.length > 0) {
      process.stdout.write(`    director_notes: ${scene.director_notes.map((note) => `${note.id}[${note.source}]`).join(', ')}\n`)
    }
  }
  process.stdout.write('\nCoverage：\n')
  process.stdout.write(
    `  structure ${result.coverage.summary.structure_covered}/5  arc ${result.coverage.summary.arc_covered}/3  reveals ${result.coverage.summary.reveals_resolved}/${result.coverage.summary.reveals_planned}  合计篇幅 ${result.coverage.summary.total_target_length}\n`,
  )
  for (const warning of result.coverage.warnings) {
    process.stdout.write(`  [${warning.severity}] ${warning.id} ${warning.type}: ${warning.message}\n`)
  }
  if (result.coverage.warnings.length === 0) {
    process.stdout.write('  （无 warning）\n')
  }
  const orphans = unresolvedOrphans(result.state)
  if (orphans.length > 0) {
    process.stdout.write(`\n未处理的 ORPHANED 重建冲突（禁止 Context Compile，§17.3）：${orphans.map((item) => item.id).join(', ')}\n`)
  }
}

async function runBreakdownCommand(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const userNotes = parseNotes(parsed.values.note as string[] | undefined)
  const resolved = providerFor(parsed, 'scene_breakdown')

  const result = await runSceneBreakdown({
    paths,
    provider: resolved.provider,
    userNotes,
    rerun: parsed.values.rerun === true,
    dryRun: parsed.values.plan === true,
  })

  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify({ ...result, provider_name: resolved.name }, null, 2)}\n`)
  } else {
    printBreakdownSummary(result)
  }

  if (result.written) {
    process.stdout.write(`\n已写入：${result.paths.scenesDir}/*.yaml\n`)
    process.stdout.write(`Story State：${result.paths.storyState}\n`)
    process.stdout.write(`Coverage：${result.paths.coverage}\n`)
  } else {
    process.stdout.write('\n[plan] 只读预览：未写 /scenes、story_state.yaml、reports/coverage.yaml\n')
  }
  return 0
}

function runScenesShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const scenes = loadScenes(paths)
  if (scenes.length === 0) {
    process.stdout.write('（没有 Scene；请先执行 harness breakdown）\n')
    return 0
  }
  process.stdout.write(`# ${paths.scenesDir}（${scenes.length} 个 Scene）\n`)
  for (const scene of scenes) {
    process.stdout.write(
      `${scene.scene_id}  order=${scene.order}  ${scene.scene_type}  pov=${scene.pov}  ${scene.narrative_role_ref}  ${scene.target_length}字  allowed_reveals=${scene.allowed_reveals.join(',') || '-'}\n`,
    )
  }
  return 0
}

function runStateShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const state = loadStoryState(paths)
  if (state === null) {
    process.stdout.write('（没有 story_state.yaml；请先执行 harness breakdown）\n')
    return 0
  }
  process.stdout.write(`# ${paths.storyState}\nschema_version: ${state.schema_version}\nblueprint_version: ${state.blueprint_version}\n`)
  process.stdout.write(`confirmed_scenes: ${state.confirmed_scenes.join(', ') || '（空）'}\n`)
  process.stdout.write(`occurred: ${state.occurred.length} 条\n`)
  process.stdout.write(`knowledge_state: ${state.knowledge_state.map((item) => `${item.blueprint_ref}(reveal=${item.occurred_reveal}, scene=${item.last_updated_scene ?? '-'})`).join(' / ')}\n`)
  process.stdout.write(`relationship_state: ${state.relationship_state.map((item) => `${item.blueprint_ref}=${item.state}`).join(' / ') || '（空）'}\n`)
  process.stdout.write(`open_questions: ${state.open_questions.map((item) => `${item.seed_ref}=${item.state}`).join(' / ') || '（空）'}\n`)
  process.stdout.write(`foreshadowing_state: ${state.foreshadowing_state.map((item) => `${item.blueprint_ref}(${item.resolved_setup_scene ?? '-'}→${item.resolved_payoff_scene ?? '-'}:${item.state})`).join(' / ') || '（空）'}\n`)
  process.stdout.write(`state_rebuild_conflicts: ${state.state_rebuild_conflicts.length} 条（未处理 ${unresolvedOrphans(state).length} 条）\n`)
  return 0
}

function runCoverageShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const report = loadCoverageReport(paths)
  if (report === null) {
    process.stdout.write('（没有 coverage 报告；请先执行 harness breakdown）\n')
    return 0
  }
  process.stdout.write(`# ${paths.coverageReport}\nschema_version: ${report.schema_version}\nblueprint_version: ${report.blueprint_version}\n`)
  process.stdout.write(
    `summary: scenes=${report.summary.scenes} structure=${report.summary.structure_covered}/5 arc=${report.summary.arc_covered}/3 reveals=${report.summary.reveals_resolved}/${report.summary.reveals_planned} refs=${report.summary.references_checked} length=${report.summary.total_target_length}\n`,
  )
  for (const warning of report.warnings) {
    process.stdout.write(`[${warning.severity}] ${warning.id} ${warning.type} ${warning.refs.join(',')}\n    ${warning.message}\n`)
  }
  if (report.warnings.length === 0) process.stdout.write('（无 warning）\n')
  return 0
}


function printContextSummary(
  result: ReturnType<typeof compileContext>,
  sceneId: string,
): void {
  const { writerContext, manifest } = result
  process.stdout.write(`scene_id=${sceneId} pov=${writerContext.pov} blueprint_version=${manifest.blueprint_version}\n`)
  process.stdout.write(`scene_type=${writerContext.scene.scene_type} narrative_role_ref=${writerContext.scene.narrative_role_ref}\n`)
  process.stdout.write(`characters（内心可见性由 inner_state_pov_visible 物理决定）：\n`)
  for (const character of writerContext.characters) {
    process.stdout.write(
      `  ${character.id}  内心=${character.inner_state === undefined ? '不可见' : '可见'}  hints=${character.observable_behavior_hints.map((hint) => hint.id).join(',') || '-'}\n`,
    )
  }
  process.stdout.write(`allowed_reveals: ${writerContext.allowed_reveals.map((reveal) => reveal.id).join(',') || '（本场无）'}\n`)
  process.stdout.write(`已知 K（开场）：${writerContext.known_knowledge_ids.join(', ') || '（无）'}\n`)
  process.stdout.write(`style_samples: ${manifest.style_samples.map((sample) => `${sample.sample_id}[${sample.matched_on.join('+') || 'none'}]`).join(', ') || '（无匹配，不阻塞）'}\n`)
  process.stdout.write(`director_surface: ${manifest.director_surface.map((entry) => `${entry.id}[${entry.source}]`).join(', ')}\n`)
  process.stdout.write(`draft_context: ${writerContext.draft_context === null ? '（无；首个该 POV Scene 或没有 Draft）' : `${writerContext.draft_context.scene_id} 末尾 ${writerContext.draft_context.counted_code_points} 个非空白码点`}\n`)
  process.stdout.write(`included_sensitive: ${manifest.included_sensitive.length} 条  excluded_sensitive: ${manifest.excluded_sensitive.length} 条\n`)
  process.stdout.write(`future_content_exposed=${manifest.future_content_exposed} unconfirmed_proposal_exposed=${manifest.unconfirmed_proposal_exposed}\n`)
  if (manifest.overrides.length > 0) {
    process.stdout.write(`overrides: ${manifest.overrides.map((override) => `${override.id}→${override.director_surface_ref}`).join(', ')}\n`)
  }
}

function runContextCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const notes = (parsed.values.note as string[] | undefined) ?? []
  const all = parsed.values.all === true
  const sceneRaw = parsed.values.scene

  const sceneIds = all
    ? loadScenes(paths).map((scene) => scene.scene_id)
    : [typeof sceneRaw === 'string' ? sceneRaw : (() => {
        throw new UsageError('context 需要 --scene <scene-###> 或 --all')
      })()]

  const results = sceneIds.map((sceneId) =>
    compileContext({ paths, sceneId, userNotes: notes }),
  )

  if (parsed.values.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        results.length === 1
          ? results[0]
          : results.map((result) => ({ scene_id: result.manifest.scene_id, manifest: result.manifest })),
        null,
        2,
      )}\n`,
    )
  } else {
    results.forEach((result) => {
      printContextSummary(result, result.manifest.scene_id)
      process.stdout.write('\n')
    })
  }

  const last = results[results.length - 1] as ReturnType<typeof compileContext>
  if (parsed.values.plan === true) {
    process.stdout.write('[plan] 只读预览：未写 reports/context-manifest.yaml\n')
    return 0
  }
  writeYamlFile(paths.contextManifestReport, last.manifest, {
    headerComments: [
      `Last compiled scene: ${last.manifest.scene_id}`,
      `OQ-49：Manifest 为单文件、末次覆盖；完整 writer_context 不落盘（见 docs/DECISIONS.md I-44 / I-45）`,
    ],
  })
  process.stdout.write(`已写入 Manifest：${paths.contextManifestReport}（scene_id=${last.manifest.scene_id}）\n`)
  return 0
}

function loadStyleProfileOrEmpty(paths: ReturnType<typeof projectPaths>): StyleProfile {
  return existsSync(paths.styleProfile) ? validateStyleProfile(readYamlFile(paths.styleProfile)) : createEmptyStyleProfile()
}

function runStyleAddCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const textRaw = parsed.values.text
  const fileRaw = parsed.values.file
  if (typeof textRaw === 'string' && typeof fileRaw === 'string') {
    throw new UsageError('--text 与 --file 只能给出一个')
  }
  const text = typeof textRaw === 'string' ? textRaw : typeof fileRaw === 'string' ? readTextFile(fileRaw) : undefined
  if (text === undefined || text.length === 0) {
    throw new UsageError('style add 需要 --text <文本> 或 --file <path>')
  }
  const pov = parsed.values.pov
  const sceneType = parsed.values['scene-type']
  const tone = parsed.values.tone
  const sanitized = parsed.values.sanitized
  if (typeof pov !== 'string' || typeof sceneType !== 'string' || typeof tone !== 'string') {
    throw new UsageError('style add 需要 --pov / --scene-type / --tone 三个标签')
  }

  const profile = loadStyleProfileOrEmpty(paths)
  const sampleId = nextSampleId(profile)
  const sample = {
    sample_id: sampleId,
    tags: { pov, scene_type: sceneType, tone },
    text,
    de_entity: typeof sanitized === 'string',
    ...(typeof sanitized === 'string' ? { sanitized_text: sanitized } : {}),
  }
  const next = validateStyleProfile({ ...profile, samples: [...profile.samples, sample] })
  writeYamlFile(paths.styleProfile, next)
  process.stdout.write(`已保存样本 ${sampleId}（tags: pov=${pov} scene_type=${sceneType} tone=${tone}；de_entity=${String(sample.de_entity)}）\n`)
  process.stdout.write(`已写入：${paths.styleProfile}\n`)
  return 0
}

function runStyleShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const profile = loadStyleProfileOrEmpty(paths)
  process.stdout.write(`# ${paths.styleProfile}\nschema_version: ${profile.schema_version}\nsamples: ${profile.samples.length}\n`)
  for (const sample of profile.samples) {
    process.stdout.write(
      `${sample.sample_id}  pov=${sample.tags.pov} scene_type=${sample.tags.scene_type} tone=${sample.tags.tone} de_entity=${String(sample.de_entity)}\n`,
    )
  }
  return 0
}


function printWriterSummary(result: Awaited<ReturnType<typeof runProseWriter>>): void {
  process.stdout.write(
    `${result.sceneId}  正文 ${result.countedCodePoints} 个非空白码点 / 目标 ${result.targetLength}  pov=${result.context.writerContext.pov}\n`,
  )
  process.stdout.write(`  style_samples: ${result.context.manifest.style_samples.map((sample) => sample.sample_id).join(', ') || '（无）'}\n`)
  process.stdout.write(`  draft_context: ${result.context.writerContext.draft_context === null ? '（无）' : result.context.writerContext.draft_context.scene_id}\n`)
  for (const sample of result.context.manifest.style_samples) {
    if (sample.entity_reminder !== undefined) {
      process.stdout.write(`  [human-review] ${sample.sample_id}: ${sample.entity_reminder}\n`)
    }
  }
  for (const finding of result.checks.hardFailures) {
    process.stdout.write(`  [hard] ${finding.code}: ${finding.message}\n`)
  }
  for (const finding of result.checks.warnings) {
    process.stdout.write(`  [warning] ${finding.code}: ${finding.message}\n`)
  }
  if (result.checks.hardFailures.length === 0 && result.checks.warnings.length === 0) {
    process.stdout.write('  （硬检查与软检查均无发现）\n')
  }
}

async function runWriteCommand(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const notes = (parsed.values.note as string[] | undefined) ?? []
  const resolved = providerFor(parsed, PROSE_WRITER_CONTRACT_ID)
  const sceneRaw = parsed.values.scene
  const dryRun = parsed.values.plan === true

  if (typeof sceneRaw === 'string') {
    const result = await runProseWriter({
      paths,
      provider: resolved.provider,
      sceneId: sceneRaw,
      userNotes: notes,
      dryRun,
    })
    if (parsed.values.json === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      printWriterSummary(result)
    }
    process.stdout.write(result.written ? `已写入：${result.draftPath}\n` : '[plan] 只读预览：未写 drafts/*.md\n')
    if (result.checks.hardFailures.length > 0) return 1
    return 0
  }

  const all = await runProseWriterAll({ paths, provider: resolved.provider, userNotes: notes, dryRun })
  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`)
  } else {
    all.results.forEach((result) => {
      printWriterSummary(result)
      process.stdout.write('\n')
    })
    for (const failure of all.failures) {
      process.stdout.write(`[失败] ${failure.sceneId}: ${failure.message}\n`)
    }
  }
  process.stdout.write(
    dryRun
      ? `[plan] 只读预览：${all.results.length} 场已生成，未写盘\n`
      : `已写入 ${all.results.length} 个 Draft 到 ${paths.draftsDir}（失败 ${all.failures.length} 场）\n`,
  )
  return all.failures.length === 0 ? 0 : 1
}

function runDraftsShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  if (!existsSync(paths.draftsDir)) {
    process.stdout.write('（没有 drafts 目录；请先执行 harness write）\n')
    return 0
  }
  const files = readdirSync(paths.draftsDir).filter((name) => /^scene-\d{3}\.md$/.test(name)).sort()
  if (files.length === 0) {
    process.stdout.write('（没有正文；请先执行 harness write）\n')
    return 0
  }
  process.stdout.write(`# ${paths.draftsDir}（${files.length} 个已知正文）\n`)
  for (const name of files) {
    const text = readTextFileFromDisk(join(paths.draftsDir, name))
    const counted = countNonWhitespaceCodePoints(text)
    const formatIssues = checkProseFormat(text)
    process.stdout.write(
      `${name}  ${counted} 个非空白码点  段落 ${text.split(/\n\s*\n/).filter((block) => block.trim() !== '').length}  格式问题 ${formatIssues.length}\n`,
    )
  }
  return 0
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv)

  if (parsed.values.help === true || parsed.command === undefined || parsed.command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }

  switch (parsed.command) {
    case 'init':
      return runInit(parsed)
    case 'seed':
      if (parsed.subcommand === 'set') return runSeedSet(parsed)
      if (parsed.subcommand === 'show') return runSeedShow(parsed)
      throw new UsageError(`未知子命令：seed ${parsed.subcommand ?? ''}`)
    case 'config':
      if (parsed.subcommand === 'show') return runConfigShow(parsed)
      throw new UsageError(`未知子命令：config ${parsed.subcommand ?? ''}`)
    case 'gate1':
      return runGate1Command(parsed)
    case 'develop':
      return runDevelopCommand(parsed)
    case 'proposals':
      if (parsed.subcommand === 'show') return runProposalsShowCommand(parsed)
      throw new UsageError(`未知子命令：proposals ${parsed.subcommand ?? ''}`)
    case 'gate2':
      return runGate2Command(parsed)
    case 'blueprint':
      if (parsed.subcommand === 'show') return runBlueprintShowCommand(parsed)
      throw new UsageError(`未知子命令：blueprint ${parsed.subcommand ?? ''}`)
    case 'breakdown':
      return runBreakdownCommand(parsed)
    case 'scenes':
      if (parsed.subcommand === 'show') return runScenesShowCommand(parsed)
      throw new UsageError(`未知子命令：scenes ${parsed.subcommand ?? ''}`)
    case 'state':
      if (parsed.subcommand === 'show') return runStateShowCommand(parsed)
      throw new UsageError(`未知子命令：state ${parsed.subcommand ?? ''}`)
    case 'coverage':
      if (parsed.subcommand === 'show') return runCoverageShowCommand(parsed)
      throw new UsageError(`未知子命令：coverage ${parsed.subcommand ?? ''}`)
    case 'context':
      return runContextCommand(parsed)
    case 'write':
      return runWriteCommand(parsed)
    case 'drafts':
      if (parsed.subcommand === 'show') return runDraftsShowCommand(parsed)
      throw new UsageError(`未知子命令：drafts ${parsed.subcommand ?? ''}`)
    case 'style':
      if (parsed.subcommand === 'add') return runStyleAddCommand(parsed)
      if (parsed.subcommand === 'show') return runStyleShowCommand(parsed)
      throw new UsageError(`未知子命令：style ${parsed.subcommand ?? ''}`)
    default:
      throw new UsageError(`未知命令：${parsed.command}`)
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`用法错误：${error.message}\n\n${USAGE}`)
    process.exitCode = 2
  } else if (
    error instanceof ProjectExistsError ||
    error instanceof Gate1OperationError ||
    error instanceof Gate1AlreadyClosedError ||
    error instanceof Gate1PreconditionError ||
    error instanceof ProviderConfigError ||
    error instanceof RecordedProviderMissError ||
    error instanceof InterpreterOutputError ||
    error instanceof StoryDeveloperOutputError ||
    error instanceof UnresolvableSeedRefError ||
    error instanceof ProposalValidationError ||
    error instanceof ProjectNotFoundError ||
    error instanceof Gate2PlanError ||
    error instanceof Gate2ConflictPendingError ||
    error instanceof Gate2PreconditionError ||
    error instanceof BlueprintBuilderOutputError ||
    error instanceof BlueprintValidationError ||
    error instanceof Gate2MetaValidationError ||
    error instanceof SceneBreakdownOutputError ||
    error instanceof SceneBreakdownPreconditionError ||
    error instanceof SceneRerunRequiredError ||
    error instanceof SceneValidationError ||
    error instanceof CoverageValidationError ||
    error instanceof StoryStateValidationError ||
    error instanceof ContextCompileError ||
    error instanceof ContextManifestValidationError ||
    error instanceof StyleProfileValidationError ||
    error instanceof UnresolvedOrphanError ||
    error instanceof ProseWriterError
  ) {
    process.stderr.write(`错误：${error.message}\n`)
    process.exitCode = 1
  } else {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`错误：${message}\n`)
    process.exitCode = 1
  }
}
