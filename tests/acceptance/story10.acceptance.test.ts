import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGate3 } from '../../src/state/gate3.ts'
import { loadScenes, loadStoryState } from '../../src/scenes/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { readTextFile } from '../../src/io/yaml.ts'
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
} from '../../src/eval/evaluation.ts'
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

describe('验收 C：Story Development Test Set（≥10 Seed）', () => {
  it('测试集至少 10 个 Seed，且每个 Seed 有 Seed Schema 允许的文本', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    expect(set.seeds.length).toBeGreaterThanOrEqual(10)
    for (const seed of set.seeds) {
      expect(seed.text.trim().length).toBeGreaterThan(0)
      expect(seed.title.trim().length).toBeGreaterThan(0)
      expect(['single', 'dual']).toContain(seed.pov_hint)
    }
  })

  it('测试集里已跑的 Seed 都产出 ≥2 个提案且差异度通过', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const measured = set.seeds.filter((seed) => seed.status === 'measured')
    expect(measured.length).toBeGreaterThanOrEqual(2)
    const evaluation = buildStoryDevelopmentEvaluation(
      measured.map((seed) => ({
        seedId: seed.seed_id,
        paths: projectPaths(join(REPO_ROOT, 'projects'), seed.project_id ?? ''),
      })),
    )
    expect(evaluation.distinctnessAllOk).toBe(true)
    expect(evaluation.proposalCount).toBeGreaterThanOrEqual(measured.length * 2)
    for (const row of evaluation.rows) {
      expect(row.preserved).toBeGreaterThan(0)
      expect(row.unaccounted_anchors).toBe(0)
      expect(Number.parseInt(row.seed_preservation_rate, 10)).toBeGreaterThan(0)
    }
  })

  it('评估结果 CSV 的列与冻结列一致（不新增列）', () => {
    const csvPath = join(REPO_ROOT, 'tests/fixtures/evaluation/story-development/results.csv')
    if (!existsSync(csvPath)) return
    const header = readTextFile(csvPath).split('\n')[0]
    expect(header).toBe(STORY_DEVELOPMENT_CSV_COLUMNS.join(','))
  })

  it('评估资产只读、不写进项目目录（§29/§32 未被改动）', () => {
    const evaluationRoot = join(REPO_ROOT, 'tests/fixtures/evaluation')
    const names = readdirSync(evaluationRoot).sort()
    expect(names).toEqual(['anti-ai', 'story-development'])
    const projectFiles = readdirSync(join(REPO_ROOT, 'projects', 'demo-01')).sort()
    expect(projectFiles).not.toContain('evaluation')
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

describe('验收 F：v0.1 8 点自检（条款文字待 OQ-61 确认）', () => {
  it('① 一句话 Seed → 可用蓝图 → Scene 的链路留有真实产物', () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      expect(existsSync(paths.seed)).toBe(true)
      expect(existsSync(paths.proposals)).toBe(true)
      expect(existsSync(paths.blueprint)).toBe(true)
      expect(existsSync(paths.storyState)).toBe(true)
      expect(loadScenes(paths)).toHaveLength(5)
      expect(storyStateOf(paths).confirmed_scenes.length).toBe(5)
      expect(readTextFile(paths.coverageReport)).toContain('scenes: 5')
    }
  })

  it('② 提案差异度与 Seed 保真度可量化（不是"看起来不同"）', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const rows = set.seeds
      .filter((seed) => seed.status === 'measured')
      .flatMap((seed) => {
        const paths = projectPaths(join(REPO_ROOT, 'projects'), seed.project_id ?? '')
        return buildStoryDevelopmentEvaluation([{ seedId: seed.seed_id, paths }]).rows
      })
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const row of rows) expect(row.distinctness_ok).toBe(true)
  })

  it('③ Writer 只拿到当前 Scene 的受控上下文，且有 Manifest', () => {
    const paths = projectPaths(join(REPO_ROOT, 'projects'), 'demo-01')
    expect(existsSync(paths.contextManifestReport)).toBe(true)
    const manifest = readTextFile(paths.contextManifestReport)
    expect(manifest).toContain('included_sensitive')
    expect(manifest).toContain('excluded_sensitive')
    expect(manifest).toContain('style_samples')
    expect(manifest).toContain('future_content_exposed')
    expect(manifest).toContain('unconfirmed_proposal_exposed')
  })

  it('④ 反 AI 感 Linter 能给出可定位问题，Rewrite 能落回且留痕', () => {
    const paths = projectPaths(join(REPO_ROOT, 'projects'), 'demo-01')
    expect(existsSync(paths.linterReport)).toBe(true)
    const report = readTextFile(paths.linterReport)
    expect(report).toContain('warnings')
    expect(report).toContain('rewrite')
  })

  it('⑤ Anti-AI A/B 对照可运行（A/B 文本齐备，人工填写模板存在）', () => {
    const dir = join(REPO_ROOT, ANTI_AI_DIR, 'session-001')
    expect(readdirSync(dir).filter((name) => name.endsWith('.txt'))).toHaveLength(20)
    expect(existsSync(join(dir, 'ratings.csv'))).toBe(true)
    expect(existsSync(join(dir, 'session.yaml'))).toBe(true)
  })

  it('⑥ 终稿确认与事实提取是一次性的、可重跑的（Gate 3 幂等）', async () => {
    const paths = cloneProject('demo-01')
    const first = await runGate3({ paths, provider: recorded(), confirm: true })
    const second = await runGate3({ paths, provider: recorded(), confirm: true })
    expect(second.occurred.map((entry) => entry.id)).toEqual(first.occurred.map((entry) => entry.id))
    expect(storyStateOf(paths).state_rebuild_conflicts).toEqual([])
  })

  it('⑦ 越界推演不会静默通过（冲突显式记录，状态不被污染）', async () => {
    const paths = cloneProject('demo-01')
    const before = storyStateOf(paths)
    const result = await runGate3({ paths, provider: overRevealingProvider(OVER_REVEAL), confirm: true })
    expect(result.conflicts.length).toBeGreaterThan(0)
    const after = storyStateOf(paths)
    expect(after.state_rebuild_conflicts.length).toBe(before.state_rebuild_conflicts.length + 1)
    // 冲突不产生新事实：occurred 与投影与运行前完全一致
    expect(after.occurred).toEqual(before.occurred)
    expect(after.knowledge_state).toEqual(before.knowledge_state)
    expect(after.relationship_state).toEqual(before.relationship_state)
  })

  it('⑧ 文件优先：所有产物都是可 diff 的文本，没有数据库/二进制状态', () => {
    const stateful = ['seed.yaml', 'proposals.yaml', 'blueprint.yaml', 'story_state.yaml']
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const dir = join(REPO_ROOT, 'projects', projectId)
      for (const name of stateful) {
        expect(existsSync(join(dir, name))).toBe(true)
        expect(readTextFile(join(dir, name)).length).toBeGreaterThan(0)
      }
      const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name)
          if (entry.isDirectory()) {
            walk(full)
            continue
          }
          const rel = relative(REPO_ROOT, full)
          if (/\.(md|yaml|yml|csv|txt|json)$/u.test(entry.name)) continue
          throw new Error(`发现非文本产物：${rel}（大小 ${statSync(full).size} 字节）`)
        }
      }
      walk(dir)
      for (const forbidden of ['db', 'sqlite', 'events', 'index']) {
        expect(existsSync(join(dir, forbidden))).toBe(false)
      }
    }
    expect(existsSync(join(REPO_ROOT, 'projects', 'demo-01', 'drafts', 'final.md'))).toBe(true)
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
