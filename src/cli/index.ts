#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

/**
 * CLI 入口（Story 1）。
 *
 * Node 24 可直接执行 TypeScript，无需编译（`pnpm harness ...`）。
 * Story 1 只提供最小命令面：init / seed set / seed show / config show。
 * Gate 1 / Gate 2 / Gate 3 的交互命令属于 Story 2 / 4 / 10。
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DEFAULT_PROJECTS_ROOT = resolve(REPO_ROOT, 'projects')

const USAGE = `Short-story-first Writing Harness v0.1 — 项目与 Seed 管理（Story 1）

用法：
  harness init <projectId> [选项]      创建新短篇项目
  harness seed set <projectId> [选项]  保存 / 覆盖用户 raw input（Gate 1 之前）
  harness seed show <projectId> [选项] 显示 seed.yaml
  harness config show <projectId> [选项] 显示 project-config.yaml
  harness help                         显示本帮助

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

输出选项：
  --json                  以 JSON 输出

示例：
  pnpm harness init demo-01 --seed "一对情侣因为一件小事争吵，女方提出分手。"
  pnpm harness init demo-02 --seed-file tests/fixtures/seeds/markdown.md --title "微信"
  pnpm harness seed show demo-01
`

interface ParsedCli {
  readonly command: string | undefined
  readonly subcommand: string | undefined
  readonly projectId: string | undefined
  readonly values: Record<string, string | boolean | undefined>
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
    },
  })
  const [command, second, third] = positionals
  const isSubcommandForm = command === 'seed' || command === 'config'
  return {
    command,
    subcommand: isSubcommandForm ? second : undefined,
    projectId: isSubcommandForm ? third : second,
    values: values as Record<string, string | boolean | undefined>,
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

function main(argv: string[]): number {
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
    default:
      throw new UsageError(`未知命令：${parsed.command}`)
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`用法错误：${error.message}\n\n${USAGE}`)
    process.exitCode = 2
  } else if (error instanceof ProjectExistsError) {
    process.stderr.write(`错误：${error.message}\n`)
    process.exitCode = 1
  } else {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`错误：${message}\n`)
    process.exitCode = 1
  }
}
