import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROJECT_DIR_SUBDIRS,
  REPO_DEFAULT_ANTI_AI_TEMPLATE_ACTIONS_REL_PATH,
  assertValidProjectId,
  isProjectId,
  projectPaths,
  resolveAntiAiTemplateActionsPath,
} from '../../src/io/paths.ts'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'
import {
  ProjectExistsError,
  ProjectNotFoundError,
  RawSeedLockedError,
  createProject,
  loadProject,
  loadSeed,
  saveSeed,
  setRawSeedInput,
} from '../../src/project/project.ts'
import { validateSeedFile } from '../../src/schema/seed.ts'
import { REPO_ROOT, makeTempDir, type TempDir } from '../helpers/tmp.ts'

const CREATED_AT = '2026-01-01T00:00:00.000Z'
const tempDirs: TempDir[] = []

function tempRoot(): TempDir {
  const dir = makeTempDir('harness-project-')
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    tempDirs.pop()?.cleanup()
  }
})

describe('创建新短篇项目（Story 1 验收 1）', () => {
  it('创建目录骨架与两个 State 文件（需求规格 §29 / 架构设计 §32）', () => {
    const root = tempRoot()
    const created = createProject({
      projectsRoot: root.dir,
      projectId: 'demo-01',
      title: '演示',
      targetLength: 8000,
      rawInput: '一句话种子\n',
      now: new Date(CREATED_AT),
    })

    expect(existsSync(created.paths.seed)).toBe(true)
    expect(existsSync(created.paths.projectConfig)).toBe(true)
    for (const subdir of PROJECT_DIR_SUBDIRS) {
      expect(existsSync(join(created.paths.dir, subdir)), subdir).toBe(true)
    }
    expect(created.projectConfig.project).toMatchObject({
      id: 'demo-01',
      title: '演示',
      created_at: CREATED_AT,
      target_length: 8000,
    })
    expect(created.seed.story_seed.raw_input).toBe('一句话种子\n')
  })

  it('不预建任何文档未定义的文件', () => {
    const root = tempRoot()
    const created = createProject({ projectsRoot: root.dir, projectId: 'demo-01', now: new Date(CREATED_AT) })
    expect(existsSync(created.paths.proposals)).toBe(false)
    expect(existsSync(created.paths.blueprint)).toBe(false)
    expect(existsSync(created.paths.storyState)).toBe(false)
    expect(existsSync(created.paths.antiAiTemplateActions)).toBe(false)
  })

  it('拒绝重复创建，不覆盖既有项目数据', () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'demo-01', rawInput: '原始内容', now: new Date(CREATED_AT) })
    expect(() => createProject({ projectsRoot: root.dir, projectId: 'demo-01', rawInput: '新内容' })).toThrow(
      ProjectExistsError,
    )
    const seed = loadSeed(projectPaths(root.dir, 'demo-01'))
    expect(seed.story_seed.raw_input).toBe('原始内容')
  })

  it('拒绝非法 project id', () => {
    expect(isProjectId('demo-01')).toBe(true)
    expect(isProjectId('Demo_01')).toBe(false)
    expect(() => assertValidProjectId('Demo_01')).toThrow()
    const root = tempRoot()
    expect(() => createProject({ projectsRoot: root.dir, projectId: '../escape' })).toThrow()
  })

  it('创建后可完整回读，且与创建时逐字段一致', () => {
    const root = tempRoot()
    const created = createProject({
      projectsRoot: root.dir,
      projectId: 'demo-02',
      rawInput: readFileSync(join(REPO_ROOT, 'tests/fixtures/seeds/multi-sentence.txt'), 'utf8'),
      now: new Date(CREATED_AT),
    })
    const loaded = loadProject(root.dir, 'demo-02')
    expect(loaded.seed).toEqual(created.seed)
    expect(loaded.projectConfig).toEqual(created.projectConfig)
  })

  it('读取不存在的项目会报错', () => {
    const root = tempRoot()
    expect(() => loadProject(root.dir, 'missing-01')).toThrow(ProjectNotFoundError)
  })
})

describe('保存用户 raw input（Story 1 验收 2/3）', () => {
  it('setRawSeedInput 逐字符保留用户原话', () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'demo-03', now: new Date(CREATED_AT) })
    const raw = '  前导空格保留\n\n第二段：她说"算了"。  \n'
    const seed = setRawSeedInput(projectPaths(root.dir, 'demo-03'), raw)
    expect(seed.story_seed.raw_input).toBe(raw)
    expect(loadSeed(projectPaths(root.dir, 'demo-03')).story_seed.raw_input).toBe(raw)
  })

  it('Gate 1 之后默认拒绝覆盖 raw_input（解读 I-9）', () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'demo-04', rawInput: '原始', now: new Date(CREATED_AT) })
    const paths = projectPaths(root.dir, 'demo-04')
    const seed = loadSeed(paths)
    saveSeed(paths, {
      ...seed,
      story_seed: { ...seed.story_seed, gate1_status: 'confirmed' },
    })
    expect(() => setRawSeedInput(paths, '新内容')).toThrow(RawSeedLockedError)
    expect(setRawSeedInput(paths, '新内容', { allowAfterGate1: true }).story_seed.raw_input).toBe('新内容')
  })
})

describe('落盘文件自身可回读（Story 1 验收 1/4）', () => {
  it('直接读 seed.yaml 文本并重新校验通过', () => {
    const root = tempRoot()
    const raw = readFileSync(join(REPO_ROOT, 'tests/fixtures/seeds/markdown.md'), 'utf8')
    const created = createProject({ projectsRoot: root.dir, projectId: 'demo-05', rawInput: raw, now: new Date(CREATED_AT) })
    const text = readFileSync(created.paths.seed, 'utf8')
    const reparsed = validateSeedFile(loadYaml(text))
    expect(reparsed.story_seed.raw_input).toBe(raw)
    expect(text).toBe(dumpYaml(reparsed))
  })
})

describe('反 AI 词表路径解析（OQ-07 裁决）', () => {
  it('项目级不存在时 fallback 到仓库级默认词表', () => {
    const root = tempRoot()
    const created = createProject({ projectsRoot: root.dir, projectId: 'demo-06', now: new Date(CREATED_AT) })
    const resolved = resolveAntiAiTemplateActionsPath(created.paths, REPO_ROOT)
    expect(resolved.scope).toBe('repo_default')
    expect(resolved.path).toBe(join(REPO_ROOT, REPO_DEFAULT_ANTI_AI_TEMPLATE_ACTIONS_REL_PATH))
  })

  it('项目级存在时优先使用项目级词表', () => {
    const root = tempRoot()
    const created = createProject({ projectsRoot: root.dir, projectId: 'demo-07', now: new Date(CREATED_AT) })
    writeFileSync(created.paths.antiAiTemplateActions, '# 项目级词表占位（Story 8 填写）\n', 'utf8')
    const resolved = resolveAntiAiTemplateActionsPath(created.paths, REPO_ROOT)
    expect(resolved.scope).toBe('project')
    expect(resolved.path).toBe(created.paths.antiAiTemplateActions)
  })
})
