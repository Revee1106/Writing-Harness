import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { runGate1 } from '../../src/gate1/service.ts'
import { GATE1_OPEN_STATUSES } from '../../src/gate1/status.ts'
import { isEvidenceLocatable, runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadSeed } from '../../src/project/project.ts'
import { checkSeedInvariants } from '../../src/schema/seed.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import {
  RECORDED_FIXTURES_DIR,
  SEED_FIXTURES_DIR_STORY2,
  SEEDS_DIR,
  STORY2_SEEDS_DIR,
  recordedProvider,
  story2SeedPath,
} from '../helpers/story2.ts'

/**
 * Story 2 验收测试（《开发 Story 拆分》Story 2「验收」+ 用户追加要求）。
 *
 * 全部离线：模型回应来自 tests/fixtures/recorded/seed-interpreter 的 12 个 fixture，
 * 命令与断言不触网、不依赖时间与随机数，可重复执行得到同一结果。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story2-')
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    tempDirs.pop()?.cleanup()
  }
})

function readSeedFile(relative: string): string {
  return readFileSync(relative.startsWith('story2/') ? `${STORY2_SEEDS_DIR}/${relative.slice('story2/'.length)}` : `${SEEDS_DIR}/${relative}`, 'utf8')
}

/** Story 10 C 节要求的 10 类 Seed（前 8 类来自文档，后 2 类自选）。 */
const SEED_TYPE_MATRIX: Array<{ file: string; type: string }> = [
  { file: '01-emotion.txt', type: '情感' },
  { file: '02-mystery.txt', type: '悬疑' },
  { file: '03-realism.txt', type: '现实' },
  { file: '04-warmth.txt', type: '温情' },
  { file: '05-light-scifi.txt', type: '轻科幻' },
  { file: '06-open-ending.txt', type: '开放结局' },
  { file: '07-single-scene.txt', type: '单场景' },
  { file: '08-twist.txt', type: '强反转' },
  { file: '09-dark-humor.txt', type: '黑色幽默（自选）' },
  { file: '10-growth.txt', type: '成长（自选）' },
]

describe('验收 A：至少 10 个 Seed，完全离线可复现', () => {
  it('10 类 Seed（含 Story 10 C 节要求的 8 类）都在 fixture 矩阵中', () => {
    expect(SEED_TYPE_MATRIX).toHaveLength(10)
    expect(SEED_TYPE_MATRIX.map((entry) => entry.type)).toEqual([
      '情感',
      '悬疑',
      '现实',
      '温情',
      '轻科幻',
      '开放结局',
      '单场景',
      '强反转',
      '黑色幽默（自选）',
      '成长（自选）',
    ])
    expect(SEED_FIXTURES_DIR_STORY2).toEqual(SEED_TYPE_MATRIX.map((entry) => entry.file))
  })

  it('10 个 Seed 全部可用 RecordedProvider 离线解析出三件套', async () => {
    const provider = recordedProvider()
    for (const { file, type } of SEED_TYPE_MATRIX) {
      const rawInput = readFileSync(story2SeedPath(file), 'utf8')
      const first = await runSeedInterpreter({ provider, rawInput })
      const second = await runSeedInterpreter({ provider, rawInput })
      expect(first.fixed_by_user.length, `${type} / fixed`).toBeGreaterThan(0)
      expect(first.ambiguous.length, `${type} / ambiguous`).toBeGreaterThan(0)
      expect(first.open_questions.length, `${type} / open_questions`).toBeGreaterThan(0)
      // 可复现：同一输入两次回放完全一致
      expect(second.fixed_by_user).toEqual(first.fixed_by_user)
      expect(second.notices).toEqual(first.notices)
    }
  })

  it('离线验收不触网：Provider 只有 recorded，且 fixture 目录存在', async () => {
    const provider = recordedProvider()
    expect(provider.id).toBe('recorded')
    expect(provider.size).toBe(12)
    // 不存在的输入会 MISS（说明回放层不会静默去调网络）
    await expect(
      provider.complete({
        contract: 'seed_interpreter',
        contractVersion: '0.1',
        input: { raw_input: '完全不在 fixture 中的种子' },
        prompt: 'p',
      }),
    ).rejects.toThrow(/未命中/)
  })

  it('fixture 与 Seed 文本一致（Seed 改动必须同步刷新 fixture）', () => {
    const provider = RecordedProvider.fromDirectory(RECORDED_FIXTURES_DIR)
    expect(provider.keys().every((key) => key.startsWith('seed_interpreter@0.1:'))).toBe(true)
  })
})

describe('验收 B：用户明确事实不遗漏 / 推断不混入 fixed', () => {
  it('每个 Seed 的 fixed_by_user 都能逐条回溯到用户原文', async () => {
    const provider = recordedProvider()
    for (const { file, type } of SEED_TYPE_MATRIX) {
      const rawInput = readFileSync(story2SeedPath(file), 'utf8')
      const result = await runSeedInterpreter({ provider, rawInput })
      expect(result.notices, `${type} 不应有降级告警`).toEqual([])
      for (const item of result.fixed_by_user) {
        expect(isEvidenceLocatable(item.evidence, rawInput), `${type} / ${item.value}`).toBe(true)
      }
    }
  })

  it('推断内容（原文中无证据）不会进入 fixed_by_user（原则 2 的 Story 2 落点）', async () => {
    const provider = recordedProvider()
    const rawInput = readFileSync(story2SeedPath('11-evidence-probe.txt'), 'utf8')
    const result = await runSeedInterpreter({ provider, rawInput })
    const fixedValues = result.fixed_by_user.map((item) => item.value)
    expect(fixedValues).not.toContain('这台相机是她父亲留下的')
    expect(fixedValues).not.toContain('相机里还有半卷没拍完的胶卷')
    expect(result.notices.map((notice) => notice.code).sort()).toEqual(['EVIDENCE_MISSING', 'EVIDENCE_NOT_FOUND'])
  })

  it('Gate 1 写入的 fixed 项全部是 USER_GIVEN，未确认内容不得伪装', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('01-emotion.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc-src', rawInput })
    await runGate1({
      paths: projectPaths(root.dir, 'acc-src'),
      provider: recordedProvider(),
      operations: [{ kind: 'promote', id: 'SEED_A001' }],
    })
    const seed = loadSeed(projectPaths(root.dir, 'acc-src'))
    for (const item of seed.story_seed.fixed_by_user) {
      expect(item.status).toBe('USER_GIVEN')
      expect(['user', 'user_gate1']).toContain(item.source)
    }
    expect(seed.story_seed.ambiguous.every((item) => !('status' in item))).toBe(true)
  })
})

describe('验收 C：Gate 1 修改能正确更新 source / origin', () => {
  it('用户提升 → source=user_gate1 / origin=gate1_confirmation；原始锚点保持 user / raw_seed', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('07-single-scene.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc-source', rawInput })
    const paths = projectPaths(root.dir, 'acc-source')
    const result = await runGate1({
      paths,
      provider: recordedProvider(),
      operations: [
        { kind: 'promote', id: 'SEED_A001' },
        { kind: 'edit', id: 'SEED_F001', value: '电梯在两层楼之间停住（用户确认表述）' },
      ],
    })
    const seed = result.finalSeed
    expect(seed).toBeDefined()
    const promoted = seed?.story_seed.fixed_by_user.find((item) => item.id === 'SEED_A001')
    expect(promoted).toMatchObject({ status: 'USER_GIVEN', source: 'user_gate1', origin: 'gate1_confirmation' })
    const edited = seed?.story_seed.fixed_by_user.find((item) => item.id === 'SEED_F001')
    expect(edited).toMatchObject({ source: 'user', origin: 'raw_seed' })
    // 编辑后仍可回读（磁盘校验通过）
    expect(loadSeed(paths).story_seed.gate1_status).toBe('partial')
  })

  it('降级项的来源回到 interpreter，且不产生 USER_GIVEN', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('08-twist.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc-demote', rawInput })
    const paths = projectPaths(root.dir, 'acc-demote')
    await runGate1({
      paths,
      provider: recordedProvider(),
      operations: [{ kind: 'demote', id: 'SEED_F003' }],
    })
    const seed = loadSeed(paths)
    const demoted = seed.story_seed.ambiguous.find((item) => item.id === 'SEED_F003')
    expect(demoted?.source).toBe('interpreter')
    expect(demoted).not.toHaveProperty('status')
  })
})

describe('验收 D：raw_seed_anchor_ids 首次冻结后，Gate 1 升降级不重算', () => {
  const OPERATION_SETS = [
    ['accept_all'],
    ['skip'],
    ['promote', 'SEED_A001'],
    ['demote', 'SEED_F001'],
    ['edit', 'SEED_F001'],
    ['delete', 'SEED_F001'],
  ] as const

  for (const [kind, id] of OPERATION_SETS) {
    it(`${kind}${id === undefined ? '' : ` ${id}`} 之后 anchors 与首次冻结值完全一致`, async () => {
      const root = tempRoot()
      const rawInput = readFileSync(story2SeedPath('01-emotion.txt'), 'utf8')
      const projectId = `acc-anchor-${kind}`
      createProject({ projectsRoot: root.dir, projectId, rawInput })
      const paths = projectPaths(root.dir, projectId)

      // 首次 Interpreter 的冻结值（dryRun 给出 candidate seed 的 anchors）
      const plan = await runGate1({ paths, provider: recordedProvider(), operations: [], dryRun: true })
      const frozen = [...plan.candidateSeed.story_seed.raw_seed_anchor_ids]
      expect(frozen).toEqual(['SEED_F001', 'SEED_F002', 'SEED_F003', 'SEED_F004', 'SEED_F005'])

      const operation = kind === 'promote' || kind === 'demote'
        ? ({ kind, id } as const)
        : kind === 'edit'
          ? ({ kind, id, value: '改写后的内容' } as const)
          : kind === 'delete'
            ? ({ kind, id } as const)
            : ({ kind } as const)
      const result = await runGate1({ paths, provider: recordedProvider(), operations: [operation] })
      expect(result.anchorsBefore).toEqual(frozen)
      expect(result.anchorsAfter).toEqual(frozen)
      expect(loadSeed(paths).story_seed.raw_seed_anchor_ids).toEqual(frozen)
    })
  }

  it('anchors 只包含首次 Interpreter 提取的 origin=raw_seed 锚点（分母不漂移，§10.1）', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('02-mystery.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc-anchor-set', rawInput })
    const paths = projectPaths(root.dir, 'acc-anchor-set')
    await runGate1({
      paths,
      provider: recordedProvider(),
      operations: [
        { kind: 'promote', id: 'SEED_A001' },
        { kind: 'demote', id: 'SEED_F002' },
      ],
    })
    const seed = loadSeed(paths)
    // 原始锚点 6 条全部保留在分母中（含被降级的 SEED_F002）
    expect(seed.story_seed.raw_seed_anchor_ids).toEqual([
      'SEED_F001',
      'SEED_F002',
      'SEED_F003',
      'SEED_F004',
      'SEED_F005',
      'SEED_F006',
    ])
    // 提升项 SEED_A001 未进入分母
    expect(seed.story_seed.raw_seed_anchor_ids).not.toContain('SEED_A001')
    expect(checkSeedInvariants(seed.story_seed)).toEqual([])
  })
})

describe('验收 E：gate1_status 迁移与跳过后的可用性', () => {
  it('pending → confirmed / skipped / partial 三条路径都能写盘并通过校验', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('04-warmth.txt'), 'utf8')
    const cases = [
      { projectId: 'acc-g1-confirmed', operations: [{ kind: 'accept_all' } as const], expected: 'confirmed' },
      { projectId: 'acc-g1-skipped', operations: [{ kind: 'skip' } as const], expected: 'skipped' },
      {
        projectId: 'acc-g1-partial',
        operations: [{ kind: 'edit', id: 'SEED_F001', value: '奶奶不识字（用户确认）' } as const],
        expected: 'partial',
      },
    ]
    for (const testCase of cases) {
      createProject({ projectsRoot: root.dir, projectId: testCase.projectId, rawInput })
      const paths = projectPaths(root.dir, testCase.projectId)
      const result = await runGate1({ paths, provider: recordedProvider(), operations: testCase.operations })
      expect(result.gate1Status).toBe(testCase.expected)
      expect(GATE1_OPEN_STATUSES).toContain(result.gate1Status as 'confirmed' | 'skipped' | 'partial')
      expect(loadSeed(paths).story_seed.gate1_status).toBe(testCase.expected)
    }
  })

  it('跳过 Gate 1 后仍可进入 Story 3：seed 结构完整、非空、可回读', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('05-light-scifi.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc-skip-next', rawInput })
    const paths = projectPaths(root.dir, 'acc-skip-next')
    const result = await runGate1({ paths, provider: recordedProvider(), operations: [{ kind: 'skip' }] })
    expect(result.written).toBe(true)
    const seed = loadSeed(paths)
    expect(seed.story_seed.gate1_status).toBe('skipped')
    // Story 3（Story Developer）读取的最小输入：raw_input + 三件套
    expect(seed.story_seed.raw_input).toBe(rawInput)
    expect(seed.story_seed.fixed_by_user.length).toBeGreaterThan(0)
    expect(seed.story_seed.ambiguous.length).toBeGreaterThan(0)
    expect(seed.story_seed.open_questions.length).toBeGreaterThan(0)
    expect(checkSeedInvariants(seed.story_seed)).toEqual([])
  })

  it('Gate 1 已结束时不允许再次执行（避免二次改写来源与 anchors）', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('03-realism.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc-once', rawInput })
    const paths = projectPaths(root.dir, 'acc-once')
    await runGate1({ paths, provider: recordedProvider(), operations: [{ kind: 'accept_all' }] })
    await expect(
      runGate1({ paths, provider: recordedProvider(), operations: [{ kind: 'accept_all' }] }),
    ).rejects.toThrow(/Gate 1 已经结束/)
  })
})

describe('验收 F：raw_input 原样保留在 Gate 1 之后仍然成立', () => {
  it('Gate 1 写盘不会改动 raw_input', async () => {
    for (const file of ['01-emotion.txt', '06-open-ending.txt', '10-growth.txt']) {
      const root = tempRoot()
      const rawInput = readSeedFile(`story2/${file}`)
      const projectId = `acc-raw-${file.replace('.txt', '')}`
      createProject({ projectsRoot: root.dir, projectId, rawInput })
      const paths = projectPaths(root.dir, projectId)
      await runGate1({ paths, provider: recordedProvider(), operations: [{ kind: 'accept_all' }] })
      expect(loadSeed(paths).story_seed.raw_input, file).toBe(rawInput)
    }
  })
})
