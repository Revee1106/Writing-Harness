#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import {
  RULE_LINTER_ID,
  RuleLinterPreconditionError,
  loadLinterReport,
  runRuleLinter,
  runRuleLinterAll,
} from '../linter/rule-linter.ts'
import { LinterReportValidationError, SEVERITY_DISPLAY } from '../schema/linter-report.ts'
import { LlmLinterError, LLM_LINTER_CONTRACT_ID, runLlmLinter } from '../linter/llm-linter.ts'
import { LocalRewriteError, runLocalRewrite } from '../linter/rewrite.ts'
import { LLM_LINTER_RULES } from '../linter/llm-rules.ts'
import {
  Gate3Error,
  assembleFinalFromProject,
  loadFinalDraft,
  runGate3,
} from '../state/gate3.ts'
import {
  ANTI_AI_CSV_COLUMNS,
  ANTI_AI_DIR,
  AUTHOR_COST_CSV_COLUMNS,
  STORY_DEVELOPMENT_CSV_COLUMNS,
  loadStoryDevelopmentSeedSet,
  measureFixtureSeed,
  summarizeAbSession,
  STORY_DEVELOPMENT_DIR,
  buildStoryDevelopmentEvaluation,
  collectAuthorCost,
  draftTextsOf,
  generateAbSession,
  nextSessionId,
  toCsv,
} from '../eval/evaluation.ts'
import { RuleLinterPreconditionError as _RuleLinterPreconditionError } from '../linter/rule-linter.ts'
import { AntiAiVocabError } from '../schema/anti-ai-vocab.ts'
import { REPO_DEFAULT_ANTI_AI_ELEVATION_REL_PATH, REPO_DEFAULT_ANTI_AI_TEMPLATE_ACTIONS_REL_PATH } from '../io/paths.ts'
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
import { writeTextFile, writeYamlFile } from '../io/yaml.ts'
import { countRuleWarnings } from '../eval/evaluation.ts'
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
 *         lint / lint show（Story 8 Rule Linter；Story 9 LLM Linter）
 *         rewrite（Story 9，Local Rewrite + 局部二次 Linter）
 *         gate3 / final show（Story 10，Gate 3 + State Extractor）
 *         eval story-development / eval author-cost / eval ab-generate / eval ab-report（Story 10，评估资产）
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DEFAULT_PROJECTS_ROOT = resolve(REPO_ROOT, 'projects')

const USAGE = `Short-story-first Writing Harness v0.1 — 项目 / Seed / Gate 1

用法：
  pnpm harness init <projectId> [选项]       创建新短篇项目
  pnpm harness seed set <projectId> [选项]   保存 / 覆盖用户 raw input（Gate 1 之前）
  pnpm harness seed show <projectId> [选项]  显示 seed.yaml
  pnpm harness config show <projectId> [选项] 显示 project-config.yaml
  pnpm harness gate1 <projectId> [选项]      Seed Interpreter → Author Gate 1
  pnpm harness develop <projectId> [选项]    Story Developer → 2～3 个 Proposal
  pnpm harness proposals show <projectId>    显示 proposals.yaml 摘要与 Seed Preservation Rate
  pnpm harness gate2 <projectId> [选项]      Author Gate 2：确认 / 合并 / 手改 → Blueprint
  pnpm harness blueprint show <projectId>    显示当前 Blueprint 摘要
  pnpm harness breakdown <projectId> [选项]  Scene Breakdown → /scenes + story_state + coverage
  pnpm harness scenes show <projectId>       显示 Scene 列表摘要
  pnpm harness state show <projectId>        显示 story_state.yaml 摘要
  pnpm harness coverage show <projectId>     显示 coverage 报告（结构化 warning）
  pnpm harness context <projectId> [选项]    Context Compiler：为某个 Scene 编译受控上下文 + Manifest
  pnpm harness style add <projectId> [选项]  保存一个 Style Sample（SAMPLE_<NNN> 由 Harness 分配）
  pnpm harness style show <projectId>        显示 style/profile.yaml 摘要
  pnpm harness write <projectId> [选项]      Prose Writer：按 Scene 生成 drafts/scene-NNN.md
  pnpm harness drafts show <projectId>       显示已生成正文的长度与检查摘要
  pnpm harness lint <projectId> [选项]       Rule Anti-AI Linter：确定性 / 统计型检查（不自动 Rewrite）
  pnpm harness lint show <projectId>         显示 reports/linter.yaml
  pnpm harness rewrite <projectId> [选项]    对某条 warning 的 span 做局部 Rewrite（不整篇重写）
  pnpm harness gate3 <projectId> [选项]      Gate 3：拼接 final.md + 整篇确认 + State Extractor
  pnpm harness final show <projectId>        显示 drafts/final.md 摘要
  pnpm harness eval story-development        生成 Story Development 评估表（≥10 Seed，CSV）
  pnpm harness eval author-cost              生成作者成本表（CSV）
  pnpm harness eval ab-generate             生成 Anti-AI A/B 对照 session + 人工填写模板
  pnpm harness help                          显示本帮助

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

lint 选项：
  --scene <scene-###>     只检查这一场（默认检查全部 Scene，磁盘保留最后一场报告）
  --llm                   切换到 LLM Linter（语义型五类；需要 provider）
  --full                  完整检查（默认行为；局部重跑用 rewrite 的默认档）
  --plan                  只读预览：完整检查但不写 reports/linter.yaml
  --json                  以 JSON 输出报告
  --provider / --fixtures LLM Linter 使用的 provider（默认 recorded）

gate3 选项：
  --confirm               整篇一次性确认（必须显式给出；逐场确认属于 Story 9 的 Rewrite 范畴）
  --plan                  只读预览：完整提取但不写 final.md / story_state.yaml
  --provider <name>       State Extractor 使用的 provider（默认 recorded）
  --fixtures <dir>        recorded fixture 目录（默认 tests/fixtures/recorded/state_extractor）

pnpm harness eval 选项：
  pnpm harness eval story-development [--projects demo-01,demo-02] [--out <path>]
  pnpm harness eval author-cost [--projects demo-01,demo-02] [--out <path>]
  pnpm harness eval ab-generate [--session <session-NNN>] [--projects demo-01,demo-02]
  pnpm harness eval ab-report [--session session-001]    A/B 长度归一化摘要（不做质量判定）

rewrite 选项：
  --scene <scene-###>     目标 Scene（必填）
  --warning <LINT_###>    要修复的 warning ID（来自 reports/linter.yaml；必填）
  --full                  Rewrite 后跑完整 Linter（默认只做局部二次检查）
  --plan                  只读预览：完整生成但不改写正文 / 报告
  --provider / --fixtures Local Rewrite 使用的 provider（默认 recorded）

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
      llm: { type: 'boolean' },
      full: { type: 'boolean' },
      warning: { type: 'string' },
      confirm: { type: 'boolean' },
      projects: { type: 'string' },
      out: { type: 'string' },
      project: { type: 'string' },
      session: { type: 'string' },
    },
  })
  const [command, second, third] = positionals
  // lint 既是 `lint <projectId>` 也是 `lint show <projectId>`：只有第二位置参数正好是 "show" 时按子命令解析
  const lintShowForm = command === 'lint' && second === 'show'
  const isSubcommandForm =
    lintShowForm ||
    command === 'seed' ||
    command === 'config' ||
    command === 'proposals' ||
    command === 'blueprint' ||
    command === 'scenes' ||
    command === 'state' ||
    command === 'coverage' ||
    command === 'style' ||
    command === 'drafts' ||
    command === 'final' ||
    command === 'eval'
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

  // 无 Scene 时不能"静默写 0 个 Draft"：必须先拆场，否则用户会以为写完了
  if (loadScenes(paths).length === 0) {
    throw new ProseWriterError('No scenes found; run breakdown first')
  }

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


function printLinterReport(
  report: NonNullable<ReturnType<typeof loadLinterReport>>,
  meta: { readonly templateActions?: string | undefined; readonly elevationPhrases?: string | undefined },
): void {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const warning of report.warnings) counts[warning.severity] += 1
  process.stdout.write(
    `${report.scene_id}  linter=${report.linter}  warnings: high ${counts.high} / medium ${counts.medium}（low 仅日志）\n`,
  )
  process.stdout.write(
    `  template_actions@${String(report.template_actions_version)}  elevation_phrases@${String(report.elevation_phrases_version)}  disabled_rules: ${report.disabled_rules.join(', ') || '（无）'}\n`,
  )
  if (meta.templateActions !== undefined) process.stdout.write(`  词表：${meta.templateActions}\n`)
  if (meta.elevationPhrases !== undefined) process.stdout.write(`  升华词典：${meta.elevationPhrases}\n`)
  for (const warning of report.warnings) {
    const span = warning.span === null ? '-' : `${warning.span.start}-${warning.span.end}`
    process.stdout.write(
      `  [${warning.severity}/${SEVERITY_DISPLAY[warning.severity]}] ${warning.id} ${warning.rule} ${span}\n      ${warning.message}\n`,
    )
  }
  if (report.warnings.length === 0) process.stdout.write('  （无 warning：未发现确定性 / 统计型 AI 痕迹）\n')
  if (report.low_severity_log.length > 0) {
    process.stdout.write(`  low_severity_log（不弹给用户）：\n`)
    for (const entry of report.low_severity_log) {
      process.stdout.write(`    ${entry.id} ${entry.kind}: ${entry.message}\n`)
    }
  }
}

function runLintCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const sceneRaw = parsed.values.scene
  const dryRun = parsed.values.plan === true

  if (typeof sceneRaw === 'string') {
    const result = runRuleLinter({
      paths,
      repoRoot: REPO_ROOT,
      sceneId: sceneRaw,
      dryRun,
    })
    if (parsed.values.json === true) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
    } else {
      printLinterReport(result.report, {
        templateActions: `${result.templateActions.version}（${result.templateActions.scope}, ${result.templateActions.count} 条）`,
        elevationPhrases: `${result.elevationPhrases.version}（${result.elevationPhrases.scope}, ${result.elevationPhrases.count} 条）`,
      })
    }
    process.stdout.write(
      result.written ? `已写入：${paths.linterReport}\n` : '[plan] 只读预览：未写 reports/linter.yaml\n',
    )
    return 0
  }

  const all = runRuleLinterAll({ paths, repoRoot: REPO_ROOT, dryRun })
  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(all.reports, null, 2)}\n`)
  } else {
    for (const report of all.reports) printLinterReport(report, {})
    for (const failure of all.failures) process.stdout.write(`[失败] ${failure.sceneId}: ${failure.message}\n`)
  }
  process.stdout.write(
    dryRun
      ? `[plan] 只读预览：${all.reports.length} 场已检查，未写盘\n`
      : `已检查 ${all.reports.length} 场（失败 ${all.failures.length} 场）；报告保留最后一场：${paths.linterReport}\n`,
  )
  return all.failures.length === 0 ? 0 : 1
}

function runLintShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const report = loadLinterReport(paths)
  if (report === null) {
    process.stdout.write('（没有 reports/linter.yaml；请先执行 harness lint）\n')
    return 0
  }
  printLinterReport(report, {})
  return 0
}


async function runLintCommandAsync(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const sceneRaw = parsed.values.scene
  if (typeof sceneRaw !== 'string') {
    throw new UsageError('--llm 需要 --scene <scene-###>（LLM Linter 逐场运行）')
  }
  const resolved = providerFor(parsed, LLM_LINTER_CONTRACT_ID)
  const result = await runLlmLinter({
    paths,
    provider: resolved.provider,
    sceneId: sceneRaw,
    dryRun: parsed.values.plan === true,
  })
  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
  } else {
    printLinterReport(result.report, {})
    if (result.rejected.length > 0) {
      process.stdout.write(`  非法 span 已丢弃（low_severity_log）：${result.rejected.length} 条\n`)
    }
    process.stdout.write(`  语义类型：${LLM_LINTER_RULES.join(' / ')}\n`)
  }
  process.stdout.write(
    result.written ? `已写入：${paths.linterReport}\n` : '[plan] 只读预览：未写 reports/linter.yaml\n',
  )
  return 0
}

async function runRewriteCommand(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const sceneRaw = parsed.values.scene
  const warningRaw = parsed.values.warning
  if (typeof sceneRaw !== 'string' || typeof warningRaw !== 'string') {
    throw new UsageError('rewrite 需要 --scene <scene-###> 与 --warning <LINT_###>')
  }
  const resolved = providerFor(parsed, 'local_rewrite')
  const result = await runLocalRewrite({
    paths,
    repoRoot: REPO_ROOT,
    provider: resolved.provider,
    sceneId: sceneRaw,
    warningId: warningRaw,
    dryRun: parsed.values.plan === true,
    scope: parsed.values.full === true ? 'full' : 'paragraph',
  })

  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${result.sceneId}  ${result.warningId}  span ${result.span.start}-${result.span.end}\n`)
  process.stdout.write(`  原文：${result.before}\n`)
  process.stdout.write(`  替换：${result.after}\n`)
  process.stdout.write(
    `  结果：${result.applied ? '已原地改写 drafts/' + result.sceneId + '.md' : '未改动（模型原样输出或 --plan）'}\n`,
  )
  process.stdout.write(
    `  局部二次检查：${parsed.values.full === true ? '完整 Linter' : 'span 所在段落 + 相邻段落'} → 范围 ${result.relint.replacedRange.start}-${result.relint.replacedRange.end}，当前 warning ${result.report.warnings.length} 条\n`,
  )
  printLinterReport(result.report, {})
  return 0
}


async function runGate3Command(parsed: ParsedCli): Promise<number> {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const resolved = providerFor(parsed, 'state_extractor')
  const result = await runGate3({
    paths,
    provider: resolved.provider,
    confirm: parsed.values.confirm === true,
    dryRun: parsed.values.plan === true,
  })

  if (parsed.values.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`Gate 3：${result.sceneCount} 场已确认（confirmed_scenes 一次性写入）\n`)
  process.stdout.write(`final.md：${result.finalText.length} 字（${[...result.finalText].length} 码点）→ ${result.finalPath}\n`)
  process.stdout.write(`OCCURRED：${result.occurred.length} 条\n`)
  for (const entry of result.occurred) {
    process.stdout.write(`  ${entry.id}  ${entry.type}  scene=${entry.scene_id}\n`)
  }
  if (result.lowSeverity.length > 0) {
    process.stdout.write('low_severity_log：\n')
    for (const entry of result.lowSeverity) process.stdout.write(`  [${entry.code}] ${entry.message}\n`)
  }
  for (const conflict of result.conflicts) {
    process.stdout.write(`  [conflict] ${conflict.ref_id}: ${conflict.message}\n`)
  }
  for (const warning of result.foreshadowingWarnings) {
    process.stdout.write(`  [high warning] ${warning}\n`)
  }
  const unresolved = result.state.state_rebuild_conflicts.filter((conflict) => conflict.resolution_note === null)
  process.stdout.write(`未处理的状态冲突：${unresolved.length} 条（需用户裁决：改正文或改 Blueprint）\n`)
  process.stdout.write(result.written ? `已写入：${result.finalPath} 与 ${paths.storyState}\n` : '[plan] 只读预览：未写盘\n')
  return 0
}

function runFinalShowCommand(parsed: ParsedCli): number {
  const projectId = requireProjectId(parsed)
  const paths = projectPaths(projectsRootOf(parsed), projectId)
  const final = loadFinalDraft(paths)
  if (final === null) {
    const assembled = assembleFinalFromProject(paths)
    process.stdout.write(`（尚未生成 final.md；若现在拼接将是 ${assembled.sceneCount} 场、${assembled.finalText.length} 字）\n`)
    return 0
  }
  process.stdout.write(`# ${join(paths.draftsDir, 'final.md')}\n`)
  process.stdout.write(`码点：${[...final].length}  段落：${final.split(/\n\s*\n/).filter((block) => block.trim() !== '').length}\n`)
  process.stdout.write(`格式检查：${checkProseFormat(final).length === 0 ? '通过（无标题 / 无元数据 / 无分隔符）' : '存在问题'}\n`)
  process.stdout.write('--- 开头 ---\n')
  process.stdout.write(final.split('\n').slice(0, 4).join('\n'))
  process.stdout.write('\n--- 结尾 ---\n')
  process.stdout.write(final.trimEnd().split('\n').slice(-4).join('\n'))
  process.stdout.write('\n')
  return 0
}

function projectIdsOf(parsed: ParsedCli): string[] {
  const raw = parsed.values.projects
  if (typeof raw === 'string' && raw.trim() !== '') return raw.split(',').map((value) => value.trim())
  return ['demo-01', 'demo-02']
}

async function runEvalStoryDevelopment(parsed: ParsedCli): Promise<number> {
  const seedSet = loadStoryDevelopmentSeedSet(REPO_ROOT)
  const projectsRoot = projectsRootOf(parsed)
  const projectSeeds = seedSet.seeds.filter((seed) => seed.status === 'measured' && seed.project_id !== null)
  const fixtureSeeds = seedSet.seeds.filter((seed) => seed.status === 'measured' && seed.project_id === null)
  const projects = projectSeeds.map((seed) => ({
    seedId: seed.seed_id,
    paths: projectPaths(projectsRoot, seed.project_id ?? ''),
  }))
  const evaluation = buildStoryDevelopmentEvaluation(projects)
  const measured = await Promise.all(
    fixtureSeeds.map((seed) =>
      measureFixtureSeed({
        repoRoot: REPO_ROOT,
        seedId: seed.seed_id,
        seedFile: seed.seed_file ?? '',
        gate1Ops: seed.gate1_ops ?? undefined,
      }),
    ),
  )
  const rows = [...evaluation.rows, ...measured.flatMap((entry) => entry.rows)].map((row) =>
    STORY_DEVELOPMENT_CSV_COLUMNS.map((column) => String(row[column])),
  )
  const csv = toCsv(STORY_DEVELOPMENT_CSV_COLUMNS, rows)
  const outRaw = parsed.values.out
  const outPath = typeof outRaw === 'string' ? resolve(outRaw) : join(REPO_ROOT, STORY_DEVELOPMENT_DIR, 'results.csv')
  writeTextFile(outPath, csv)
  const distinctnessAllOk = evaluation.distinctnessAllOk && measured.every((entry) => entry.distinctness_ok)
  process.stdout.write(
    `Story Development Test Set：${seedSet.seeds.length} 个 Seed（要求 ≥${seedSet.seed_count_minimum}，measured ${seedSet.measuredCount} = 项目型 ${seedSet.projectBackedCount} + fixture 型 ${seedSet.fixtureBackedCount}）\n`,
  )
  process.stdout.write(
    `  项目型：${projectSeeds.map((seed) => `${seed.seed_id}(${seed.project_id})`).join(', ')} → ${evaluation.proposalCount} 个 Proposal\n`,
  )
  process.stdout.write(
    `  fixture 型（离线回放 seed_interpreter → Gate 1 → story_developer）：${measured.map((entry) => `${entry.seed_id}(${entry.proposal_count} 提案 / ${entry.anchor_count} 锚点)`).join(', ')}\n`,
  )
  process.stdout.write(`  差异度全部通过：${distinctnessAllOk ? '是' : '否'}\n`)
  const corpusOnly = seedSet.seeds.filter((seed) => seed.status === 'corpus_only')
  if (corpusOnly.length > 0) {
    process.stdout.write(
      `  仅输入、不产出指标（封版裁决接受）：${corpusOnly.map((seed) => `${seed.seed_id}(${seed.genre})`).join(', ')}\n`,
    )
  }
  process.stdout.write(`已写入：${outPath}（${rows.length} 行）\n`)
  return 0
}

function runEvalAbReport(parsed: ParsedCli): number {
  const sessionId = typeof parsed.values.session === 'string' ? parsed.values.session : 'session-001'
  const summary = summarizeAbSession(REPO_ROOT, sessionId)
  process.stdout.write(`Anti-AI A/B 归一化摘要：${summary.session_id}\n`)
  process.stdout.write(`  分组数：${summary.groupCount}\n`)
  process.stdout.write(
    `  A 侧（普通 Prompt）：平均 ${summary.aAvgCodePoints} 码点/场，合计 ${summary.aCodePoints} 码点，Rule warning ${summary.aWarnings}\n`,
  )
  process.stdout.write(
    `  B 侧（Writing Harness）：平均 ${summary.bAvgCodePoints} 码点/场，合计 ${summary.bCodePoints} 码点，Rule warning ${summary.bWarnings}\n`,
  )
  process.stdout.write(
    `  长度比（B/A）：${summary.lengthRatio} → ${summary.lengthsComparable ? '长度接近（±20%），原始计数可信' : '长度不可比（>20%），以归一化结果为准'}\n`,
  )
  process.stdout.write(
    `  归一化：A ${summary.aWarningsPer1000}/千码点，B ${summary.bWarningsPer1000}/千码点（B/A = ${summary.normalizedRatio}）\n`,
  )
  process.stdout.write(`  结论：${summary.verdict}\n`)
  process.stdout.write('  说明：v0.1 不执行盲测、不自动评分；本命令只做长度归一化，不做质量判定\n')
  return 0
}

function runEvalAuthorCost(parsed: ParsedCli): number {
  const rows = projectIdsOf(parsed).map((projectId) =>
    collectAuthorCost(projectId, projectPaths(projectsRootOf(parsed), projectId)),
  )
  const csv = toCsv(
    AUTHOR_COST_CSV_COLUMNS,
    rows.map((row) => AUTHOR_COST_CSV_COLUMNS.map((column) => String(row[column]))),
  )
  const outRaw = parsed.values.out
  const outPath = typeof outRaw === 'string' ? resolve(outRaw) : join(REPO_ROOT, STORY_DEVELOPMENT_DIR, 'author-cost.csv')
  writeTextFile(outPath, csv)
  process.stdout.write('作者成本（需求规格 §31.3）：\n')
  for (const row of rows) {
    process.stdout.write(
      `  ${row.project_id}: 显式 Gate ${row.explicit_gates} 次（Gate1=${row.gate1_status} / Blueprint 版本 ${row.blueprint_versions} / confirmed_scenes ${row.confirmed_scenes}）  linter warning ${row.linter_warnings}  rewrite ${row.rewrites_applied}\n`,
    )
  }
  process.stdout.write(`已写入：${outPath}\n`)
  return 0
}

function runEvalAbGenerate(parsed: ParsedCli): number {
  // Anti-AI A/B Test Set：默认覆盖两个 demo（5 + 5 = 10 个 Scene Intent，Story 10 D 节）。
  const projectIds = Array.isArray(parsed.values.projects)
    ? (parsed.values.projects as string[])
    : typeof parsed.values.projects === 'string'
      ? parsed.values.projects.split(',').map((value) => value.trim()).filter((value) => value !== '')
      : ['demo-01', 'demo-02']
  const projectsRoot = projectsRootOf(parsed)
  const plainTexts: Record<string, string> = {}
  const harnessTexts: Record<string, string> = {}
  const aRuleWarnings: Record<string, number> = {}
  const bRuleWarnings: Record<string, number> = {}
  const sceneEntries: {
    key: string
    project_id: string
    scene_id: string
    pov: string
    scene_type: string
    intent_ref: string
    target_length: number
  }[] = []
  for (const projectId of projectIds) {
    const paths = projectPaths(projectsRoot, projectId)
    const harnessTextsOfProject = draftTextsOf(paths)
    for (const scene of loadScenes(paths)) {
      const key = `${projectId}/${scene.scene_id}`
      // A 侧（"普通 Prompt"）离线来自 recorded fixture；缺失时留空占位（不自动评分）
      const file = join(REPO_ROOT, 'tests/fixtures/recorded/plain_prompt', `${projectId}-${scene.scene_id}.yaml`)
      let aText = ''
      if (existsSync(file)) {
        const doc = readYamlFile(file) as { response?: { text?: string } }
        aText = doc.response?.text ?? ''
      }
      const bText = harnessTextsOfProject[scene.scene_id] ?? ''
      plainTexts[key] = aText
      harnessTexts[key] = bText
      aRuleWarnings[key] = countRuleWarnings(aText)
      bRuleWarnings[key] = countRuleWarnings(bText)
      sceneEntries.push({
        key,
        project_id: projectId,
        scene_id: scene.scene_id,
        pov: scene.pov,
        scene_type: scene.scene_type,
        intent_ref: `projects/${projectId}/scenes/${scene.scene_id}.yaml`,
        target_length: scene.target_length,
      })
    }
  }
  const sessionId = typeof parsed.values.session === 'string' ? parsed.values.session : nextSessionId(REPO_ROOT)
  const session = generateAbSession({
    repoRoot: REPO_ROOT,
    sessionId,
    plainTexts,
    harnessTexts,
    scenes: sceneEntries,
    aRuleWarnings,
    bRuleWarnings,
  })
  process.stdout.write(`Anti-AI A/B 对照已生成：${session.session_dir}\n`)
  process.stdout.write(`  Scene Intent：${session.groups.length} 个（A = 普通 Prompt，B = Writing Harness）\n`)
  const totalA = session.groups.reduce((sum, group) => sum + group.a_rule_warnings, 0)
  const totalB = session.groups.reduce((sum, group) => sum + group.b_rule_warnings, 0)
  process.stdout.write(`  Rule Linter warning 合计：A=${totalA}，B=${totalB}（仅元数据，不参与评分）\n`)
  process.stdout.write(`  人工填写模板：${session.csvPath}\n`)
  process.stdout.write(`  说明：v0.1 不执行盲测、不自动评分（Story 10 起始会裁决 4）\n`)
  return 0
}

async function runEvalCommand(parsed: ParsedCli): Promise<number> {
  const sub = parsed.subcommand
  if (sub === 'story-development') return runEvalStoryDevelopment(parsed)
  if (sub === 'ab-report') return runEvalAbReport(parsed)
  if (sub === 'author-cost') return runEvalAuthorCost(parsed)
  if (sub === 'ab-generate') return runEvalAbGenerate(parsed)
  throw new UsageError(
    `未知子命令：eval ${sub ?? ''}（可用：story-development / author-cost / ab-generate / ab-report）`,
  )
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
    case 'lint':
      if (parsed.subcommand === 'show') return runLintShowCommand(parsed)
      if (parsed.values.llm === true) return runLintCommandAsync(parsed)
      return runLintCommand(parsed)
    case 'rewrite':
      return runRewriteCommand(parsed)
    case 'gate3':
      return runGate3Command(parsed)
    case 'final':
      if (parsed.subcommand === 'show') return runFinalShowCommand(parsed)
      throw new UsageError(`未知子命令：final ${parsed.subcommand ?? ''}`)
    case 'eval':
      return runEvalCommand(parsed)
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
    error instanceof ProseWriterError ||
    error instanceof RuleLinterPreconditionError ||
    error instanceof LinterReportValidationError ||
    error instanceof AntiAiVocabError ||
    error instanceof LlmLinterError ||
    error instanceof LocalRewriteError ||
    error instanceof Gate3Error
  ) {
    process.stderr.write(`错误：${error.message}\n`)
    process.exitCode = 1
  } else {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`错误：${message}\n`)
    process.exitCode = 1
  }
}
