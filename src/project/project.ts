import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deepFreeze } from '../core/freeze.ts'
import { readYamlFile, writeYamlFile } from '../io/yaml.ts'
import { PROJECT_DIR_SUBDIRS, assertValidProjectId, projectPaths, type ProjectPaths } from '../io/paths.ts'
import {
  checkProjectConfigWarnings,
  createDefaultProjectConfig,
  validateProjectConfig,
  type ProjectConfig,
} from '../schema/project-config.ts'
import { createEmptySeed, validateSeedFile, type SeedFile } from '../schema/seed.ts'
import { validateProposalsFile, type ProposalsFile } from '../schema/proposal.ts'
import { validateBlueprint, type Blueprint } from '../schema/blueprint.ts'

/**
 * 项目存储层（Story 1）—— 文件优先，无数据库（架构设计 §33.2）。
 *
 * 写入路径永远是：构造 → zod 校验 → 不变量校验 → 深度冻结 → YAML 落盘。
 * 读取路径永远是：YAML 解析 → zod 校验 → 不变量校验 → 深度冻结。
 * 两侧共用 `validateSeedFile` / `validateProjectConfig`，防止出现"能写不能读"的结构。
 */

export class ProjectExistsError extends Error {
  override readonly name = 'ProjectExistsError'
  constructor(projectId: string) {
    super(`项目 "${projectId}" 已存在（seed.yaml 或 project-config.yaml 已存在）；Story 1 不覆盖既有项目数据`)
  }
}

export class ProjectNotFoundError extends Error {
  override readonly name = 'ProjectNotFoundError'
  constructor(message: string) {
    super(message)
  }
}

/** 解读 I-9：Gate 1 之后默认拒绝覆盖 raw_input，以保护已冻结的 anchor 集合（需求规格 §8.2）。 */
export class RawSeedLockedError extends Error {
  override readonly name = 'RawSeedLockedError'
  constructor(projectDir: string, gate1Status: string) {
    super(
      `项目 ${projectDir} 的 gate1_status=${gate1Status}，Gate 1 之后的 raw_input 覆盖默认被拒绝（解读 I-9）；如确需覆盖请显式传入 allowAfterGate1`,
    )
  }
}

export interface CreateProjectOptions {
  readonly projectsRoot: string
  readonly projectId: string
  readonly title?: string | null | undefined
  readonly targetLength?: number | null | undefined
  /** 自由文本 Story Seed（一句话 / 多句话 / 简单 Markdown），原样保存。 */
  readonly rawInput?: string | undefined
  /** 注入时间以便 golden 快照可复现（解读 I-6）。 */
  readonly now?: Date | undefined
}

export interface CreatedProject {
  readonly paths: ProjectPaths
  readonly projectConfig: ProjectConfig
  readonly seed: SeedFile
  readonly warnings: readonly string[]
}

/** 可创建新短篇项目（Story 1 验收 1、2）。 */
export function createProject(options: CreateProjectOptions): CreatedProject {
  assertValidProjectId(options.projectId)
  const paths = projectPaths(options.projectsRoot, options.projectId)

  if (existsSync(paths.seed) || existsSync(paths.projectConfig)) {
    throw new ProjectExistsError(options.projectId)
  }

  mkdirSync(paths.dir, { recursive: true })
  for (const subdir of PROJECT_DIR_SUBDIRS) {
    mkdirSync(join(paths.dir, subdir), { recursive: true })
  }

  const createdAt = (options.now ?? new Date()).toISOString()
  const projectConfig = validateProjectConfig(
    createDefaultProjectConfig({
      projectId: options.projectId,
      title: options.title ?? null,
      createdAt,
      targetLength: options.targetLength ?? null,
    }),
  )
  const seed = validateSeedFile(createEmptySeed(options.rawInput ?? ''))

  writeYamlFile(paths.projectConfig, projectConfig)
  writeYamlFile(paths.seed, seed)

  return {
    paths,
    projectConfig,
    seed,
    warnings: checkProjectConfigWarnings(projectConfig).map((notice) => notice.message),
  }
}

export function loadProjectConfig(paths: ProjectPaths): ProjectConfig {
  if (!existsSync(paths.projectConfig)) {
    throw new ProjectNotFoundError(`找不到 ${paths.projectConfig}`)
  }
  return validateProjectConfig(readYamlFile(paths.projectConfig))
}

export function saveProjectConfig(paths: ProjectPaths, config: ProjectConfig): ProjectConfig {
  const validated = validateProjectConfig(config)
  writeYamlFile(paths.projectConfig, validated)
  return validated
}

export function loadSeed(paths: ProjectPaths): SeedFile {
  if (!existsSync(paths.seed)) {
    throw new ProjectNotFoundError(`找不到 ${paths.seed}`)
  }
  return validateSeedFile(readYamlFile(paths.seed))
}

export function saveSeed(paths: ProjectPaths, seed: SeedFile): SeedFile {
  const validated = validateSeedFile(seed)
  writeYamlFile(paths.seed, validated)
  return validated
}

export interface LoadedProject {
  readonly paths: ProjectPaths
  readonly projectConfig: ProjectConfig
  readonly seed: SeedFile
}

export function loadProject(projectsRoot: string, projectId: string): LoadedProject {
  const paths = projectPaths(projectsRoot, projectId)
  return {
    paths,
    projectConfig: loadProjectConfig(paths),
    seed: loadSeed(paths),
  }
}

export interface SetRawSeedInputOptions {
  /**
   * 解读 I-9：Gate 1 之后（gate1_status !== 'pending'）默认拒绝覆盖 raw_input，
   * 以保护需求规格 §8.2 已冻结的 anchor 集合。
   */
  readonly allowAfterGate1?: boolean | undefined
}

/** 保存用户 raw input（Story 1 验收 2/3）：写盘内容与传入字符串逐字符一致。 */
export function setRawSeedInput(
  paths: ProjectPaths,
  rawInput: string,
  options: SetRawSeedInputOptions = {},
): SeedFile {
  const current = loadSeed(paths)
  if (current.story_seed.gate1_status !== 'pending' && options.allowAfterGate1 !== true) {
    throw new RawSeedLockedError(paths.dir, current.story_seed.gate1_status)
  }
  const next = deepFreeze({
    ...current,
    story_seed: { ...current.story_seed, raw_input: rawInput },
  }) as SeedFile
  return saveSeed(paths, next)
}

// ---------------------------------------------------------------------------
// proposals.yaml（Story 3）—— 同一套"写入前校验、读取后校验"的规则
// ---------------------------------------------------------------------------

export function loadProposals(paths: ProjectPaths): ProposalsFile {
  if (!existsSync(paths.proposals)) {
    throw new ProjectNotFoundError(`找不到 ${paths.proposals}（尚未运行 Story Developer）`)
  }
  return validateProposalsFile(readYamlFile(paths.proposals))
}

export function saveProposals(paths: ProjectPaths, file: ProposalsFile): ProposalsFile {
  const validated = validateProposalsFile(file)
  writeYamlFile(paths.proposals, validated)
  return validated
}

export function proposalsExist(paths: ProjectPaths): boolean {
  return existsSync(paths.proposals)
}

// ---------------------------------------------------------------------------
// blueprint.yaml（Story 4）
// ---------------------------------------------------------------------------

export function loadBlueprint(paths: ProjectPaths): Blueprint {
  if (!existsSync(paths.blueprint)) {
    throw new ProjectNotFoundError(`找不到 ${paths.blueprint}（尚未确认 Blueprint）`)
  }
  return validateBlueprint(readYamlFile(paths.blueprint))
}

export function saveBlueprint(paths: ProjectPaths, blueprint: Blueprint): Blueprint {
  const validated = validateBlueprint(blueprint)
  writeYamlFile(paths.blueprint, validated)
  return validated
}

export function blueprintExists(paths: ProjectPaths): boolean {
  return existsSync(paths.blueprint)
}
