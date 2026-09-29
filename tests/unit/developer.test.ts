import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  STORY_DEVELOPER_CONTRACT_ID,
  STORY_DEVELOPER_CONTRACT_VERSION,
  StoryDeveloperOutputError,
  UnresolvableSeedRefError,
  buildDeveloperInput,
  runStoryDeveloper,
} from '../../src/developer/developer.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadProposals, loadSeed, proposalsExist, saveProposals } from '../../src/project/project.ts'
import { computeSeedPreservationRate } from '../../src/schema/proposal.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import type { SeedFile } from '../../src/schema/seed.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_FIXTURES_DIR, SEEDS_DIR, StubProvider, recordedProvider, story2SeedPath } from '../helpers/story2.ts'

const DEV_FIXTURES_DIR = join(RECORDED_FIXTURES_DIR, '..', 'story_developer')
const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-developer-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

/** 复现 fixture 对应的 Gate 1 后状态（与 fixture 元数据 gate1_ops 一致）。 */
async function seedAfterGate1(fileName: string, ops: Parameters<typeof applyGate1Operations>[1] = [{ kind: 'skip' }]): Promise<SeedFile> {
  const rawInput = readFileSync(story2SeedPath(fileName), 'utf8')
  const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
  const candidate = seedFromInterpreterResult(rawInput, interpreter)
  return applyGate1Operations(candidate, ops).seed
}

describe('Story Developer 契约与输入构造', () => {
  it('契约版本与 id 冻结', () => {
    expect(STORY_DEVELOPER_CONTRACT_ID).toBe('story_developer')
    expect(STORY_DEVELOPER_CONTRACT_VERSION).toBe('0.1')
  })

  it('结构化输入只包含 seed 三件套 + Gate 1 状态 + 可选风格偏好（数据源边界）', async () => {
    const seed = await seedAfterGate1('01-emotion.txt')
    const input = buildDeveloperInput(seed, '冷一点')
    expect(Object.keys(input).sort()).toEqual([
      'ambiguous',
      'fixed_by_user',
      'gate1_status',
      'open_questions',
      'raw_input',
      'raw_seed_anchor_ids',
      'style_preference',
    ])
    // 不把 status / source / origin 之外的内部字段泄漏给模型
    expect(input.fixed_by_user).toEqual([
      { id: 'SEED_F001', value: '两人是情侣且都深爱对方' },
      { id: 'SEED_F002', value: '两人因为一件小事争吵' },
      { id: 'SEED_F003', value: '女方提出了分手' },
      { id: 'SEED_F004', value: '女方只要男方认错就愿意留下' },
      { id: 'SEED_F005', value: '男方认为每次都是小题大做' },
    ])
  })
})

describe('开发者输出解析与 ID 规范化（I-13 / I-19）', () => {
  it('离线回放可以生成 2 个方案并分配 PROP_A / PROP_B', async () => {
    const seed = await seedAfterGate1('01-emotion.txt')
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    expect(result.file.proposals.map((proposal) => proposal.proposal_id)).toEqual(['PROP_A', 'PROP_B'])
    expect(result.provider).toBe('recorded')
    expect(result.inputSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('模型写错编号时按数组顺序重编号，并把 related_addition_refs 重写为规范 ID', async () => {
    const seed = await seedAfterGate1('01-emotion.txt')
    const provider = new StubProvider(
      [
        'proposals:',
        "  - title: 'A'",
        "    genre: 'g'",
        "    core_premise: 'pa'",
        "    core_conflict: 'ca'",
        "    truth_or_turn: 'ta'",
        "    character_arc: 'aa'",
        "    ending: 'ea'",
        '    pov: [CH_A]',
        '    target_length: 5000',
        "    tone: 't'",
        '    seed_fidelity:',
        '      preserved: []',
        '      altered: []',
        '      added:',
        "        - id: 'ADD_007'",
        "          value: '第一个新增'",
        '          status: PROPOSED',
        '          source: harness',
        "        - id: 'ADD_003'",
        "          value: '第二个新增'",
        '          status: PROPOSED',
        '          source: harness',
        '      risk:',
        "        - id: 'RISK_009'",
        "          value: '风险'",
        "          related_addition_refs: ['ADD_003']",
        '    conflicts: []',
        "  - title: 'B'",
        "    genre: 'g'",
        "    core_premise: 'pb'",
        "    core_conflict: 'cb'",
        "    truth_or_turn: 'tb'",
        "    character_arc: 'ab'",
        "    ending: 'eb'",
        '    pov: [CH_A]',
        '    target_length: 5000',
        "    tone: 't'",
        '    seed_fidelity:',
        '      preserved: []',
        '      altered: []',
        '      added: []',
        '      risk: []',
        '    conflicts: []',
      ].join('\n'),
    )
    const result = await runStoryDeveloper({ provider, seed })
    const first = result.file.proposals[0]
    expect(first?.seed_fidelity.added.map((entry) => entry.id)).toEqual(['ADD_001', 'ADD_002'])
    expect(first?.seed_fidelity.risk[0]?.id).toBe('RISK_001')
    // ADD_003 是模型给的第二个新增项 → 规范 ID 应为 ADD_002
    expect(first?.seed_fidelity.risk[0]?.related_addition_refs).toEqual(['ADD_002'])
  })

  it('无法解析的引用直接报错（不让 Harness 猜）', async () => {
    const seed = await afterGate1Seed()
    const provider = new StubProvider(
      [
        'proposals:',
        "  - title: 'A'",
        "    genre: 'g'",
        "    core_premise: 'p'",
        "    core_conflict: 'c'",
        "    truth_or_turn: 't'",
        "    character_arc: 'a'",
        "    ending: 'e'",
        '    pov: [CH_A]',
        '    target_length: 5000',
        "    tone: 't'",
        '    seed_fidelity:',
        '      preserved: []',
        '      altered: []',
        '      added: []',
        '      risk:',
        "        - id: 'RISK_001'",
        "          value: 'r'",
        "          related_addition_refs: ['ADD_999']",
        '    conflicts: []',
        "  - title: 'B'",
        "    genre: 'g'",
        "    core_premise: 'p2'",
        "    core_conflict: 'c2'",
        "    truth_or_turn: 't2'",
        "    character_arc: 'a2'",
        "    ending: 'e2'",
        '    pov: [CH_A]',
        '    target_length: 5000',
        "    tone: 't'",
        '    seed_fidelity:',
        '      preserved: []',
        '      altered: []',
        '      added: []',
        '      risk: []',
        '    conflicts: []',
      ].join('\n'),
    )
    await expect(runStoryDeveloper({ provider, seed })).rejects.toBeInstanceOf(StoryDeveloperOutputError)
  })

  it('非法 YAML / 方案数量越界都会明确报错', async () => {
    const seed = await afterGate1Seed()
    await expect(runStoryDeveloper({ provider: new StubProvider('这不是 YAML: ['), seed })).rejects.toBeInstanceOf(
      StoryDeveloperOutputError,
    )
    await expect(
      runStoryDeveloper({ provider: new StubProvider('proposals: []'), seed }),
    ).rejects.toBeInstanceOf(StoryDeveloperOutputError)
  })

  it('引用不存在的 Seed item 时报 UnresolvableSeedRefError（§7.2 必须可解析）', async () => {
    const seed = await afterGate1Seed()
    const provider = new StubProvider(
      [
        'proposals:',
        "  - title: 'A'",
        "    genre: 'g'",
        "    core_premise: 'p'",
        "    core_conflict: 'c'",
        "    truth_or_turn: 't'",
        "    character_arc: 'a'",
        "    ending: 'e'",
        '    pov: [CH_A]',
        '    target_length: 5000',
        "    tone: 't'",
        '    seed_fidelity:',
        '      preserved:',
        '        - seed_ref: SEED_F042',
        "          value_in_proposal: 'v'",
        '      altered: []',
        '      added: []',
        '      risk: []',
        '    conflicts: []',
        "  - title: 'B'",
        "    genre: 'g'",
        "    core_premise: 'p2'",
        "    core_conflict: 'c2'",
        "    truth_or_turn: 't2'",
        "    character_arc: 'a2'",
        "    ending: 'e2'",
        '    pov: [CH_A]',
        '    target_length: 5000',
        "    tone: 't'",
        '    seed_fidelity:',
        '      preserved: []',
        '      altered: []',
        '      added: []',
        '      risk: []',
        '    conflicts: []',
      ].join('\n'),
    )
    await expect(runStoryDeveloper({ provider, seed })).rejects.toBeInstanceOf(UnresolvableSeedRefError)
  })

  async function afterGate1Seed(): Promise<SeedFile> {
    return seedAfterGate1('04-warmth.txt')
  }
})

describe('落地与边界（proposals.yaml / 提示词契约）', () => {
  it('提示词包含用户在 Gate 1 确认的内容与锚点清单', async () => {
    const seed = await seedAfterGate1('01-emotion.txt')
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    expect(result.prompt).toContain('raw_seed_anchor_ids: SEED_F001, SEED_F002, SEED_F003, SEED_F004, SEED_F005')
    expect(result.prompt).toContain('两人是情侣且都深爱对方')
    expect(result.prompt).toContain('gate1_status: skipped')
    expect(result.prompt).not.toContain('{{')
  })

  it('proposals.yaml 可写入并回读，且不产生 proposals.md（Story 3 明文）', async () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'dev-01' })
    const paths = projectPaths(root.dir, 'dev-01')
    const seed = await seedAfterGate1('04-warmth.txt')
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    expect(proposalsExist(paths)).toBe(false)
    saveProposals(paths, result.file)
    expect(proposalsExist(paths)).toBe(true)
    expect(loadProposals(paths)).toEqual(result.file)
    expect(paths.proposals.endsWith('proposals.yaml')).toBe(true)
  })

  it('develop 服务不修改 seed.yaml（Proposal 不得回写 Seed）', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(join(SEEDS_DIR, 'story2/04-warmth.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'dev-02', rawInput })
    const paths = projectPaths(root.dir, 'dev-02')
    const before = loadSeed(paths)
    const provider = RecordedProvider.fromDirectory(DEV_FIXTURES_DIR)
    const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    const candidate = seedFromInterpreterResult(rawInput, interpreter)
    const seed = applyGate1Operations(candidate, [{ kind: 'skip' }]).seed
    await runStoryDeveloper({ provider, seed })
    expect(loadSeed(paths)).toEqual(before)
  })

  it('Seed Preservation Rate 在 Proposal 层可直接计算（Story 3 验收）', async () => {
    const seed = await seedAfterGate1('01-emotion.txt')
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    for (const proposal of result.file.proposals) {
      const rate = computeSeedPreservationRate(proposal, seed.story_seed.raw_seed_anchor_ids)
      expect(rate.denominator).toBe(5)
      expect(rate.numerator).toBeGreaterThan(0)
      expect(rate.rate_percent).toBeGreaterThan(0)
    }
  })
})
