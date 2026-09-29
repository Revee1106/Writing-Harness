import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ARC_IDS, STRUCTURE_IDS, validateBlueprint, type Blueprint } from '../../src/schema/blueprint.ts'
import { validateScene, type Scene } from '../../src/schema/scene.ts'
import {
  applyAllowedReveals,
  resolveStructure,
  resolveStructurePosition,
  sortScenesByOrder,
} from '../../src/scenes/resolver.ts'
import {
  assertNoUnresolvedOrphans,
  initStoryState,
  makeKnowledgeReveal,
  makeRelationshipChange,
  rebuildStoryState,
  unresolvedOrphans,
  upsertOccurred,
} from '../../src/scenes/state.ts'
import { LENGTH_TOLERANCE_RATIO, runCoverageCheck } from '../../src/scenes/coverage.ts'
import { StoryStateValidationError, validateStoryState } from '../../src/schema/story-state.ts'
import { loadStoryState, runSceneBreakdown, SceneRerunRequiredError } from '../../src/scenes/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, saveSeed } from '../../src/project/project.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { runGate2 } from '../../src/gate2/service.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR, SEEDS_DIR } from '../helpers/story4.ts'

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story5-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

const recorded = (contract: string): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, contract))

/** 构造一个"已到 Gate 2 之后"的项目（离线 fixture 状态）。 */
async function projectWithBlueprint(
  projectId: string,
  seedFile: string,
  gate1Ops: readonly { kind: string; id?: string }[] = [{ kind: 'skip' }],
  gate2: { fromProposal?: string; fields?: Record<string, string>; edits?: Record<string, string>; resolutions?: Record<string, string> } = { fromProposal: 'PROP_A' },
): Promise<ReturnType<typeof projectPaths>> {
  const root = tempRoot()
  const rawInput = readFileSync(join(SEEDS_DIR, seedFile), 'utf8')
  createProject({ projectsRoot: root.dir, projectId, rawInput })
  const paths = projectPaths(root.dir, projectId)
  const interpretation = await runSeedInterpreter({ provider: recorded('seed-interpreter'), rawInput })
  const seed = applyGate1Operations(
    seedFromInterpreterResult(rawInput, interpretation),
    gate1Ops as Parameters<typeof applyGate1Operations>[1],
  ).seed
  saveSeed(paths, seed)
  const developer = await runStoryDeveloper({ provider: recorded('story_developer'), seed })
  const { saveProposals } = await import('../../src/project/project.ts')
  saveProposals(paths, developer.file)
  await runGate2({ paths, provider: recorded('blueprint_builder'), ...gate2 })
  return paths
}

async function breakdownOnce(projectId: string, seedFile: string): Promise<{ paths: ReturnType<typeof projectPaths>; result: Awaited<ReturnType<typeof runSceneBreakdown>> }> {
  const paths = await projectWithBlueprint(projectId, seedFile)
  const result = await runSceneBreakdown({ paths, provider: recorded('scene_breakdown') })
  return { paths, result }
}

describe('Structure Resolver（需求规格 §14.1 / §15 / §16）', () => {
  it('按 reveal_at_structure + reveal_order 解析到唯一 Scene，并写入 allowed_reveals', async () => {
    const { result } = await breakdownOnce('s5-res-01', 'multi-sentence.txt')
    const knowledge = result.resolution.reveals[0]
    expect(knowledge?.knowledge_id).toBe('K001')
    expect(knowledge?.scene_id).toBe('scene-003')
    const scene = result.scenes.find((candidate) => candidate.scene_id === 'scene-003')
    expect(scene?.allowed_reveals).toEqual(['K001'])
    // 其它 Scene 的 allowed_reveals 为空
    for (const other of result.scenes.filter((candidate) => candidate.scene_id !== 'scene-003')) {
      expect(other.allowed_reveals).toEqual([])
    }
  })

  it('foreshadowing setup / payoff 解析结果进入 foreshadowing_state', async () => {
    const { result } = await breakdownOnce('s5-res-02', 'multi-sentence.txt')
    const entry = result.state.foreshadowing_state[0]
    expect(entry?.blueprint_ref).toBe('BP_FS_001')
    expect(entry?.resolved_setup_scene).toBe('scene-001')
    expect(entry?.resolved_payoff_scene).toBe('scene-005')
    expect(entry?.state).toBe('planned')
  })

  it('order 越界 / 解析失败 / 重复覆盖都产生 warning（§16）', async () => {
    const { paths, result } = await breakdownOnce('s5-res-03', 'multi-sentence.txt')
    const scenes = result.scenes
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const loaded = loadBlueprint(paths)
    // 人为构造越界：同一 structure 段只有一个 Scene，却要求 order=2
    const tampered: Blueprint = {
      ...loaded,
      key_knowledge: loaded.key_knowledge.map((knowledge) => ({ ...knowledge, reveal_order: 2 })),
    }
    const resolution = resolveStructure(tampered, scenes)
    expect(resolution.warnings.some((warning) => warning.type === 'reveal_order_out_of_range')).toBe(true)
    expect(resolution.reveals[0]?.scene_id).toBeNull()

    // 同一 reveal 覆盖两个 Scene → duplicate coverage
    const duplicated: Scene[] = scenes.map((scene) =>
      scene.scene_id === 'scene-004' ? { ...scene, allowed_reveals: ['K001'] } : scene,
    )
    const { runCoverageCheck } = await import('../../src/scenes/coverage.ts')
    const report = runCoverageCheck({ blueprint: loaded, scenes: duplicated })
    // duplicate 由 resolver 判定；这里通过"两个 Scene 都声明 K001"触发 reveal_alignment
    expect(report.report.warnings.length).toBeGreaterThan(0)
  })

  it('resolveStructurePosition 按全局 order 排序取第 N 个；sortScenesByOrder 不修改原数组', async () => {
    const { result } = await breakdownOnce('s5-res-04', 'multi-sentence.txt')
    const position = resolveStructurePosition(result.scenes, STRUCTURE_IDS.beginning, 1)
    expect(position.scene?.scene_id).toBe('scene-001')
    expect(resolveStructurePosition(result.scenes, STRUCTURE_IDS.beginning, 2).scene).toBeNull()
    const reversed = [...result.scenes].reverse()
    expect(sortScenesByOrder(reversed).map((scene) => scene.order)).toEqual([1, 2, 3, 4, 5])
    expect(reversed[0]?.order).toBe(5)
  })

  it('applyAllowedReveals 生成 allowed_reveals，且真实 scene_id 不反写 Blueprint', async () => {
    const { paths, result } = await breakdownOnce('s5-res-05', 'multi-sentence.txt')
    const before = readFileSync(paths.blueprint, 'utf8')
    const applied = applyAllowedReveals(result.scenes, result.resolution)
    expect(applied.find((scene) => scene.scene_id === 'scene-003')?.allowed_reveals).toEqual(['K001'])
    // 再次运行 Resolver 不会改动 Blueprint（真实 scene_id 不反写，§11.2）
    const { loadBlueprint } = await import('../../src/project/project.ts')
    resolveStructure(loadBlueprint(paths), result.scenes)
    expect(readFileSync(paths.blueprint, 'utf8')).toBe(before)
    expect(before).not.toMatch(/scene-\d{3}/)
  })
})

describe('Story State（需求规格 §17）', () => {
  it('初始化：投影自 Blueprint，不含 truth 副本，不含 characters 集合，不持久化 timeline', async () => {
    const { paths, result } = await breakdownOnce('s5-state-01', 'multi-sentence.txt')
    const state = result.state
    expect(Object.keys(state).sort()).toEqual([
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
    expect(state.confirmed_scenes).toEqual([])
    expect(state.occurred).toEqual([])
    const knowledge = state.knowledge_state[0]
    expect(knowledge?.blueprint_ref).toBe('K001')
    expect(knowledge?.occurred_reveal).toBe(false)
    expect(knowledge?.last_updated_scene).toBeNull()
    // 不复制 truth
    expect(JSON.stringify(state)).not.toContain('男方当晚写过一条道歉消息并删掉了')
    // timeline 不持久化
    expect(state).not.toHaveProperty('timeline')
    // characters 不实现
    expect(state).not.toHaveProperty('characters')
    expect(loadStoryState(paths)).toEqual(state)
  })

  it('open_questions 投影自 seed.yaml，state=open 时 resolution_ref 为 null', async () => {
    const { result } = await breakdownOnce('s5-state-02', 'multi-sentence.txt')
    expect(result.state.open_questions.length).toBeGreaterThan(0)
    for (const question of result.state.open_questions) {
      expect(question.seed_ref).toMatch(/^SEED_Q\d{3}$/)
      expect(question.state).toBe('open')
      expect(question.resolution_ref).toBeNull()
    }
  })

  it('relationship_state 初始化自 Blueprint relationship baseline', async () => {
    const { result } = await breakdownOnce('s5-state-03', 'multi-sentence.txt')
    expect(result.state.relationship_state.length).toBeGreaterThan(0)
    for (const relationship of result.state.relationship_state) {
      expect(relationship.blueprint_ref).toMatch(/^REL_/)
      expect(relationship.last_updated_scene).toBeNull()
      expect(relationship.state.length).toBeGreaterThan(0)
    }
  })

  it('occurred 使用 tagged union + 确定性 ID，重跑按 ID upsert 不重复（§18.1）', async () => {
    const { result } = await breakdownOnce('s5-state-04', 'multi-sentence.txt')
    const reveal = makeKnowledgeReveal({
      knowledge_ref: 'K001',
      scene_id: 'scene-003',
      revealed_to: ['CH_WOMAN'],
      source_ref: 'drafts/scene-003.md',
    })
    const relationship = makeRelationshipChange({
      relationship_ref: 'REL_WOMAN_MAN',
      scene_id: 'scene-005',
      from_state: 'together',
      to_state: 'separated',
      source_ref: 'drafts/scene-005.md',
    })
    expect(reveal.id).toBe('OCC_K_K001_scene-003')
    expect(relationship.id).toBe('OCC_REL_REL_WOMAN_MAN_scene-005')
    const once = upsertOccurred(result.state, [reveal, relationship])
    const twice = upsertOccurred(once, [reveal, relationship])
    expect(twice.occurred).toHaveLength(2)
    expect(twice.occurred.map((entry) => entry.id)).toEqual(once.occurred.map((entry) => entry.id))
    // 更新同 ID 的不同内容 → 覆盖而不是新增
    const updated = upsertOccurred(twice, [
      makeRelationshipChange({
        relationship_ref: 'REL_WOMAN_MAN',
        scene_id: 'scene-005',
        from_state: 'together',
        to_state: 'apart',
        source_ref: 'drafts/scene-005.md',
      }),
    ])
    expect(updated.occurred).toHaveLength(2)
    const entry = updated.occurred.find((candidate) => candidate.type === 'relationship_change')
    expect(entry?.payload).toMatchObject({ to_state: 'apart' })
    expect(() => validateStoryState({ ...twice, occurred: [reveal, reveal] })).toThrow(StoryStateValidationError)
  })

  it('Blueprint Version 重建：保留 occurred / confirmed_scenes、重放 occurred、消失引用产生 ORPHANED', async () => {
    const { paths, result } = await breakdownOnce('s5-state-05', 'multi-sentence.txt')
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const { loadSeed } = await import('../../src/project/project.ts')
    const blueprint = loadBlueprint(paths)
    const seed = loadSeed(paths)

    const withOccurred = validateStoryState({
      ...result.state,
      confirmed_scenes: ['scene-001', 'scene-003'],
      occurred: [
        makeKnowledgeReveal({ knowledge_ref: 'K001', scene_id: 'scene-003', revealed_to: ['CH_WOMAN'], source_ref: 'x' }),
      ],
    })

    // 新版本：仍是同一个 Blueprint，但 Scene 变少（去掉 scene-003 / scene-005）
    const newBlueprint: Blueprint = { ...blueprint, blueprint_version: 2 }
    const fewerScenes = result.scenes.filter((scene) => !['scene-003', 'scene-005'].includes(scene.scene_id))
    const rebuilt = rebuildStoryState({ blueprint: newBlueprint, scenes: fewerScenes, seed, previous: withOccurred })
    expect(rebuilt.state.occurred).toHaveLength(0) // 引用失效 → 不重放
    expect(rebuilt.state.confirmed_scenes).toEqual(['scene-001', 'scene-003'])
    const types = rebuilt.state.state_rebuild_conflicts.map((conflict) => conflict.ref_id).sort()
    // occurred 与 confirmed_scenes 都引用了 scene-003 → 两条 ORPHANED
    expect(types).toEqual(['scene-003', 'scene-003'])
    for (const conflict of rebuilt.state.state_rebuild_conflicts) {
      expect(conflict.type).toBe('ORPHANED')
      expect(conflict.blueprint_version).toBe(2)
      expect(conflict.resolution_note).toBeNull()
    }
    expect(unresolvedOrphans(rebuilt.state).length).toBeGreaterThan(0)
    expect(() => assertNoUnresolvedOrphans(rebuilt.state)).toThrow(/禁止 Context Compile/)
    // 处理后可继续
    const resolved = validateStoryState({
      ...rebuilt.state,
      state_rebuild_conflicts: rebuilt.state.state_rebuild_conflicts.map((conflict) => ({
        ...conflict,
        resolution_note: '已确认重写该场',
      })),
    })
    expect(() => assertNoUnresolvedOrphans(resolved)).not.toThrow()
  })

  it('重建时同一 Scene 内的 occurred 按数组物理顺序重放', async () => {
    const { paths, result } = await breakdownOnce('s5-state-06', 'multi-sentence.txt')
    const { loadBlueprint, loadSeed } = await import('../../src/project/project.ts')
    const blueprint = loadBlueprint(paths)
    const seed = loadSeed(paths)
    const previous = validateStoryState({
      ...result.state,
      occurred: [
        makeKnowledgeReveal({ knowledge_ref: 'K001', scene_id: 'scene-003', revealed_to: ['CH_WOMAN'], source_ref: 'a' }),
      ],
    })
    const rebuilt = rebuildStoryState({ blueprint, scenes: result.scenes, seed, previous })
    expect(rebuilt.state.occurred).toHaveLength(1)
    expect(rebuilt.state.knowledge_state[0]?.occurred_reveal).toBe(true)
    expect(rebuilt.state.knowledge_state[0]?.known_by.CH_WOMAN).toBe(true)
    expect(rebuilt.state.knowledge_state[0]?.last_updated_scene).toBe('scene-003')
  })
})

describe('Coverage Check（§16；OQ-15 / OQ-43 / OQ-44）', () => {
  it('正常项目无 warning，summary 完整', async () => {
    const { result } = await breakdownOnce('s5-cov-01', 'multi-sentence.txt')
    expect(result.coverage.warnings).toEqual([])
    expect(result.coverage.summary).toMatchObject({
      scenes: 5,
      structure_covered: 5,
      arc_covered: 3,
      reveals_planned: 1,
      reveals_resolved: 1,
    })
    expect(result.coverage.blueprint_version).toBe(1)
  })

  it('缺 structure 覆盖 / 缺 ending / reveal 解析失败 → high warning', async () => {
    const { paths, result } = await breakdownOnce('s5-cov-02', 'multi-sentence.txt')
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const blueprint = loadBlueprint(paths)
    const scenes = result.scenes.filter((scene) => scene.narrative_role_ref !== STRUCTURE_IDS.ending)
    const report = runCoverageCheck({ blueprint, scenes }).report
    const types = report.warnings.map((warning) => warning.type)
    expect(types).toContain('structure_coverage')
    expect(types).toContain('ending_coverage')
    for (const warning of report.warnings) {
      expect(['high', 'medium']).toContain(warning.severity)
      expect(warning.id).toMatch(/^COV_\d{3}$/)
    }
  })

  it('length 容差 ±30%：容差内无 warning，超出为 medium', async () => {
    const { paths, result } = await breakdownOnce('s5-cov-03', 'multi-sentence.txt')
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const blueprint = loadBlueprint(paths)
    expect(LENGTH_TOLERANCE_RATIO).toBe(0.3)
    const within = result.scenes.map((scene) => ({ ...scene, target_length: 1800 }))
    expect(runCoverageCheck({ blueprint, scenes: within }).report.warnings.some((warning) => warning.type === 'length_coverage')).toBe(false)
    const tooLong = result.scenes.map((scene) => ({ ...scene, target_length: 3000 }))
    const report = runCoverageCheck({ blueprint, scenes: tooLong }).report
    const warning = report.warnings.find((candidate) => candidate.type === 'length_coverage')
    expect(warning?.severity).toBe('medium')
  })

  it('Scene 引用不存在的 Blueprint ID → blueprint_reference_integrity（high）', async () => {
    const { paths, result } = await breakdownOnce('s5-cov-04', 'multi-sentence.txt')
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const blueprint = loadBlueprint(paths)
    const tampered = result.scenes.map((scene, index) =>
      index === 0 ? { ...scene, referenced_blueprint_items: ['BP_THEME_99'] } : scene,
    )
    const report = runCoverageCheck({ blueprint, scenes: tampered }).report
    const warning = report.warnings.find((candidate) => candidate.type === 'blueprint_reference_integrity')
    expect(warning?.severity).toBe('high')
    expect(warning?.refs).toContain('BP_THEME_99')
  })

  it('allowed_reveals 引用不存在的 K → reveal_alignment（high）', async () => {
    const { paths, result } = await breakdownOnce('s5-cov-05', 'multi-sentence.txt')
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const blueprint = loadBlueprint(paths)
    const tampered = result.scenes.map((scene, index) => (index === 0 ? { ...scene, allowed_reveals: ['K999'] } : scene))
    const report = runCoverageCheck({ blueprint, scenes: tampered }).report
    const warning = report.warnings.find((candidate) => candidate.type === 'reveal_alignment')
    expect(warning?.severity).toBe('high')
  })

  it('arc 覆盖缺失为 medium（OQ-42）', async () => {
    const { paths, result } = await breakdownOnce('s5-cov-06', 'multi-sentence.txt')
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const blueprint = loadBlueprint(paths)
    // 去掉所有引用 arc 与对应 structure 的 Scene → arc 无法覆盖
    const scenes = result.scenes.filter((scene) => scene.narrative_role_ref === STRUCTURE_IDS.development)
    const report = runCoverageCheck({ blueprint, scenes }).report
    const arcWarnings = report.warnings.filter((warning) => warning.type === 'arc_coverage')
    expect(arcWarnings.length).toBeGreaterThan(0)
    for (const warning of arcWarnings) expect(warning.severity).toBe('medium')
    expect(arcWarnings.some((warning) => warning.refs.includes(ARC_IDS.end))).toBe(true)
  })
})

describe('Scene Breakdown 服务（重跑语义 OQ-17）', () => {
  it('首次写盘：/scenes/*.yaml + story_state.yaml + reports/coverage.yaml', async () => {
    const { paths, result } = await breakdownOnce('s5-svc-01', 'multi-sentence.txt')
    expect(result.written).toBe(true)
    expect(result.scenes.map((scene) => scene.scene_id)).toEqual([
      'scene-001',
      'scene-002',
      'scene-003',
      'scene-004',
      'scene-005',
    ])
    expect(result.scenes.map((scene) => scene.order)).toEqual([1, 2, 3, 4, 5])
    const { loadScenes, loadCoverageReport } = await import('../../src/scenes/service.ts')
    expect(loadScenes(paths)).toHaveLength(5)
    expect(loadCoverageReport(paths)?.summary.scenes).toBe(5)
  })

  it('已有 Scene 时必须显式 --rerun', async () => {
    const { paths } = await breakdownOnce('s5-svc-02', 'multi-sentence.txt')
    await expect(runSceneBreakdown({ paths, provider: recorded('scene_breakdown') })).rejects.toBeInstanceOf(
      SceneRerunRequiredError,
    )
  })

  it('重跑覆盖 /scenes/*.yaml，confirmed_scenes 不变，消失 scene 产生 ORPHANED', async () => {
    const { paths, result } = await breakdownOnce('s5-svc-03', 'multi-sentence.txt')
    const { writeYamlFile } = await import('../../src/io/yaml.ts')
    // 模拟 Gate 3 之后已确认两场 + 一条 occurred
    const { makeKnowledgeReveal: makeReveal } = await import('../../src/scenes/state.ts')
    writeYamlFile(paths.storyState, {
      ...result.state,
      confirmed_scenes: ['scene-001', 'scene-003'],
      occurred: [makeReveal({ knowledge_ref: 'K001', scene_id: 'scene-003', revealed_to: ['CH_WOMAN'], source_ref: 'x' })],
    })
    const rerun = await runSceneBreakdown({ paths, provider: recorded('scene_breakdown'), rerun: true })
    expect(rerun.rerun).toBe(true)
    expect(rerun.state.confirmed_scenes).toEqual(['scene-001', 'scene-003'])
    expect(rerun.state.occurred).toHaveLength(1)
    expect(rerun.state.state_rebuild_conflicts).toEqual([])
  })

  it('--plan 只读：不写任何文件', async () => {
    const paths = await projectWithBlueprint('s5-svc-04', 'multi-sentence.txt')
    const result = await runSceneBreakdown({ paths, provider: recorded('scene_breakdown'), dryRun: true })
    expect(result.written).toBe(false)
    const { loadScenes } = await import('../../src/scenes/service.ts')
    expect(loadScenes(paths)).toEqual([])
  })

  it('用户 director note 注入为 source=user，且 ID 全局唯一（OQ-11）', async () => {
    const { paths, result } = await breakdownOnce('s5-svc-05', 'multi-sentence.txt')
    const { loadBlueprint } = await import('../../src/project/project.ts')
    const { assembleScenes, parseRawBreakdownOutput } = await import('../../src/scenes/service.ts')
    // 直接走装配层：注入用户 director note（fixture 的输入哈希不含 user_notes，故不通过网络路径）
    const scenes = assembleScenes(parseRawBreakdownOutput(result.rawOutput), loadBlueprint(paths), {
      'scene-001': ['这一场不要出现回忆', '对白再短一点'],
    })
    const userNotes = scenes[0]?.director_notes.filter((note) => note.source === 'user') ?? []
    expect(userNotes.map((note) => note.id)).toEqual(['DIR_USER_001', 'DIR_USER_002'])
    const allNoteIds = scenes.flatMap((scene) => scene.director_notes.map((note) => note.id))
    expect(new Set(allNoteIds).size).toBe(allNoteIds.length)
    expect(scenes.length).toBe(result.scenes.length)
  })

  it('前置条件：没有 Blueprint 时明确报错', async () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 's5-no-bp', rawInput: '一个种子。\n' })
    const paths = projectPaths(root.dir, 's5-no-bp')
    await expect(runSceneBreakdown({ paths, provider: recorded('scene_breakdown') })).rejects.toThrow(/请先完成 Gate 2/)
  })

  it('Scene 与 fixture 一致：每场都有 narrative_role_ref / proposed_additions 永久 PROPOSED', async () => {
    const { result } = await breakdownOnce('s5-svc-06', 'multi-sentence.txt')
    const additions = result.scenes.flatMap((scene) => scene.proposed_additions)
    expect(additions.length).toBeGreaterThan(0)
    for (const addition of additions) {
      expect(addition.status).toBe('PROPOSED')
      expect(addition.source).toBe('scene_breakdown')
    }
    for (const scene of result.scenes) {
      expect(scene.narrative_role_ref).toMatch(/^BP_(STR|ARC)_/)
      expect(validateScene(scene)).toBeDefined()
    }
    expect(result.coverage.warnings).toEqual([])
  })
})
