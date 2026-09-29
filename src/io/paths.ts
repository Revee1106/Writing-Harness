import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ID_PATTERNS } from '../core/ids.ts'

/**
 * 项目文件结构 —— 需求规格 §29 / 架构设计 §32。
 *
 * D7 裁决：项目根 = `projects/<project_id>/`，其内部文件树照抄两份文档。
 * Story 1 只创建 `seed.yaml` 与 `project-config.yaml`（Story 1「功能」第 3 条），
 * 其余路径在此登记，供后续 Story 使用，避免各自拼路径导致结构漂移。
 */

export const PROJECT_FILE_NAMES = {
  seed: 'seed.yaml',
  proposals: 'proposals.yaml',
  blueprint: 'blueprint.yaml',
  storyState: 'story_state.yaml',
  projectConfig: 'project-config.yaml',
} as const

export const REPORT_FILE_NAMES = {
  coverage: 'coverage.yaml',
  contextManifest: 'context-manifest.yaml',
  linter: 'linter.yaml',
} as const

export const STYLE_FILE_NAMES = {
  profile: 'profile.yaml',
} as const

/** OQ-07 裁决：项目级词表优先，允许 fallback 到仓库级默认词表。 */
export const ANTI_AI_TEMPLATE_ACTIONS_FILENAME = 'anti-ai-template-actions.yaml'
export const REPO_DEFAULT_ANTI_AI_TEMPLATE_ACTIONS_REL_PATH = join('config', ANTI_AI_TEMPLATE_ACTIONS_FILENAME)

/**
 * 项目目录下需要存在的骨架目录（需求规格 §29 / 架构设计 §32）。
 * 只建目录，不预建任何未定义的文件（解读 I-10）。
 */
export const PROJECT_DIR_SUBDIRS = [
  'history',
  /** OQ-10 / 解读 I-31：Gate 2 元数据目录（与 history/blueprint-<NNN>.yaml 按 NNN 一一对应）。 */
  'blueprint-history',
  'scenes',
  'drafts',
  'style',
  join('style', 'samples'),
  'reports',
  'config',
] as const

export class InvalidProjectIdError extends Error {
  override readonly name = 'InvalidProjectIdError'
  constructor(projectId: string) {
    super(`非法 project id "${projectId}"：必须匹配 ${ID_PATTERNS.projectId}（解读 I-5）`)
  }
}

export function isProjectId(value: string): boolean {
  return ID_PATTERNS.projectId.test(value)
}

export function assertValidProjectId(projectId: string): void {
  if (!isProjectId(projectId)) {
    throw new InvalidProjectIdError(projectId)
  }
}

export interface ProjectPaths {
  readonly projectsRoot: string
  readonly dir: string
  readonly seed: string
  readonly projectConfig: string
  readonly proposals: string
  readonly blueprint: string
  readonly storyState: string
  readonly historyDir: string
  readonly blueprintHistoryDir: string
  /** 历史 / 元数据的解析结果见 src/schema/gate2-meta.ts 的 snapshotFileName / metaFileName。 */
  readonly blueprintHistoryMetaDir: string
  readonly scenesDir: string
  readonly draftsDir: string
  readonly styleDir: string
  readonly styleSamplesDir: string
  readonly styleProfile: string
  readonly reportsDir: string
  readonly coverageReport: string
  readonly contextManifestReport: string
  readonly linterReport: string
  readonly configDir: string
  readonly antiAiTemplateActions: string
}

export function projectPaths(projectsRoot: string, projectId: string): ProjectPaths {
  assertValidProjectId(projectId)
  const dir = join(projectsRoot, projectId)
  const styleDir = join(dir, 'style')
  const reportsDir = join(dir, 'reports')
  const configDir = join(dir, 'config')
  return {
    projectsRoot,
    dir,
    seed: join(dir, PROJECT_FILE_NAMES.seed),
    projectConfig: join(dir, PROJECT_FILE_NAMES.projectConfig),
    proposals: join(dir, PROJECT_FILE_NAMES.proposals),
    blueprint: join(dir, PROJECT_FILE_NAMES.blueprint),
    storyState: join(dir, PROJECT_FILE_NAMES.storyState),
    historyDir: join(dir, 'history'),
    blueprintHistoryDir: join(dir, 'blueprint-history'),
    blueprintHistoryMetaDir: join(dir, 'blueprint-history'),
    scenesDir: join(dir, 'scenes'),
    draftsDir: join(dir, 'drafts'),
    styleDir,
    styleSamplesDir: join(styleDir, 'samples'),
    styleProfile: join(styleDir, STYLE_FILE_NAMES.profile),
    reportsDir,
    coverageReport: join(reportsDir, REPORT_FILE_NAMES.coverage),
    contextManifestReport: join(reportsDir, REPORT_FILE_NAMES.contextManifest),
    linterReport: join(reportsDir, REPORT_FILE_NAMES.linter),
    configDir,
    antiAiTemplateActions: join(configDir, ANTI_AI_TEMPLATE_ACTIONS_FILENAME),
  }
}

export interface ResolvedAntiAiTemplateActionsPath {
  readonly path: string
  readonly scope: 'project' | 'repo_default'
}

/**
 * 反 AI 词表解析（OQ-07）：项目级存在则用项目级，否则 fallback 到仓库级默认词表。
 * Story 8 才会真正写入词表内容，Story 1 只提供路径解析契约。
 */
export function resolveAntiAiTemplateActionsPath(
  paths: ProjectPaths,
  repoRoot: string,
): ResolvedAntiAiTemplateActionsPath {
  if (existsSync(paths.antiAiTemplateActions)) {
    return { path: paths.antiAiTemplateActions, scope: 'project' }
  }
  return { path: join(repoRoot, REPO_DEFAULT_ANTI_AI_TEMPLATE_ACTIONS_REL_PATH), scope: 'repo_default' }
}
