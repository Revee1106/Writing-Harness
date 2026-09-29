import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadProposals, saveProposals } from '../../src/project/project.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import {
  CONFLICT_RESOLUTIONS,
  checkProposalDistinctness,
  computeSeedPreservationRate,
  type Proposal,
} from '../../src/schema/proposal.ts'
import { validateSeedFile } from '../../src/schema/seed.ts'
import { parseProposalFieldPath } from '../../src/core/proposal-field-paths.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_FIXTURES_DIR, SEED_FIXTURES_DIR_STORY2, STORY2_SEEDS_DIR, recordedProvider, story2SeedPath } from '../helpers/story2.ts'

/**
 * Story 3 验收测试（《开发 Story 拆分》Story 3「验收」+ 用户追加要求）。
 * 全部离线：Proposal 内容来自 tests/fixtures/recorded/story_developer 的 15 个 fixture。
 */

const DEV_FIXTURES_DIR = join(RECORDED_FIXTURES_DIR, '..', 'story_developer')
const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story3-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

/** 10 类 Seed 的离线端到端：Seed → Interpreter → Gate 1(skip) → Story Developer。 */
async function developTypedSeed(fileName: string): Promise<{
  proposals: readonly Proposal[]
  rawSeedAnchorIds: readonly string[]
  notices: readonly { code: string; message: string }[]
}> {
  const rawInput = readFileSync(story2SeedPath(fileName), 'utf8')
  const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
  const candidate = seedFromInterpreterResult(rawInput, interpreter)
  const seed = applyGate1Operations(candidate, [{ kind: 'skip' }]).seed
  const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
  return {
    proposals: result.file.proposals,
    rawSeedAnchorIds: seed.story_seed.raw_seed_anchor_ids,
    notices: result.notices,
  }
}

describe('验收 1：每个 Seed 产出 2～3 个 Proposal，且离线可复现', () => {
  it('10 类 Seed 全部产出 2 个方案（schema 允许 2～3）', async () => {
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      const { proposals } = await developTypedSeed(fileName)
      expect(proposals.length, fileName).toBeGreaterThanOrEqual(2)
      expect(proposals.length, fileName).toBeLessThanOrEqual(3)
      expect(proposals.map((proposal) => proposal.proposal_id)).toEqual(
        proposals.map((_unused, index) => ['PROP_A', 'PROP_B', 'PROP_C'][index]),
      )
    }
  })

  it('同一输入两次生成结果完全一致（可复现）', async () => {
    const first = await developTypedSeed('02-mystery.txt')
    const second = await developTypedSeed('02-mystery.txt')
    expect(second.proposals).toEqual(first.proposals)
    expect(second.notices).toEqual(first.notices)
  })
})

describe('验收 2：差异不是措辞差异', () => {
  it('10 类 Seed 的方案对全部通过差异度判定，且没有 DISTINCTNESS 告警', async () => {
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      const { proposals, notices } = await developTypedSeed(fileName)
      const report = checkProposalDistinctness(proposals)
      expect(report.ok, `${fileName}: ${report.warnings.join('；')}`).toBe(true)
      expect(notices.filter((notice) => notice.code === 'DISTINCTNESS'), fileName).toEqual([])
    }
  })

  it('两个方案只在措辞上不同时会产生 DISTINCTNESS 告警（不阻塞）', async () => {
    const rawInput = readFileSync(join(STORY2_SEEDS_DIR, '..', 'story3/12-distinctness-probe.txt'), 'utf8')
    const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    const seed = applyGate1Operations(seedFromInterpreterResult(rawInput, interpreter), [{ kind: 'skip' }]).seed
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    const warnings = result.notices.filter((notice) => notice.code === 'DISTINCTNESS')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('差异不足')
    // 依然产出可用的 2 个方案（需求规格 §28：不卡住用户，可由用户"重做"）
    expect(result.file.proposals).toHaveLength(2)
  })
})

describe('验收 3：USER_GIVEN 冲突可被记录', () => {
  it('01-emotion 的 PROP_B 记录了 2 处 altered + 2 处 conflicts，resolution=pending', async () => {
    const { proposals, notices } = await developTypedSeed('01-emotion.txt')
    const propB = proposals[1] as Proposal
    expect(propB.seed_fidelity.altered).toHaveLength(2)
    expect(propB.conflicts).toHaveLength(2)
    for (const conflict of propB.conflicts) {
      expect(CONFLICT_RESOLUTIONS).toContain(conflict.resolution)
      expect(conflict.resolution).toBe('pending')
      expect(conflict.user_value.length).toBeGreaterThan(0)
      expect(conflict.proposal_value.length).toBeGreaterThan(0)
    }
    expect(notices.filter((notice) => notice.code === 'CONFLICT_PENDING').length).toBeGreaterThan(0)
  })

  it('冲突指向的锚点必须是 raw_seed_anchor（分母内）或 Gate 1 提升项，且可解析', async () => {
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      const { proposals } = await developTypedSeed(fileName)
      for (const proposal of proposals) {
        for (const conflict of proposal.conflicts) {
          expect(conflict.seed_ref).toMatch(/^SEED_[FA]\d{3}$/)
          expect(parseProposalFieldPath(`PROP_A.${conflict.proposal_field}`)).not.toBeNull()
        }
      }
    }
  })
})

describe('验收 4：至少 10 个 Seed 的 Proposal 均通过 seed_fidelity 机器可算', () => {
  it('10 类 Seed × 全部方案都能算出 Seed Preservation Rate，且没有未处置锚点', async () => {
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      const { proposals, rawSeedAnchorIds, notices } = await developTypedSeed(fileName)
      expect(rawSeedAnchorIds.length, fileName).toBeGreaterThan(0)
      for (const proposal of proposals) {
        const rate = computeSeedPreservationRate(proposal, rawSeedAnchorIds)
        expect(rate.denominator, fileName).toBe(rawSeedAnchorIds.length)
        expect(rate.rate, fileName).not.toBeNull()
        expect(rate.rate_percent, fileName).toBeGreaterThan(0)
        expect(rate.rate_percent, fileName).toBeLessThanOrEqual(100)
        expect(rate.unaccounted_anchor_ids, `${fileName} / ${proposal.proposal_id}`).toEqual([])
      }
      expect(notices.filter((notice) => notice.code === 'SEED_REF_UNACCOUNTED'), fileName).toEqual([])
    }
  })

  it('分子只数 preserved：altered 的锚点不计入（01-emotion 的 PROP_B）', async () => {
    const { proposals, rawSeedAnchorIds } = await developTypedSeed('01-emotion.txt')
    const propB = proposals[1] as Proposal
    const rate = computeSeedPreservationRate(propB, rawSeedAnchorIds)
    expect(propB.seed_fidelity.altered).toHaveLength(2)
    expect(rate.numerator).toBe(3)
    expect(rate.denominator).toBe(5)
    expect(rate.rate_percent).toBe(60)
    expect(rate.preserved_anchor_ids).toEqual(['SEED_F001', 'SEED_F002', 'SEED_F005'])
  })

  it('分母为 0 的 Seed（无 raw_seed 锚点）→ rate = null，并有 EMPTY_DENOMINATOR 告警', async () => {
    const rawInput = readFileSync(join(STORY2_SEEDS_DIR, '..', 'story3/13-no-anchor-probe.txt'), 'utf8')
    const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    const seed = applyGate1Operations(seedFromInterpreterResult(rawInput, interpreter), [{ kind: 'skip' }]).seed
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    expect(seed.story_seed.raw_seed_anchor_ids).toEqual([])
    for (const proposal of result.file.proposals) {
      const rate = computeSeedPreservationRate(proposal, seed.story_seed.raw_seed_anchor_ids)
      expect(rate.denominator).toBe(0)
      expect(rate.rate).toBeNull()
      expect(rate.notices.map((notice) => notice.code)).toContain('EMPTY_DENOMINATOR')
    }
    expect(result.notices.map((notice) => notice.code)).toContain('EMPTY_DENOMINATOR')
  })

  it('Gate 1 提升项被引用时作为额外约束记录，不参与分子分母（需求规格 §10.2）', async () => {
    const rawInput = readFileSync(story2SeedPath('07-single-scene.txt'), 'utf8')
    const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    const candidate = seedFromInterpreterResult(rawInput, interpreter)
    const seed = applyGate1Operations(candidate, [{ kind: 'promote', id: 'SEED_A001' }]).seed
    expect(seed.story_seed.gate1_status).toBe('partial')
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    const rate = computeSeedPreservationRate(result.file.proposals[0] as Proposal, seed.story_seed.raw_seed_anchor_ids)
    expect(rate.denominator).toBe(4)
    expect(rate.out_of_denominator_refs).toEqual(['SEED_A001'])
    expect(rate.notices.map((notice) => notice.code)).toContain('SEED_REF_NOT_ANCHOR')
    expect(result.notices.map((notice) => notice.code)).toContain('SEED_REF_NOT_ANCHOR')
  })
})

describe('验收 5：Harness 新增内容不会成为 USER_GIVEN', () => {
  it('全部方案的 seed_fidelity.added 都是 PROPOSED / harness，且不出现在任何 USER_GIVEN 集合', async () => {
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      const { proposals } = await developTypedSeed(fileName)
      const rawInput = readFileSync(story2SeedPath(fileName), 'utf8')
      const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
      const seed = applyGate1Operations(seedFromInterpreterResult(rawInput, interpreter), [{ kind: 'skip' }]).seed
      const userGivenValues = new Set([
        ...seed.story_seed.fixed_by_user.map((item) => item.value),
        ...seed.story_seed.ambiguous.map((item) => item.value),
      ])
      for (const proposal of proposals) {
        expect(proposal.seed_fidelity.added.length, fileName).toBeGreaterThan(0)
        for (const added of proposal.seed_fidelity.added) {
          expect(added.status, fileName).toBe('PROPOSED')
          expect(added.source, fileName).toBe('harness')
          expect(userGivenValues.has(added.value), `${fileName}: ${added.value}`).toBe(false)
        }
        // preserved 里的 value_in_proposal 只是"该锚点的体现"，不产生新的 USER_GIVEN 项
        expect(proposal.seed_fidelity.preserved.length).toBeGreaterThan(0)
      }
    }
  })

  it('每个方案都至少声明一条 added 与一条 risk（差异与喧宾夺主风险必须显式）', async () => {
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      const { proposals } = await developTypedSeed(fileName)
      for (const proposal of proposals) {
        expect(proposal.seed_fidelity.added.length, `${fileName}/${proposal.proposal_id}`).toBeGreaterThan(0)
        expect(proposal.seed_fidelity.risk.length, `${fileName}/${proposal.proposal_id}`).toBeGreaterThan(0)
        for (const risk of proposal.seed_fidelity.risk) {
          expect(risk.related_addition_refs.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('验收 6：proposals.yaml 结构与产物边界', () => {
  it('顶层结构为 schema_version + proposals，可写盘回读', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('05-light-scifi.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc3-01', rawInput })
    const paths = projectPaths(root.dir, 'acc3-01')
    const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    const seed = applyGate1Operations(seedFromInterpreterResult(rawInput, interpreter), [{ kind: 'skip' }]).seed
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    saveProposals(paths, result.file)
    const reloaded = loadProposals(paths)
    expect(reloaded.schema_version).toBe('0.1')
    expect(reloaded.proposals).toHaveLength(2)
    expect(reloaded).toEqual(result.file)
  })

  it('不新增文件结构：Story 3 只写 proposals.yaml（需求规格 §29）', async () => {
    const root = tempRoot()
    const rawInput = readFileSync(story2SeedPath('10-growth.txt'), 'utf8')
    createProject({ projectsRoot: root.dir, projectId: 'acc3-02', rawInput })
    const paths = projectPaths(root.dir, 'acc3-02')
    const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    const seed = applyGate1Operations(seedFromInterpreterResult(rawInput, interpreter), [{ kind: 'skip' }]).seed
    const result = await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    saveProposals(paths, result.file)

    const topLevel = readdirSync(paths.dir).sort()
    // 需求规格 §29 / 架构设计 §32 的项目文件树；Story 3 只新增 proposals.yaml
    expect(topLevel).toEqual([
      'config',
      'drafts',
      'history',
      'proposals.yaml',
      'project-config.yaml',
      'reports',
      'scenes',
      'seed.yaml',
      'style',
    ].sort())
    expect(topLevel).not.toContain('proposals.md')
    // 场景 / 正文 / 报告目录保持为空（Story 5 之后才填充）
    for (const subdir of ['scenes', 'drafts', 'history', 'reports']) {
      expect(readdirSync(join(paths.dir, subdir)), subdir).toEqual([])
    }
  })
})

describe('验收 7：source_refs.type=proposal 字段路径可解析', () => {
  it('每个方案的核心字段都能生成合法且可解析的 proposal 引用', async () => {
    const { proposals } = await developTypedSeed('03-realism.txt')
    for (const proposal of proposals) {
      for (const fieldPath of ['core_premise', 'core_conflict', 'truth_or_turn', 'character_arc', 'ending']) {
        const ref = `${proposal.proposal_id}.${fieldPath}`
        const parsed = parseProposalFieldPath(ref)
        expect(parsed, ref).toEqual({ proposalId: proposal.proposal_id, fieldPath })
      }
      // 列表项引用使用下标形式
      const addedRef = `${proposal.proposal_id}.seed_fidelity.added[0].value`
      expect(parseProposalFieldPath(addedRef)).toEqual({
        proposalId: proposal.proposal_id,
        fieldPath: 'seed_fidelity.added[N].value',
      })
      const riskRef = `${proposal.proposal_id}.seed_fidelity.risk[0].value`
      expect(parseProposalFieldPath(riskRef)).toEqual({
        proposalId: proposal.proposal_id,
        fieldPath: 'seed_fidelity.risk[N].value',
      })
    }
  })

  it('不存在的字段路径被拒绝（不允许自由字符串）', () => {
    expect(parseProposalFieldPath('PROP_A.not_a_field')).toBeNull()
    expect(parseProposalFieldPath('PROP_A.seed_fidelity.unknown[0].value')).toBeNull()
  })
})

describe('验收 8：Story 3 的数据源边界与 Seed 完整性', () => {
  it('Story Developer 只读 seed.yaml：seed 未被 Proposal 流程改写', async () => {
    const rawInput = readFileSync(story2SeedPath('09-dark-humor.txt'), 'utf8')
    const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    const seed = applyGate1Operations(seedFromInterpreterResult(rawInput, interpreter), [{ kind: 'skip' }]).seed
    const snapshot = JSON.parse(JSON.stringify(seed))
    await runStoryDeveloper({ provider: RecordedProvider.fromDirectory(DEV_FIXTURES_DIR), seed })
    expect(JSON.parse(JSON.stringify(seed))).toEqual(snapshot)
    expect(validateSeedFile(seed).story_seed.raw_input).toBe(rawInput)
  })

  it('fixture 集合覆盖 10 类 Seed + 3 个探针 + demo Seed（15 个）', () => {
    const files = readdirSync(DEV_FIXTURES_DIR).filter((name) => name.endsWith('.yaml'))
    expect(files).toHaveLength(15)
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      // fixture 文件名去掉 .txt 后缀
      expect(files, fileName).toContain(fileName.replace(/\.txt$/, '.yaml'))
    }
    expect(files).toContain('12-distinctness-probe.yaml')
    expect(files).toContain('13-no-anchor-probe.yaml')
    expect(files).toContain('07-single-scene-promoted.yaml')
  })
})
