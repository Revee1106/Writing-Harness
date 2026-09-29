import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STRUCTURE_IDS } from '../../src/schema/blueprint.ts'
import { validateScene } from '../../src/schema/scene.ts'
import { validateStoryState } from '../../src/schema/story-state.ts'
import { validateCoverageReport } from '../../src/scenes/coverage.ts'
import {
  loadCoverageReport,
  loadScenes,
  loadStoryState,
  runSceneBreakdown,
} from '../../src/scenes/service.ts'
import { resolveStructure } from '../../src/scenes/resolver.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadBlueprint, loadProposals, loadSeed, saveProposals, saveSeed } from '../../src/project/project.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { runGate2 } from '../../src/gate2/service.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR, SEEDS_DIR } from '../helpers/story4.ts'

/**
 * Story 5 验收测试（《开发 Story 拆分》Story 5「验收」13 条）。
 * 全部离线：Scene 内容来自 tests/fixtures/recorded/scene_breakdown 的 4 个 fixture。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story5acc-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

const recorded = (contract: string): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, contract))

interface Scenario {
  readonly seed: string
  readonly gate1Ops?: readonly { kind: string; id?: string }[]
  readonly gate2?: Record<string, unknown>
}

/** 端到端（离线）：Seed → Interpreter → Gate 1 → Developer → Gate 2 → Scene Breakdown。 */
async function runStory5(projectId: string, scenario: Scenario): Promise<{
  paths: ReturnType<typeof projectPaths>
  result: Awaited<ReturnType<typeof runSceneBreakdown>>
}> {
  const root = tempRoot()
  const rawInput = readFileSync(join(SEEDS_DIR, scenario.seed), 'utf8')
  createProject({ projectsRoot: root.dir, projectId, rawInput })
  const paths = projectPaths(root.dir, projectId)

  const interpretation = await runSeedInterpreter({ provider: recorded('seed-interpreter'), rawInput })
  const seed = applyGate1Operations(
    seedFromInterpreterResult(rawInput, interpretation),
    (scenario.gate1Ops ?? [{ kind: 'skip' }]) as Parameters<typeof applyGate1Operations>[1],
  ).seed
  saveSeed(paths, seed)
  const developer = await runStoryDeveloper({ provider: recorded('story_developer'), seed })
  saveProposals(paths, developer.file)
  await runGate2({
    paths,
    provider: recorded('blueprint_builder'),
    ...(scenario.gate2 ?? { fromProposal: 'PROP_A' }),
  })
  const result = await runSceneBreakdown({ paths, provider: recorded('scene_breakdown') })
  return { paths, result }
}

describe('验收 1：Blueprint 稳定拆成 Scene', () => {
  it('每个 structure 位置都有 Scene，order 连续，scene_id 稳定', async () => {
    const { paths, result } = await runStory5('s5a-01', { seed: 'multi-sentence.txt' })
    expect(result.scenes.length).toBeGreaterThanOrEqual(5)
    expect(result.scenes.map((scene) => scene.order)).toEqual(
      result.scenes.map((_unused, index) => index + 1),
    )
    expect(result.scenes.map((scene) => scene.scene_id)).toEqual(
      result.scenes.map((_unused, index) => `scene-${String(index + 1).padStart(3, '0')}`),
    )
    for (const key of Object.keys(STRUCTURE_IDS)) {
      const structureId = STRUCTURE_IDS[key as keyof typeof STRUCTURE_IDS]
      expect(
        result.scenes.some((scene) => scene.narrative_role_ref === structureId),
        structureId,
      ).toBe(true)
    }
    expect(result.written).toBe(true)
    expect(loadScenes(paths)).toHaveLength(result.scenes.length)
  })
})

describe('验收 2：Scene 引用 Blueprint ID', () => {
  it('referenced_blueprint_items 全部真实存在，narrative_role_ref 可解析', async () => {
    const { result } = await runStory5('s5a-02', { seed: 'multi-sentence.txt' })
    expect(result.coverage.warnings.filter((warning) => warning.type === 'blueprint_reference_integrity')).toEqual([])
    for (const scene of result.scenes) {
      expect(scene.narrative_role_ref).toMatch(/^BP_(STR|ARC)_/)
      for (const reference of scene.referenced_blueprint_items) {
        expect(reference).toMatch(/^(BP_[A-Z0-9_]+|K\d{3}|CH_[A-Z0-9_]+|OBH_[A-Z0-9_]+|REL_[A-Z0-9_]+)$/)
      }
    }
  })
})

describe('验收 3：allowed_reveals 只能引用 Key Knowledge', () => {
  it('allowed_reveals 只含 K###，且恰好覆盖每个 reveal 计划一次', async () => {
    const { paths, result } = await runStory5('s5a-03', { seed: 'multi-sentence.txt' })
    const blueprint = loadBlueprint(paths)
    const declared = result.scenes.flatMap((scene) => scene.allowed_reveals)
    expect(declared.length).toBeGreaterThan(0)
    for (const reveal of declared) expect(reveal).toMatch(/^K\d{3}$/)
    for (const knowledge of blueprint.key_knowledge) {
      expect(declared.filter((reveal) => reveal === knowledge.id)).toHaveLength(1)
    }
    expect(result.coverage.warnings.filter((warning) => warning.type === 'reveal_alignment')).toEqual([])
  })
})

describe('验收 4：Story State 可初始化', () => {
  it('story_state.yaml 结构与 §17 一致并可通过校验', async () => {
    const { paths, result } = await runStory5('s5a-04', { seed: 'multi-sentence.txt' })
    expect(existsSync(paths.storyState)).toBe(true)
    const onDisk = loadStoryState(paths)
    expect(onDisk).toEqual(result.state)
    expect(() => validateStoryState(onDisk)).not.toThrow()
    expect(onDisk?.blueprint_version).toBe(1)
  })
})

describe('验收 5：Scene proposed additions 不升级', () => {
  it('proposed_additions 永久保持 PROPOSED / scene_breakdown，且不出现在任何 CONFIRMED 位置', async () => {
    const { paths, result } = await runStory5('s5a-05', { seed: 'multi-sentence.txt' })
    const additions = result.scenes.flatMap((scene) => scene.proposed_additions)
    expect(additions.length).toBeGreaterThan(0)
    for (const addition of additions) {
      expect(addition.status).toBe('PROPOSED')
      expect(addition.source).toBe('scene_breakdown')
    }
    // Blueprint 没有因为这些 Scene 新增内容而被修改
    const blueprint = loadBlueprint(paths)
    for (const addition of additions) {
      expect(JSON.stringify(blueprint)).not.toContain(addition.value)
    }
    // proposals.yaml 也没有被改动
    expect(
      JSON.stringify(loadProposals(paths).proposals.flatMap((proposal) => proposal.seed_fidelity.added)),
    ).not.toContain(additions[0]?.value as string)
  })
})

describe('验收 6：Coverage warning 结构化输出', () => {
  it('reports/coverage.yaml 通过 Schema 校验，warning 含 id/type/severity/message/refs', async () => {
    const { paths, result } = await runStory5('s5a-06', { seed: 'multi-sentence.txt' })
    expect(existsSync(paths.coverageReport)).toBe(true)
    const report = loadCoverageReport(paths)
    expect(report).toEqual(result.coverage)
    expect(() => validateCoverageReport(report)).not.toThrow()
    for (const warning of report?.warnings ?? []) {
      expect(warning.id).toMatch(/^COV_\d{3}$/)
      expect(['structure_coverage', 'arc_coverage', 'ending_coverage', 'length_coverage', 'reveal_alignment', 'blueprint_reference_integrity']).toContain(warning.type)
      expect(['high', 'medium', 'low']).toContain(warning.severity)
      expect(Array.isArray(warning.refs)).toBe(true)
    }
  })
})

describe('验收 7：reveal_to / known_by / allowed_reveals 的优先级有固定测试', () => {
  it('allowed_reveals 只表示"本场允许 reveal"，不等于 POV 开场已知；known_by 是初始事实', async () => {
    const { paths, result } = await runStory5('s5a-07', { seed: 'multi-sentence.txt' })
    const blueprint = loadBlueprint(paths)
    const knowledge = blueprint.key_knowledge[0]
    const state = result.state.knowledge_state.find((entry) => entry.blueprint_ref === knowledge?.id)
    // 初始 known_by 来自 Blueprint，occurred_reveal=false（Gate 3 之前没有事实）
    expect(state?.known_by).toEqual(knowledge?.known_by)
    expect(state?.occurred_reveal).toBe(false)
    expect(state?.last_updated_scene).toBeNull()
    // reveal_to 来自 Blueprint，而不是 Scene
    const revealScene = result.scenes.find((scene) => scene.allowed_reveals.includes(knowledge?.id as string))
    expect(revealScene).toBeDefined()
    expect(knowledge?.reveal_to.length).toBeGreaterThan(0)
  })
})

describe('验收 8：Blueprint version 升级可重建 State', () => {
  it('重建保留 confirmed_scenes / occurred，并产生结构化 ORPHANED', async () => {
    const { paths, result } = await runStory5('s5a-08', { seed: 'multi-sentence.txt' })
    const { writeYamlFile } = await import('../../src/io/yaml.ts')
    const { makeKnowledgeReveal, rebuildStoryState } = await import('../../src/scenes/state.ts')
    const blueprint = loadBlueprint(paths)
    const seed = loadSeed(paths)
    const previous = validateStoryState({
      ...result.state,
      confirmed_scenes: ['scene-001', 'scene-003'],
      occurred: [
        makeKnowledgeReveal({ knowledge_ref: 'K001', scene_id: 'scene-003', revealed_to: ['CH_WOMAN'], source_ref: 'x' }),
      ],
    })
    writeYamlFile(paths.storyState, previous)
    const fewer = result.scenes.slice(0, 2)
    const rebuilt = rebuildStoryState({ blueprint: { ...blueprint, blueprint_version: 2 }, scenes: fewer, seed, previous })
    expect(rebuilt.state.confirmed_scenes).toEqual(['scene-001', 'scene-003'])
    expect(rebuilt.state.state_rebuild_conflicts.length).toBeGreaterThan(0)
    for (const conflict of rebuilt.state.state_rebuild_conflicts) {
      expect(conflict).toMatchObject({ type: 'ORPHANED', blueprint_version: 2, resolution_note: null })
      expect(conflict.id).toMatch(/^SRC_\d{3}$/)
    }
    expect(() => validateStoryState(rebuilt.state)).not.toThrow()
  })
})

describe('验收 9：occurred 重跑不会重复', () => {
  it('同一终稿重跑 upsert 不产生重复记录（确定性 ID）', async () => {
    const { paths, result } = await runStory5('s5a-09', { seed: 'multi-sentence.txt' })
    const { makeKnowledgeReveal, makeRelationshipChange, upsertOccurred } = await import('../../src/scenes/state.ts')
    const blueprint = loadBlueprint(paths)
    const relationshipRef = blueprint.characters[0]?.relationships[0]?.id as string
    const entries = [
      makeKnowledgeReveal({ knowledge_ref: 'K001', scene_id: 'scene-003', revealed_to: ['CH_WOMAN'], source_ref: 'x' }),
      makeRelationshipChange({
        relationship_ref: relationshipRef,
        scene_id: 'scene-005',
        from_state: 'together',
        to_state: 'separated',
        source_ref: 'y',
      }),
    ]
    let state = upsertOccurred(result.state, entries)
    state = upsertOccurred(state, entries)
    state = upsertOccurred(state, entries)
    expect(state.occurred).toHaveLength(2)
    expect(new Set(state.occurred.map((entry) => entry.id)).size).toBe(2)
  })
})

describe('验收 10：open question resolution 可引用 Blueprint Item 或 Scene', () => {
  it('resolution_ref 支持 blueprint_item 与 scene 两种类型', async () => {
    const { result } = await runStory5('s5a-10', { seed: 'multi-sentence.txt' })
    const question = result.state.open_questions[0]
    expect(question?.resolution_ref).toBeNull()
    const withBlueprintRef = validateStoryState({
      ...result.state,
      open_questions: [
        { ...question, state: 'resolved', resolution_ref: { type: 'blueprint_item', ref_id: 'BP_THEME_01' } },
      ],
    })
    expect(withBlueprintRef.open_questions[0]?.resolution_ref).toMatchObject({ type: 'blueprint_item' })
    const withSceneRef = validateStoryState({
      ...result.state,
      open_questions: [{ ...question, state: 'resolved', resolution_ref: { type: 'scene', ref_id: 'scene-003' } }],
    })
    expect(withSceneRef.open_questions[0]?.resolution_ref).toMatchObject({ type: 'scene', ref_id: 'scene-003' })
  })
})

describe('验收 11：structure position → scene_id 可唯一解析', () => {
  it('reveal_at_structure + reveal_order 解析唯一，且不反写 Blueprint', async () => {
    const { paths, result } = await runStory5('s5a-11', { seed: 'multi-sentence.txt' })
    const blueprintText = readFileSync(paths.blueprint, 'utf8')
    const blueprint = loadBlueprint(paths)
    const resolution = resolveStructure(blueprint, result.scenes)
    for (const reveal of resolution.reveals) {
      expect(reveal.scene_id).toMatch(/^scene-\d{3}$/)
      const matches = result.scenes.filter((scene) => scene.narrative_role_ref === reveal.reveal_at_structure)
      expect(matches[reveal.reveal_order - 1]?.scene_id).toBe(reveal.scene_id)
    }
    expect(readFileSync(paths.blueprint, 'utf8')).toBe(blueprintText)
    expect(blueprintText).not.toMatch(/scene-\d{3}/)
  })
})

describe('验收 12：foreshadowing setup/payoff 解析结果可进入 Story State', () => {
  it('foreshadowing_state 带 resolved_setup_scene / resolved_payoff_scene，初始 state=planned', async () => {
    const { result } = await runStory5('s5a-12', { seed: 'multi-sentence.txt' })
    const entry = result.state.foreshadowing_state[0]
    expect(entry?.blueprint_ref).toBe('BP_FS_001')
    expect(entry?.resolved_setup_scene).toBe('scene-001')
    expect(entry?.resolved_payoff_scene).toBe('scene-005')
    expect(entry?.state).toBe('planned')
  })
})

describe('验收 13：Story State 不存在未定义的 characters.notes', () => {
  it('story_state.yaml 不含 characters / timelines 等未定义集合', async () => {
    const { paths } = await runStory5('s5a-13', { seed: 'multi-sentence.txt' })
    const text = readFileSync(paths.storyState, 'utf8')
    expect(text).not.toContain('characters')
    expect(text).not.toContain('timeline')
    expect(text).not.toContain('notes')
    const state = loadStoryState(paths)
    expect(Object.keys(state ?? {}).sort()).toEqual([
      'blueprint_version',
      'confirmed_scenes',
      'foreshadowing_state',
      'knowledge_state',
      'occurred',
      'open_questions',
      'relationship_state',
      'schema_version',
      'state_rebuild_conflicts',
    ])
  })

  it('多场景 Seed（悬疑 / 温情 / 单场景）也能跑通并保持零 coverage warning', async () => {
    const scenarios: Array<[string, Scenario]> = [
      ['s5a-mystery', { seed: 'story2/02-mystery.txt', gate2: { fields: {
        title: 'PROP_A', genre: 'PROP_A', pov: 'PROP_B', target_length: 'PROP_A', premise: 'PROP_A', theme: 'PROP_A',
        characters: 'PROP_B', core_conflict: 'PROP_A', arc: 'PROP_B', structure: 'PROP_B', key_knowledge: 'PROP_A',
        foreshadowing: 'PROP_B', style_direction: 'PROP_A',
      }, resolutions: { 'PROP_B:CONF_001': 'changed_user' } } }],
      ['s5a-warmth', { seed: 'story2/04-warmth.txt', gate2: {
        fields: {
          title: 'user', genre: 'user', pov: 'user', target_length: 'user', premise: 'user', theme: 'user',
          characters: 'user', core_conflict: 'user', arc: 'user', structure: 'user', key_knowledge: 'user',
          foreshadowing: 'user', style_direction: 'user',
        },
        edits: {
          title: '最后一页的那句话', genre: '温情短篇', pov: 'CH_GRANDSON', target_length: '6000',
          premise: '孙子回到老家，本子最后一页写着奶奶托人代笔的一句话',
          theme: '不识字的人如何把期待写下来',
          characters: '孙子与奶奶两人，奶奶在本子最后一页留下了话',
          core_conflict: '他想告诉奶奶结果，而奶奶已经不在了',
          arc: '从回来看看，到把这句话带回城里',
          structure: '从回家发现本子，到他把本子带回城里',
          key_knowledge: '最后一页不是奶奶亲笔，是邻居代笔',
          foreshadowing: '本子前几页的圈和数字',
          style_direction: '白描、少形容词、对白短',
        },
      } }],
      ['s5a-single-scene', { seed: 'story2/07-single-scene.txt', gate1Ops: [{ kind: 'promote', id: 'SEED_A001' }], gate2: { fromProposal: 'PROP_A' } }],
    ]
    for (const [projectId, scenario] of scenarios) {
      const { result } = await runStory5(projectId, scenario)
      expect(result.scenes.length, projectId).toBeGreaterThanOrEqual(5)
      expect(result.coverage.warnings, projectId).toEqual([])
      for (const scene of result.scenes) expect(() => validateScene(scene)).not.toThrow()
    }
  })

  it('fixture 集合覆盖 4 种 Blueprint（单来源 / 合并 / manual / 提权项）', () => {
    const files = readdirSync(join(RECORDED_DIR, 'scene_breakdown'))
      .filter((name) => name.endsWith('.yaml'))
      .sort()
    expect(files).toEqual([
      'multi-sentence-a.yaml',
      'mystery-merge.yaml',
      'realism-merge.yaml',
      'single-scene-promoted-a.yaml',
      'warmth-manual.yaml',
    ])
  })
})
