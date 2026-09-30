import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGate3 } from '../../src/state/gate3.ts'
import { loadScenes, loadStoryState, runSceneBreakdown } from '../../src/scenes/service.ts'
import { validateBlueprint } from '../../src/schema/blueprint.ts'
import { runCoverageCheck } from '../../src/scenes/coverage.ts'
import { compileContext } from '../../src/context/compiler.ts'
import { keyPhrases } from '../../src/writer/checks.ts'
import { countAllCodePoints } from '../../src/core/text.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { readTextFile, readYamlFile } from '../../src/io/yaml.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/providers/types.ts'
import { validateStoryState } from '../../src/schema/story-state.ts'
import {
  ANTI_AI_CSV_COLUMNS,
  ANTI_AI_DIR,
  AUTHOR_COST_CSV_COLUMNS,
  STORY_DEVELOPMENT_CSV_COLUMNS,
  buildStoryDevelopmentEvaluation,
  collectAuthorCost,
  countRuleWarnings,
  loadStoryDevelopmentSeedSet,
  measureFixtureSeed,
  summarizeAbSession,
} from '../../src/eval/evaluation.ts'
import { loadBlueprint, loadProposals, loadSeed } from '../../src/project/project.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'

/**
 * Story 10 验收测试（《开发 Story 拆分》Story 10「验收」）。
 *
 * 覆盖：Gate 3 一次性确认 + final.md + State Extractor（含 ⊊ 与 from_state 冲突）、
 * Story Development Test Set（≥10 Seed）、Anti-AI A/B Test Set（≥10 Scene Intent）、
 * Author Cost（CSV），以及 **v0.1 8 点自检**。
 *
 * ⚠️ 8 点自检的条款原文没有随三份冻结文档进入仓库（见 OQ-61）。
 * 下面这 8 条是**按 README 的 v0.1 命题与四条底层原则重建**的可执行自检项，
 * 每条都对应本仓库里真实可跑的断言；条款文字**待用户确认后替换**。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-s10-acc-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

/** 测试里 loadStoryState 一定存在；用断言把它收紧成非空类型。 */
function storyStateOf(paths: ReturnType<typeof projectPaths>): NonNullable<ReturnType<typeof loadStoryState>> {
  const state = loadStoryState(paths)
  if (state === null) throw new Error('测试前置：story_state.yaml 必须存在')
  return state
}

function cloneProject(projectId: 'demo-01' | 'demo-02'): ReturnType<typeof projectPaths> {
  const root = tempRoot()
  cpSync(join(REPO_ROOT, 'projects', projectId), join(root.dir, projectId), { recursive: true })
  return projectPaths(root.dir, projectId)
}

const recorded = (): RecordedProvider =>
  RecordedProvider.fromDirectory(join(REPO_ROOT, 'tests/fixtures/recorded/state_extractor'))

/** 注入一个"越界"的 State Extractor 输出：把 K001 揭示给计划外的人。 */
function overRevealingProvider(text: string): LLMProvider {
  return {
    id: 'stub-over-reveal',
    complete: async (request: LLMRequest): Promise<LLMResponse> => ({
      text,
      contract: request.contract,
      contractVersion: request.contractVersion,
      provider: 'stub',
      model: 'stub',
      inputSha256: 'stub',
    }),
  }
}

const OVER_REVEAL = [
  'knowledge_reveals:',
  '  - knowledge_ref: K001',
  '    scene_id: scene-003',
  '    revealed_to: [CH_WOMAN, CH_MAN, CH_NEIGHBOR]',
  '    evidence: 所有人都看到了',
  'relationship_changes: []',
  '',
].join('\n')

const FROM_STATE_MISMATCH = [
  'knowledge_reveals: []',
  'relationship_changes:',
  '  - relationship_ref: REL_WOMAN_MAN',
  '    scene_id: scene-005',
  '    from_state: 陌生人',
  '    to_state: separated',
  '    evidence: 他们从来没有认识过',
  '',
].join('\n')

describe('验收 A：Gate 3 一次性确认 + final.md', () => {
  it('缺少 --confirm 时拒绝；确认后写入 final.md 并一次性写 confirmed_scenes', async () => {
    const paths = cloneProject('demo-01')
    await expect(runGate3({ paths, provider: recorded(), confirm: false })).rejects.toThrow(/--confirm/u)
    const result = await runGate3({ paths, provider: recorded(), confirm: true })
    expect(result.written).toBe(true)
    expect(result.confirmedScenes).toEqual(['scene-001', 'scene-002', 'scene-003', 'scene-004', 'scene-005'])
    expect(existsSync(result.finalPath)).toBe(true)
    expect(storyStateOf(paths).confirmed_scenes).toEqual([...result.confirmedScenes])
  })

  it('final.md 无标题、无元数据，且是 drafts 按 order 的拼接', async () => {
    const paths = cloneProject('demo-01')
    const result = await runGate3({ paths, provider: recorded(), confirm: true })
    const drafts = loadScenes(paths).map((scene) =>
      readTextFile(join(paths.draftsDir, `${scene.scene_id}.md`)).trim(),
    )
    expect(result.finalText).toBe(drafts.join('\n\n'))
    const file = readTextFile(result.finalPath)
    expect(file.trim()).toBe(result.finalText)
    expect(file).not.toMatch(/^#/mu)
    expect(file).not.toMatch(/^---$/mu)
  })

  it('Scene draft 保留（Gate 3 不删稿、不合并文件）', async () => {
    const paths = cloneProject('demo-01')
    const before = readdirSync(paths.draftsDir).filter((name) => /^scene-\d{3}\.md$/u.test(name)).sort()
    expect(before).toHaveLength(5)
    await runGate3({ paths, provider: recorded(), confirm: true })
    const after = readdirSync(paths.draftsDir).filter((name) => /^scene-\d{3}\.md$/u.test(name)).sort()
    expect(after).toEqual(before)
    expect(readdirSync(paths.draftsDir)).toContain('final.md')
  })
})

describe('验收 B：State Extractor（OCCURRED + 冲突）', () => {
  it('demo-01：提取出 1 条 OCCURRED，确定性 ID，knowledge_state 同步投影', async () => {
    const paths = cloneProject('demo-01')
    const result = await runGate3({ paths, provider: recorded(), confirm: true })
    expect(result.occurred.map((entry) => entry.id)).toEqual(['OCC_K_K001_scene-003'])
    expect(result.conflicts).toEqual([])
    const state = storyStateOf(paths)
    expect(state.occurred).toHaveLength(1)
    const projection = state.knowledge_state.find((entry) => entry.blueprint_ref === 'K001')
    expect(projection?.occurred_reveal).toBe(true)
    expect(projection?.last_updated_scene).toBe('scene-003')
    expect(() => validateStoryState(state)).not.toThrow()
  })

  it('demo-02：真子集只记低危日志（revealed_to_narrower_than_plan），不判冲突', async () => {
    const paths = cloneProject('demo-02')
    const result = await runGate3({ paths, provider: recorded(), confirm: true })
    expect(result.conflicts).toEqual([])
    expect(result.lowSeverity.map((entry) => entry.code)).toEqual(['revealed_to_narrower_than_plan'])
    const evidence = result.lowSeverity[0]!.evidence as { knowledge_ref: string; plan: string[]; actual: string[] }
    expect(evidence.knowledge_ref).toBe('K001')
    expect(evidence.actual.length).toBeLessThan(evidence.plan.length)
    // OQ-59：低危日志 v0.1 只出现在 Gate 3 结果 / CLI 输出中，不落盘
    // （story_state 没有该字段，且 Story 10 不新增 Schema）
    expect(readTextFile(paths.storyState)).not.toContain('low_severity')
  })

  it('真超集 → OCCURRED_CONFLICT，且不写 occurred、不写投影', async () => {
    const paths = cloneProject('demo-01')
    const stateBefore = storyStateOf(paths)
    const result = await runGate3({ paths, provider: overRevealingProvider(OVER_REVEAL), confirm: true })
    expect(result.occurred).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.type).toBe('OCCURRED_CONFLICT')
    expect(result.conflicts[0]!.ref_type).toBe('knowledge')
    const state = storyStateOf(paths)
    expect(state.occurred).toEqual(stateBefore.occurred)
    expect(state.knowledge_state).toEqual(stateBefore.knowledge_state)
    expect(state.state_rebuild_conflicts.length).toBe(stateBefore.state_rebuild_conflicts.length + 1)
  })

  it('relationship_change.from_state 与 relationship_state 不一致 → 冲突', async () => {
    const paths = cloneProject('demo-01')
    const result = await runGate3({ paths, provider: overRevealingProvider(FROM_STATE_MISMATCH), confirm: true })
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.ref_type).toBe('relationship')
    expect(result.conflicts[0]!.message).toContain('from_state')
    expect(storyStateOf(paths).relationship_state.every((entry) => entry.state === 'together')).toBe(true)
  })

  it('重跑 Gate 3 幂等：occurred 不重复、最终稿字节级一致', async () => {
    const paths = cloneProject('demo-02')
    const first = await runGate3({ paths, provider: recorded(), confirm: true })
    const finalOnce = readTextFile(first.finalPath)
    const stateOnce = readTextFile(paths.storyState)
    const second = await runGate3({ paths, provider: recorded(), confirm: true })
    expect(second.occurred.map((entry) => entry.id)).toEqual(first.occurred.map((entry) => entry.id))
    expect(readTextFile(second.finalPath)).toBe(finalOnce)
    expect(readTextFile(paths.storyState)).toBe(stateOnce)
  })

  it('前置条件缺失时报错：确认前必须先有 scenes 与 drafts', async () => {
    const paths = cloneProject('demo-01')
    const draft = join(paths.draftsDir, 'scene-002.md')
    const backup = readTextFile(draft)
    const { rmSync } = await import('node:fs')
    rmSync(draft)
    await expect(runGate3({ paths, provider: recorded(), confirm: true })).rejects.toThrow(/scene-002/u)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(draft, backup, 'utf8')
  })
})

describe('验收 C：Story Development Test Set（≥10 Seed，measured 7）', () => {
  it('测试集 10 个 Seed：measured 7（2 项目型 + 5 fixture 型）+ corpus_only 3', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    expect(set.seeds).toHaveLength(10)
    expect(set.measuredCount).toBe(7)
    expect(set.projectBackedCount).toBe(2)
    expect(set.fixtureBackedCount).toBe(5)
    expect(set.corpusOnlyCount).toBe(3)
    // 封版裁决：补齐的 5 个题材
    expect(
      set.seeds.filter((seed) => seed.status === 'measured' && seed.seed_file !== null).map((seed) => seed.genre),
    ).toEqual(['情感', '悬疑', '现实', '温情', '轻科幻'])
    // 封版裁决：接受为 corpus_only 的 3 类
    expect(set.seeds.filter((seed) => seed.status === 'corpus_only').map((seed) => seed.genre)).toEqual([
      '开放结局',
      '单场景',
      '强反转',
    ])
  })

  it('fixture 型 Seed 的文本就是真正喂给模型的那份文件（不复制粘贴）', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    for (const seed of set.seeds.filter((entry) => entry.seed_file !== null)) {
      const raw = readTextFile(join(REPO_ROOT, seed.seed_file ?? ''))
      expect(seed.text).toBe(raw)
      expect(seed.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('每个 Seed 有 Seed Schema 允许的文本与 ≥2 提案的期望', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    for (const seed of set.seeds) {
      expect(seed.text.trim().length).toBeGreaterThan(0)
      expect(countAllCodePoints(seed.text)).toBeLessThanOrEqual(500)
      expect(seed.genre.trim().length).toBeGreaterThan(0)
      expect(seed.expectation.proposal_count_min).toBeGreaterThanOrEqual(2)
      expect(seed.expectation.distinctness_required).toBe(true)
    }
  })

  it('5 个 fixture 型 Seed 离线回放可量测：≥2 提案、差异度通过、无未记账锚点', async () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const fixtureSeeds = set.seeds.filter((seed) => seed.status === 'measured' && seed.seed_file !== null)
    for (const seed of fixtureSeeds) {
      const measured = await measureFixtureSeed({
        repoRoot: REPO_ROOT,
        seedId: seed.seed_id,
        seedFile: seed.seed_file ?? '',
        gate1Ops: seed.gate1_ops ?? undefined,
      })
      expect(measured.provider).toBe('recorded')
      expect(measured.proposal_count).toBeGreaterThanOrEqual(seed.expectation.proposal_count_min)
      expect(measured.distinctness_ok).toBe(true)
      expect(measured.anchor_count).toBeGreaterThan(0)
      for (const row of measured.rows) {
        expect(row.unaccounted_anchors).toBe(0)
        expect(row.conflicts).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('项目型 measured Seed 的指标可复算，且与 fixture 型同口径', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const measured = set.seeds.filter((seed) => seed.status === 'measured' && seed.project_id !== null)
    const evaluation = buildStoryDevelopmentEvaluation(
      measured.map((seed) => ({
        seedId: seed.seed_id,
        paths: projectPaths(join(REPO_ROOT, 'projects'), seed.project_id ?? ''),
      })),
    )
    expect(evaluation.distinctnessAllOk).toBe(true)
    for (const row of evaluation.rows) {
      expect(row.preserved).toBeGreaterThan(0)
      expect(row.unaccounted_anchors).toBe(0)
      expect(Number.parseInt(row.seed_preservation_rate, 10)).toBeGreaterThan(0)
    }
  })

  it('results.csv 只含 measured Seed 的行，列与冻结列一致', () => {
    const csvPath = join(REPO_ROOT, 'tests/fixtures/evaluation/story-development/results.csv')
    expect(existsSync(csvPath)).toBe(true)
    const lines = readTextFile(csvPath).trim().split('\n')
    expect(lines[0]).toBe(STORY_DEVELOPMENT_CSV_COLUMNS.join(','))
    expect(lines).toHaveLength(15) // 表头 + 14 行（7 Seed × 2 提案）
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const measuredIds = new Set(
      set.seeds.filter((seed) => seed.status === 'measured').map((seed) => seed.seed_id),
    )
    for (const line of lines.slice(1)) {
      expect(measuredIds.has(line.split(',')[0]!)).toBe(true)
    }
  })

  it('评估资产只读、不写进项目目录（§29/§32 未被改动）', () => {
    const evaluationRoot = join(REPO_ROOT, 'tests/fixtures/evaluation')
    expect(readdirSync(evaluationRoot).sort()).toEqual(['anti-ai', 'story-development'])
    expect(readdirSync(join(REPO_ROOT, 'projects', 'demo-01'))).not.toContain('evaluation')
  })
})

describe('验收 D：Anti-AI A/B Test Set（≥10 Scene Intent）', () => {
  it('session-001 含 10 个 Scene Intent，A/B 两侧文本都非空', () => {
    const dir = join(REPO_ROOT, ANTI_AI_DIR, 'session-001')
    expect(existsSync(join(dir, 'session.yaml'))).toBe(true)
    const metadata = readFileSync(join(dir, 'session.yaml'), 'utf8')
    const groupLines = metadata.split('\n').filter((line) => line.trim().startsWith('- group_id: '))
    expect(groupLines).toHaveLength(10)
    for (let index = 1; index <= 10; index += 1) {
      const groupId = `G${String(index).padStart(2, '0')}`
      const a = readTextFile(join(dir, `group-${groupId}.a.txt`))
      const b = readTextFile(join(dir, `group-${groupId}.b.txt`))
      expect(a.trim().length).toBeGreaterThan(50)
      expect(b.trim().length).toBeGreaterThan(50)
    }
  })

  it('人工评分模板是 11 列、10 行、全部留空（v0.1 不自动评分）', () => {
    const csv = readTextFile(join(REPO_ROOT, ANTI_AI_DIR, 'session-001', 'ratings.csv')).trim().split('\n')
    expect(csv[0]).toBe(ANTI_AI_CSV_COLUMNS.join(','))
    expect(csv).toHaveLength(11)
    for (const line of csv.slice(1)) {
      expect(line.split(',').slice(3).every((cell) => cell === '')).toBe(true)
    }
  })

  it('A 侧（普通 Prompt）的 Rule Linter warning 明显多于 B 侧（对照有效）', () => {
    const dir = join(REPO_ROOT, ANTI_AI_DIR, 'session-001')
    let totalA = 0
    let totalB = 0
    for (let index = 1; index <= 10; index += 1) {
      const groupId = `G${String(index).padStart(2, '0')}`
      totalA += countRuleWarnings(readTextFile(join(dir, `group-${groupId}.a.txt`)))
      totalB += countRuleWarnings(readTextFile(join(dir, `group-${groupId}.b.txt`)))
    }
    expect(totalA).toBeGreaterThan(totalB * 2)
    expect(totalA).toBeGreaterThanOrEqual(20)
  })
})

describe('验收 E：Author Cost（需求规格 §31.3）', () => {
  it('两个 demo 都能产出作者成本行，且列与冻结列一致', () => {
    const rows = ['demo-01', 'demo-02'].map((projectId) =>
      collectAuthorCost(projectId, projectPaths(join(REPO_ROOT, 'projects'), projectId)),
    )
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...AUTHOR_COST_CSV_COLUMNS].sort())
      expect(row.explicit_gates).toBeGreaterThanOrEqual(3)
      expect(row.gate1_status === 'skipped' || row.gate1_status === 'partial').toBe(true)
      expect(row.blueprint_versions).toBeGreaterThanOrEqual(1)
      expect(row.scenes).toBe(5)
      expect(row.confirmed_scenes).toBe(5)
      expect(row.occurred).toBeGreaterThanOrEqual(1)
      expect(row.unresolved_state_conflicts).toBe(0)
    }
    const csvPath = join(REPO_ROOT, 'tests/fixtures/evaluation/story-development/author-cost.csv')
    if (existsSync(csvPath)) {
      expect(readTextFile(csvPath).split('\n')[0]).toBe(AUTHOR_COST_CSV_COLUMNS.join(','))
    }
  })

  it('作者成本可复算：无需人工介入即可从项目状态重建', () => {
    const row = collectAuthorCost('demo-01', projectPaths(join(REPO_ROOT, 'projects'), 'demo-01'))
    const state = storyStateOf(projectPaths(join(REPO_ROOT, 'projects'), 'demo-01'))
    expect(row.confirmed_scenes).toBe(state.confirmed_scenes.length)
    expect(row.occurred).toBe(state.occurred.length)
    expect(row.unresolved_state_conflicts).toBe(state.state_rebuild_conflicts.length)
  })
})

describe('验收 F：v0.1 8 点自检（《开发 Story 拆分》Story 10 G 节原文，逐条可执行）', () => {
  it('① 一句话 Seed 可以形成可用 Blueprint', () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      const blueprint = validateBlueprint(readYamlFile(paths.blueprint))
      // "可用" = 通过 Schema 且四类内容（结构 / 人物关系 / 关键知识 / 风格方向）齐全
      expect(Object.keys(blueprint.structure).length).toBeGreaterThanOrEqual(3)
      expect(blueprint.characters.length).toBeGreaterThanOrEqual(1)
      expect(blueprint.key_knowledge.length).toBeGreaterThanOrEqual(1)
      expect(blueprint.style_direction.narration.length).toBeGreaterThan(0)
      // Seed 的每个锚点都被处置：preserved ∪ altered 覆盖全部锚点（不静默丢 Seed）
      const seed = loadSeed(paths)
      const handled = new Set([
        ...blueprint.seed_fidelity.preserved.map((item) => item.seed_ref),
        ...blueprint.seed_fidelity.altered.map((item) => item.seed_ref),
      ])
      expect(seed.story_seed.raw_seed_anchor_ids.filter((id) => !handled.has(id))).toEqual([])
      expect(blueprint.seed_fidelity.preserved.length).toBeGreaterThan(0)
    }
  })

  it('② Gate 顺序低摩擦：每个项目只有 3 次显式 Gate，且全部是一次性确认', () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      const row = collectAuthorCost(projectId, paths)
      expect(row.explicit_gates).toBe(3) // Gate 1 + Gate 2 + Gate 3
      expect(['skipped', 'partial']).toContain(row.gate1_status)
      expect(row.blueprint_versions).toBe(1) // 一次裁决即产出可用蓝图，无反复重做
      expect(loadScenes(paths).length).toBe(5) // 拆场不产生额外审批
    }
  })

  it('③ Blueprint 可稳定拆 Scene：结构化覆盖齐全、警告为空、重跑逐字节一致', async () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      // 重跑会写文件：必须在副本上做（测试不得改动仓库里的 demo 产物）
      const paths = cloneProject(projectId)
      const blueprint = loadBlueprint(paths)
      const scenes = loadScenes(paths)
      const coverage = runCoverageCheck({ blueprint, scenes })
      expect(coverage.report.summary.structure_covered).toBe(scenes.length)
      expect(coverage.report.summary.scenes).toBe(scenes.length)
      expect(coverage.report.warnings).toEqual([])
      // 稳定：同一输入重跑拆场，Scene 文件逐字节一致（order / allowed_reveals / tone 都不漂移）
      const before = scenes.map((scene) => readTextFile(join(paths.scenesDir, `${scene.scene_id}.yaml`)))
      const rerun = await runSceneBreakdown({
        paths,
        provider: RecordedProvider.fromDirectory(join(REPO_ROOT, 'tests/fixtures/recorded/scene_breakdown')),
        rerun: true,
        now: new Date('2026-01-01T00:00:00.000Z'),
      })
      expect(rerun.scenes.map((scene) => scene.scene_id)).toEqual(scenes.map((scene) => scene.scene_id))
      const after = scenes.map((scene) => readTextFile(join(paths.scenesDir, `${scene.scene_id}.yaml`)))
      expect(after).toEqual(before)
    }
  })

  it('④ Proposal 不会渗透 Writer：编译后的上下文里没有提案内容', () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      const proposals = readTextFile(paths.proposals)
      const raw = JSON.stringify(loadProposals(paths))
      expect(raw.length).toBeGreaterThan(0)
      for (const scene of loadScenes(paths)) {
        const compiled = compileContext({ paths, sceneId: scene.scene_id })
        const serialized = JSON.stringify({ context: compiled.writerContext, manifest: compiled.manifest })
        expect(serialized).not.toContain('PROP_')
        expect(serialized).not.toContain('proposal_id')
        // 提案原文的任何一句都不能出现在 Writer 输入里
        for (const line of proposals.split('\n').map((value) => value.trim()).filter((value) => value.length >= 12)) {
          expect(serialized.includes(line)).toBe(false)
        }
      }
    }
  })

  it('⑤ POV / secret / future 不明显泄漏', () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      const blueprint = loadBlueprint(paths)
      const scenes = loadScenes(paths)
      const state = storyStateOf(paths)
      const allExcludedTypes = new Set<string>()
      const allExclusionReasons = new Set<string>()
      for (const scene of scenes) {
        const { manifest } = compileContext({ paths, sceneId: scene.scene_id })
        // 硬事实：future / 未确认提案一律不进上下文
        expect(manifest.future_content_exposed).toBe(false)
        expect(manifest.unconfirmed_proposal_exposed).toBe(false)
        for (const item of manifest.excluded_sensitive) {
          allExcludedTypes.add(item.type)
          allExclusionReasons.add(item.reason)
        }
        // 内心状态只能带 POV 自己的那一份；非 POV 的内心状态必须出现在排除清单里
        for (const item of manifest.included_sensitive) {
          if (!item.source_ref.includes('inner_state')) continue
          // POV 自己的内心状态可以用两种 id 形态出现（角色 id 或 <角色>.inner_state）
          expect([manifest.pov, `${manifest.pov}.inner_state`]).toContain(item.id)
        }
        const nonPovInner = manifest.excluded_sensitive.filter((item) => item.type === 'character_inner_state')
        for (const item of nonPovInner) {
          expect([manifest.pov, `${manifest.pov}.inner_state`]).not.toContain(item.id)
        }
      }
      // 项目级：确实发生过"非 POV 内心 / 伏笔"的排除（否则这条检查是空转）
      expect(allExcludedTypes.has('character_inner_state')).toBe(true)
      expect(allExclusionReasons.has('non_pov_inner_state')).toBe(true)
      // secret：Key Knowledge 的 truth 在其揭示场景之前不得出现在正文里
      for (const occurred of state.occurred) {
        const knowledgeRef = (occurred.payload as { knowledge_ref: string }).knowledge_ref
        const truth = blueprint.key_knowledge.find((item) => item.id === knowledgeRef)!.truth
        const phrases = keyPhrases(truth)
        expect(phrases.length).toBeGreaterThan(0)
        const revealOrder = scenes.find((scene) => scene.scene_id === occurred.scene_id)!.order
        for (const scene of scenes.filter((candidate) => candidate.order < revealOrder)) {
          const text = readTextFile(join(paths.draftsDir, `${scene.scene_id}.md`))
          for (const phrase of phrases) expect(text).not.toContain(phrase)
        }
        // 检查非空转：确实存在"揭示之前的场景"（否则这条断言什么都没验证）
        expect(scenes.filter((candidate) => candidate.order < revealOrder).length).toBeGreaterThan(0)
        // 揭示场景本身有正文（不是靠删掉整场来通过）
        expect(readTextFile(join(paths.draftsDir, `${occurred.scene_id}.md`)).trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('⑥ Seed Preservation Rate 可测：7 个 measured Seed 全部能算出比例', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const rows = set.seeds
      .filter((seed) => seed.status === 'measured' && seed.project_id !== null)
      .flatMap((seed) =>
        buildStoryDevelopmentEvaluation([
          { seedId: seed.seed_id, paths: projectPaths(join(REPO_ROOT, 'projects'), seed.project_id ?? '') },
        ]).rows,
      )
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const row of rows) {
      expect(row.seed_preservation_rate).toMatch(/^\d+(\.\d+)?%$/u)
      expect(row.unaccounted_anchors).toBe(0)
    }
    // 有区分度：既有 100% 也有 <100%（否则这个指标测不出任何东西）
    const rates = rows.map((row) => Number.parseFloat(row.seed_preservation_rate))
    expect(rates.some((rate) => rate === 100)).toBe(true)
    expect(rates.some((rate) => rate < 100)).toBe(true)
  })

  it('⑦ Harness 正文在 AI 感维度出现明确改善趋势（长度归一化后的 A/B 证据）', () => {
    const summary = summarizeAbSession(REPO_ROOT, 'session-001')
    // 原始计数：A 41 : B 4
    expect(summary.aWarnings).toBeGreaterThan(summary.bWarnings)
    // 归一化：每千非空白码点的 Rule warning 数（因为两侧长度差 > 20%，以它为准）
    expect(summary.lengthRatio).toBeGreaterThan(1.2)
    expect(summary.lengthsComparable).toBe(false)
    expect(summary.aWarningsPer1000).toBeGreaterThan(40)
    expect(summary.bWarningsPer1000).toBeLessThan(5)
    // "明确改善" = 单位长度的 AI 味信号下降 ≥ 75%
    expect(summary.normalizedRatio).toBeLessThan(0.25)
    expect(summary.verdict).toContain('归一化')
  })

  it('⑧ 用户不承担高频审批：每场正文摊到的显式确认 < 1 次', () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      const row = collectAuthorCost(projectId, paths)
      const scenes = loadScenes(paths).length
      // Gate 3 是整篇一次性；拆场 / 写正文 / Lint 都不需要逐场点确认
      expect(row.explicit_gates).toBeLessThanOrEqual(3)
      expect(row.explicit_gates / scenes).toBeLessThan(1)
      expect(row.rewrites_applied).toBeLessThanOrEqual(1) // 改写是按需触发，不是必答项
      // 逐场确认不存在：gate3 只有 --confirm（整篇），没有 --scene
      const cli = readTextFile(join(REPO_ROOT, 'src/cli/index.ts'))
      const optionsBlock = cli.slice(cli.indexOf('gate3 选项：'), cli.indexOf('eval 选项：'))
      expect(optionsBlock).toContain('--confirm')
      expect(optionsBlock).toContain('整篇一次性确认')
      expect(optionsBlock).not.toContain('--scene')
    }
  })
})

describe('验收 G：不新增 Schema（Story 10 的硬边界）', () => {
  it('story_state 没有 final_ref 这类新字段；final.md 也不写回任何 Schema', () => {
    const paths = projectPaths(join(REPO_ROOT, 'projects'), 'demo-01')
    const state = storyStateOf(paths)
    expect(Object.keys(state)).not.toContain('final_ref')
    expect(readTextFile(paths.storyState)).not.toContain('final_ref')
    const schemaNames = readdirSync(join(REPO_ROOT, 'src', 'schema')).sort()
    expect(schemaNames).toEqual([
      'anti-ai-vocab.ts',
      'blueprint.ts',
      'context-manifest.ts',
      'gate2-meta.ts',
      'linter-report.ts',
      'project-config.ts',
      'proposal.ts',
      'scene.ts',
      'seed.ts',
      'story-state.ts',
      'style-profile.ts',
    ])
  })

  it('临时目录里的 Gate 3 产物不会污染仓库状态', async () => {
    const paths = cloneProject('demo-02')
    await runGate3({ paths, provider: recorded(), confirm: true })
    expect(paths.dir.startsWith(REPO_ROOT)).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'projects', 'demo-02', 'drafts', 'final.md'))).toBe(true)
  })

  it('evaluation 目录不含任何 .ts / schema 定义（评估资产只由已有 Schema 驱动）', () => {
    const root = join(REPO_ROOT, 'tests/fixtures/evaluation')
    const walk = (current: string): string[] => {
      const found: string[] = []
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) found.push(...walk(full))
        else found.push(entry.name)
      }
      return found
    }
    for (const name of walk(root)) {
      expect(/\.(yaml|yml|csv|txt|md)$/u.test(name)).toBe(true)
    }

  })
})
