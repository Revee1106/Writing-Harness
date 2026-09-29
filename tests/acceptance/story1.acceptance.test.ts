import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseStatusItem, statusItemSchema } from '../../src/core/item.ts'
import { SOURCES, STATUS } from '../../src/core/status.ts'
import {
  FORBIDDEN_TRANSITIONS,
  recordUsage,
  transitionStatus,
} from '../../src/core/state-machine.ts'
import { dumpYaml, loadYaml } from '../../src/io/yaml.ts'
import { createProject, loadProject, setRawSeedInput } from '../../src/project/project.ts'
import { projectPaths } from '../../src/io/paths.ts'
import {
  LINTER_RULE_KEYS,
  ProjectConfigValidationError,
  validateProjectConfig,
} from '../../src/schema/project-config.ts'
import { validateSeedFile } from '../../src/schema/seed.ts'
import { GOLDEN_DIR, SEED_FIXTURES_DIR, makeTempDir, type TempDir } from '../helpers/tmp.ts'

/**
 * Story 1 验收测试（8 条，逐条对应《开发 Story 拆分》Story 1「验收」+ Story 1 验收增强）。
 * 每条 it 的标题即为验收条款，便于汇报时逐条核对。
 */

const GOLDEN_NOW = new Date('2026-01-01T00:00:00.000Z')
const GOLDEN_PROJECT_ID = 'golden-demo'
const GOLDEN_SEED_FILE = join(GOLDEN_DIR, 'seed.yaml')

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-acceptance-')
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    tempDirs.pop()?.cleanup()
  }
})

function markdownSeed(): string {
  return readFileSync(join(SEED_FIXTURES_DIR, 'markdown.md'), 'utf8')
}

describe('Story 1 验收（8 条）', () => {
  it('验收 1：可创建新短篇项目', () => {
    const root = tempRoot()
    const created = createProject({
      projectsRoot: root.dir,
      projectId: 'acc-01',
      title: '验收项目',
      targetLength: 12000,
      now: GOLDEN_NOW,
    })
    expect(existsSync(created.paths.seed)).toBe(true)
    expect(existsSync(created.paths.projectConfig)).toBe(true)
    const loaded = loadProject(root.dir, 'acc-01')
    expect(loaded.projectConfig.project).toMatchObject({ id: 'acc-01', title: '验收项目', target_length: 12000 })
  })

  it('验收 2：可保存用户 raw input', () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'acc-02', now: GOLDEN_NOW })
    const paths = projectPaths(root.dir, 'acc-02')
    const saved = setRawSeedInput(paths, markdownSeed())
    expect(saved.story_seed.raw_input).toBe(markdownSeed())
  })

  it('验收 3：用户原话原样保留（三种输入形态 + golden 快照）', () => {
    const root = tempRoot()
    for (const [index, fileName] of ['one-line.txt', 'multi-sentence.txt', 'markdown.md'].entries()) {
      const source = readFileSync(join(SEED_FIXTURES_DIR, fileName), 'utf8')
      const projectId = `acc-03-${index}`
      const created = createProject({ projectsRoot: root.dir, projectId, rawInput: source, now: GOLDEN_NOW })
      const onDisk = readFileSync(created.paths.seed, 'utf8')
      expect(validateSeedFile(loadYaml(onDisk)).story_seed.raw_input, fileName).toBe(source)
    }

    // golden 快照：固定 now + 固定输入 → 文件字节级稳定
    const goldenProject = createProject({
      projectsRoot: root.dir,
      projectId: GOLDEN_PROJECT_ID,
      title: '清单',
      rawInput: markdownSeed(),
      now: GOLDEN_NOW,
    })
    expect(existsSync(GOLDEN_SEED_FILE), `缺少 golden 快照：${GOLDEN_SEED_FILE}`).toBe(true)
    expect(readFileSync(goldenProject.paths.seed, 'utf8')).toBe(readFileSync(GOLDEN_SEED_FILE, 'utf8'))
    // project-config.yaml 同样是确定性产物，一并做 golden 比对
    const goldenConfigFile = join(GOLDEN_DIR, 'project-config.yaml')
    expect(existsSync(goldenConfigFile), `缺少 golden 快照：${goldenConfigFile}`).toBe(true)
    expect(readFileSync(goldenProject.paths.projectConfig, 'utf8')).toBe(readFileSync(goldenConfigFile, 'utf8'))
  })

  it('验收 4：状态 / source 可序列化', () => {
    const item = parseStatusItem({
      id: 'SEED_F001',
      value: '妻子已经死亡',
      status: 'USER_GIVEN',
      source: 'user',
      origin: 'raw_seed',
      source_ref: { type: 'seed', ref_id: 'SEED_F001' },
    })
    expect(statusItemSchema.parse(loadYaml(dumpYaml(item)))).toEqual(item)
    expect(STATUS).toHaveLength(4)
    expect(SOURCES).toContain('interpreter')
  })

  it('验收 5：不存在自动状态升级', () => {
    let item = parseStatusItem({ id: 'ITEM_001', value: 'Harness 补出的设定', status: 'PROPOSED', source: 'harness' })
    item = recordUsage(item, 'SCENE_BREAKDOWN_REFERENCE')
    item = recordUsage(item, 'WRITER_REFERENCE')
    item = recordUsage(item, 'DRAFT_CONTAINS')
    expect(item.status).toBe('PROPOSED')
    expect(item.source).toBe('harness')
    // 只有 Gate 2 证据才能升级
    const confirmed = transitionStatus(item, 'CONFIRMED', { trigger: 'GATE2_CONFIRM' })
    expect(confirmed.status).toBe('CONFIRMED')
    expect(item.status).toBe('PROPOSED')
  })

  it('验收 6：状态机非法流转可被单元测试拦截（F1–F6 + G1）', () => {
    expect(FORBIDDEN_TRANSITIONS).toHaveLength(7)
    expect(FORBIDDEN_TRANSITIONS.map((rule) => rule.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'G1'])
    for (const rule of FORBIDDEN_TRANSITIONS) {
      expect(rule.docRef.length).toBeGreaterThan(0)
    }
    // 逐条拦截细节见 tests/unit/state-machine.test.ts 的表驱动用例
    expect(transitionStatus).toBeTypeOf('function')
  })

  it('验收 7：project-config.yaml 有最小 schema 定义', () => {
    const root = tempRoot()
    const created = createProject({ projectsRoot: root.dir, projectId: 'acc-07', now: GOLDEN_NOW })
    const config = created.projectConfig
    expect(config.schema_version).toBe('0.1')
    expect(Object.keys(config.linter.rules)).toEqual([...LINTER_RULE_KEYS])
    expect(config.draft_context.max_chars).toBe(600)
    expect(() => validateProjectConfig({ schema_version: '0.1' })).toThrow(ProjectConfigValidationError)
    expect(readFileSync(created.paths.projectConfig, 'utf8')).toContain('draft_context:')
  })

  it('验收 8：单元测试全绿（本文件与 tests/unit 由 vitest 统一运行，此处断言元数据自检）', () => {
    // 规则表规模、状态枚举规模、linter 规则数与文档一致；实际执行结果由 `pnpm test` 退出码保证
    expect(FORBIDDEN_TRANSITIONS).toHaveLength(7)
    expect(STATUS).toHaveLength(4)
    expect(LINTER_RULE_KEYS).toHaveLength(5)
  })
})
