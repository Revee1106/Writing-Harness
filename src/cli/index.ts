#!/usr/bin/env node
import { readFileSync } from 'node:fs'
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
import { DRAFT_CONTEXT_MAX_CHARS_RECOMMENDED, TARGET_LENGTH_UNIT } from '../schema/project-config.ts'
import { runGate1, Gate1PreconditionError } from '../gate1/service.ts'
import { runStoryDeveloper, StoryDeveloperOutputError, UnresolvableSeedRefError } from '../developer/developer.ts'
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
 * Gate 2 / Gate 3 的交互命令属于 Story 4 / 10。
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
    },
  })
  const [command, second, third] = positionals
  const isSubcommandForm = command === 'seed' || command === 'config' || command === 'proposals'
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
  process.stdout.write(`draft_context: mode=${projectConfig.draft_context.mode} max_chars=${projectConfig.draft_context.max_chars}\n`)
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
    error instanceof ProjectNotFoundError
  ) {
    process.stderr.write(`错误：${error.message}\n`)
    process.exitCode = 1
  } else {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`错误：${message}\n`)
    process.exitCode = 1
  }
}
