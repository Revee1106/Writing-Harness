import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compileAllContexts,
  compileContext,
  computePlannedKnowledgeView,
  sceneMatchTags,
  selectDraftContext,
  selectStyleSamples,
  STYLE_MATCH_ORDER,
} from '../../src/context/compiler.ts'
import { loadScenes } from '../../src/scenes/service.ts'
import { UnresolvedOrphanError } from '../../src/scenes/state.ts'
import { validateContextManifest } from '../../src/schema/context-manifest.ts'
import { TONE_TAGS } from '../../src/core/scene-types.ts'
import { validateStyleProfile } from '../../src/schema/style-profile.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, saveProposals, saveSeed, loadBlueprint } from '../../src/project/project.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { runGate2 } from '../../src/gate2/service.ts'
import { runSceneBreakdown } from '../../src/scenes/service.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { writeYamlFile, readYamlFile } from '../../src/io/yaml.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR, SEEDS_DIR } from '../helpers/story4.ts'

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-context-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

const recorded = (contract: string): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, contract))

interface CtxScenario {
  readonly seed: string
  readonly gate1Ops?: readonly { kind: string; id?: string }[]
  readonly gate2?: Record<string, unknown>
}

/** 构造"已到 Scene Breakdown 之后"的项目。 */
async function projectWithScenes(projectId: string, scenario: CtxScenario): Promise<ReturnType<typeof projectPaths>> {
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
  await runGate2({ paths, provider: recorded('blueprint_builder'), ...(scenario.gate2 ?? { fromProposal: 'PROP_A' }) })
  await runSceneBreakdown({ paths, provider: recorded('scene_breakdown') })
  return paths
}

const EMOTION: CtxScenario = { seed: 'multi-sentence.txt' }

describe('Context Compiler：数据源白名单（§20.1 / 架构设计 §20）', () => {
  it('proposals.yaml 不存在时仍能编译（证明它不是数据源）', async () => {
    const paths = await projectWithScenes('ctx-01', EMOTION)
    expect(existsSync(paths.proposals)).toBe(true)
    rmSync(paths.proposals)
    const result = compileContext({ paths, sceneId: 'scene-001' })
    expect(result.writerContext.scene_id).toBe('scene-001')
    // writer_context 与 manifest 都不含任何 Proposal 痕迹
    const serialized = JSON.stringify({ writerContext: result.writerContext, manifest: result.manifest })
    expect(serialized).not.toContain('PROP_')
    expect(serialized).not.toContain('seed_fidelity')
  })

  it('编译结果只依赖 blueprint / story_state / current scene / 配置 / 样式样本 / draft', async () => {
    const paths = await projectWithScenes('ctx-02', EMOTION)
    const result = compileContext({ paths, sceneId: 'scene-002' })
    expect(result.manifest.blueprint_version).toBe(loadBlueprint(paths).blueprint_version)
    expect(result.writerContext.pov).toBe('CH_WOMAN')
    expect(validateContextManifest(result.manifest)).toBeDefined()
  })

  it('存在未处理的 ORPHANED 时拒绝编译（§17.3）', async () => {
    const paths = await projectWithScenes('ctx-03', EMOTION)
    const state = readYamlFile(paths.storyState) as Record<string, unknown>
    writeYamlFile(paths.storyState, {
      ...state,
      state_rebuild_conflicts: [
        {
          id: 'SRC_001',
          type: 'ORPHANED',
          ref_type: 'scene',
          ref_id: 'scene-099',
          blueprint_version: 1,
          message: '测试用',
          resolution_note: null,
        },
      ],
    })
    expect(() => compileContext({ paths, sceneId: 'scene-001' })).toThrow(UnresolvedOrphanError)
    // 处理之后可继续
    writeYamlFile(paths.storyState, {
      ...state,
      state_rebuild_conflicts: [
        {
          id: 'SRC_001',
          type: 'ORPHANED',
          ref_type: 'scene',
          ref_id: 'scene-099',
          blueprint_version: 1,
          message: '测试用',
          resolution_note: '已确认',
        },
      ],
    })
    expect(() => compileContext({ paths, sceneId: 'scene-001' })).not.toThrow()
  })
})

describe('POV Filter：内心物理隔离（架构设计 §21）', () => {
  it('非当前 POV 角色的 desire / fear / contradiction 不出现在 writer_context，且在 excluded_sensitive 有 reason', async () => {
    const paths = await projectWithScenes('ctx-04', EMOTION)
    const result = compileContext({ paths, sceneId: 'scene-001' }) // scene-001 含 CH_WOMAN 与 CH_MAN
    const man = result.writerContext.characters.find((character) => character.id === 'CH_MAN')
    expect(man).toBeDefined()
    expect(man?.inner_state).toBeUndefined()
    expect(JSON.stringify(man)).not.toContain('想被认真对待')
    const exclusion = result.manifest.excluded_sensitive.find((entry) => entry.id === 'CH_MAN.inner_state')
    expect(exclusion?.reason).toBe('non_pov_inner_state')
    // POV 自己的内心可见
    const woman = result.writerContext.characters.find((character) => character.id === 'CH_WOMAN')
    expect(woman?.inner_state?.desire).toBeTruthy()
    // 未出场角色的内心同样被排除
    expect(result.manifest.excluded_sensitive.some((entry) => entry.reason === 'non_pov_inner_state')).toBe(true)
  })
})

describe('allowed_reveals 与 known_knowledge（§15 / §17.2）', () => {
  it('只有 reveal Scene 拿到 truth；其它场景以 not_revealed_yet 排除', async () => {
    const paths = await projectWithScenes('ctx-05', EMOTION)
    const revealScene = loadScenes(paths).find((scene) => scene.allowed_reveals.includes('K001'))
    expect(revealScene?.scene_id).toBe('scene-003')

    const reveal = compileContext({ paths, sceneId: 'scene-003' })
    expect(reveal.writerContext.allowed_reveals.map((entry) => entry.id)).toEqual(['K001'])
    expect(reveal.manifest.included_sensitive.some((entry) => entry.id === 'K001')).toBe(true)
    expect(JSON.stringify(reveal.writerContext)).toContain('道歉消息')

    const nonReveal = compileContext({ paths, sceneId: 'scene-001' })
    expect(nonReveal.writerContext.allowed_reveals).toEqual([])
    expect(JSON.stringify(nonReveal.writerContext)).not.toContain('道歉消息')
    const exclusion = nonReveal.manifest.excluded_sensitive.find((entry) => entry.id === 'K001')
    expect(exclusion?.reason).toBe('not_revealed_yet')
  })

  it('planned_knowledge_view：reveal 场开场仍视为未 reveal，之后的场景 POV 已知', async () => {
    const paths = await projectWithScenes('ctx-06', EMOTION)
    const scenes = loadScenes(paths)
    const blueprint = loadBlueprint(paths)
    const state = readYamlFile(paths.storyState) as never
    const revealScene = scenes.find((scene) => scene.scene_id === 'scene-003') as never
    const after = scenes.find((scene) => scene.scene_id === 'scene-004') as never
    const viewAtReveal = computePlannedKnowledgeView(blueprint, scenes, state, revealScene)
    expect(viewAtReveal.find((entry) => entry.knowledgeId === 'K001')?.povKnows).toBe(false)
    const viewAfter = computePlannedKnowledgeView(blueprint, scenes, state, after)
    expect(viewAfter.find((entry) => entry.knowledgeId === 'K001')?.povKnows).toBe(true)

    const compiledAfter = compileContext({ paths, sceneId: 'scene-004' })
    expect(compiledAfter.writerContext.known_knowledge_ids).toContain('K001')
    // 已知也不等于可以再 reveal：本场没有 reveal 权限 → truth 仍不进 Context
    expect(compiledAfter.writerContext.allowed_reveals).toEqual([])
    const exclusion = compiledAfter.manifest.excluded_sensitive.find((entry) => entry.id === 'K001')
    expect(exclusion?.reason).toBe('user_override')
  })

  it('confirmed 之后用 knowledge_state 判定（§17.2）', async () => {
    const paths = await projectWithScenes('ctx-07', EMOTION)
    const scenes = loadScenes(paths)
    const blueprint = loadBlueprint(paths)
    const state = readYamlFile(paths.storyState) as Record<string, unknown>
    const confirmed = {
      ...state,
      confirmed_scenes: ['scene-003'],
      knowledge_state: (state.knowledge_state as Array<Record<string, unknown>>).map((entry) =>
        entry.blueprint_ref === 'K001' ? { ...entry, occurred_reveal: true, known_by: { CH_WOMAN: true, CH_MAN: true } } : entry,
      ),
    }
    const view = computePlannedKnowledgeView(blueprint, scenes, confirmed as never, scenes[0] as never)
    const entry = view.find((candidate) => candidate.knowledgeId === 'K001')
    expect(entry?.source).toBe('confirmed_state')
    expect(entry?.povKnows).toBe(true)
  })

  it('foreshadowing 幕后解释永远不进 Context', async () => {
    const paths = await projectWithScenes('ctx-08', EMOTION)
    const result = compileContext({ paths, sceneId: 'scene-001' })
    const exclusion = result.manifest.excluded_sensitive.find((entry) => entry.type === 'foreshadowing')
    expect(exclusion?.reason).toBe('foreshadowing_backstage')
    expect(JSON.stringify(result.writerContext)).not.toContain('对话框')
  })
})

describe('observable_behavior_hints 与 tone（OQ-36 / OQ-41 / OQ-47）', () => {
  it('Scene 的 tone 是必填字段，且匹配集合 = scene_type ∪ tone', async () => {
    const paths = await projectWithScenes('ctx-09', EMOTION)
    const scenes = loadScenes(paths)
    for (const scene of scenes) {
      expect(scene.tone.length, scene.scene_id).toBeGreaterThanOrEqual(1)
      for (const tone of scene.tone) expect(TONE_TAGS).toContain(tone)
    }
    const first = scenes[0] as never
    expect(sceneMatchTags(first)).toEqual([
      (first as { scene_type: string }).scene_type,
      ...(first as { tone: string[] }).tone,
    ])
  })

  it('tone 变化会改变 hint 加载结果（scene_type ∪ tone 求交集）', async () => {
    const paths = await projectWithScenes('ctx-10', EMOTION)
    const sceneFile = join(paths.scenesDir, 'scene-001.yaml')
    const scene = readYamlFile(sceneFile) as Record<string, unknown>
    // 去掉 conflict tone：OBH_MAN_01（标签 [conflict]）不再命中
    writeYamlFile(sceneFile, { ...scene, tone: ['restraint'] })
    const without = compileContext({ paths, sceneId: 'scene-001' })
    expect(without.writerContext.characters.find((character) => character.id === 'CH_MAN')?.observable_behavior_hints).toEqual([])

    // 加上 conflict tone：命中
    writeYamlFile(sceneFile, { ...scene, tone: ['conflict'] })
    const withTone = compileContext({ paths, sceneId: 'scene-001' })
    expect(
      withTone.writerContext.characters.find((character) => character.id === 'CH_MAN')?.observable_behavior_hints.map((hint) => hint.id),
    ).toEqual(['OBH_MAN_01'])
  })
})

describe('Style Samples（§23.1 降级 + 不阻塞）', () => {
  it('四级降级顺序：pov+scene_type+tone → pov+scene_type → pov → 无匹配', async () => {
    const paths = await projectWithScenes('ctx-11', EMOTION)
    const scene = loadScenes(paths)[0] as never
    const make = (samples: unknown[]): ReturnType<typeof validateStyleProfile> =>
      validateStyleProfile({ schema_version: '0.1', samples })

    const base = { tags: { pov: 'CH_WOMAN', scene_type: 'dialogue', tone: 'conflict' }, text: 'x', de_entity: false }
    // 只命中 pov
    const onlyPov = make([{ ...base, sample_id: 'SAMPLE_001', tags: { pov: 'CH_WOMAN', scene_type: 'interior', tone: 'restraint' } }])
    expect(selectStyleSamples(onlyPov, scene).level).toBe('pov')
    // 命中 pov + scene_type（样本 tone 与 Scene.tone 不同 → 降到第二级）
    const povScene = make([{ ...base, sample_id: 'SAMPLE_001', tags: { pov: 'CH_WOMAN', scene_type: 'dialogue', tone: 'grief' } }])
    expect(selectStyleSamples(povScene, scene).level).toBe('pov+scene_type')
    // 命中 pov + scene_type + tone（Scene.tone 直接声明 conflict）
    const sceneFile = join(paths.scenesDir, 'scene-001.yaml')
    const raw = readYamlFile(sceneFile) as Record<string, unknown>
    writeYamlFile(sceneFile, { ...raw, tone: ['conflict'] })
    const conflictSample = make([{ ...base, sample_id: 'SAMPLE_001' }])
    const withTone = selectStyleSamples(conflictSample, loadScenes(paths)[0] as never)
    expect(withTone.level).toBe('pov+scene_type+tone')
    expect(withTone.matchedOn).toEqual(['pov', 'scene_type', 'tone'])
    // 无匹配
    const none = make([{ ...base, sample_id: 'SAMPLE_001', tags: { pov: 'CH_OTHER', scene_type: 'action', tone: 'grief' } }])
    expect(selectStyleSamples(none, loadScenes(paths)[0] as never).level).toBe('none')
    expect(STYLE_MATCH_ORDER).toEqual(['pov+scene_type+tone', 'pov+scene_type', 'pov', 'none'])
  })

  it('无样本时不阻塞，且 Manifest 记录空匹配', async () => {
    const paths = await projectWithScenes('ctx-12', EMOTION)
    const result = compileContext({ paths, sceneId: 'scene-001' })
    expect(result.manifest.style_samples).toEqual([])
    expect(result.writerContext.style_samples).toEqual([])
    expect(result.writerContext.scene.purpose).toBeTruthy()
  })

  it('最多加载 3 个样本，并按 §23.2 优先使用去实体化文本', async () => {
    const paths = await projectWithScenes('ctx-13', EMOTION)
    const samples = Array.from({ length: 5 }, (_unused, index) => ({
      sample_id: `SAMPLE_${String(index + 1).padStart(3, '0')}`,
      tags: { pov: 'CH_WOMAN', scene_type: 'dialogue', tone: 'conflict' },
      text: `原文${index}`,
      de_entity: true,
      sanitized_text: `[CHAR_A]的样本${index}`,
    }))
    writeYamlFile(paths.styleProfile, { schema_version: '0.1', samples })
    const result = compileContext({ paths, sceneId: 'scene-001' })
    expect(result.writerContext.style_samples).toHaveLength(3)
    expect(result.writerContext.style_samples[0]?.text).toContain('[CHAR_A]')
    expect(result.manifest.style_samples).toHaveLength(3)
    for (const sample of result.manifest.style_samples) {
      // Scene 的 tone 含 conflict（fixture 显式声明），因此命中最高一级
      expect(sample.matched_on).toEqual(['pov', 'scene_type', 'tone'])
    }
  })
})

describe('Draft Context（§19.1；OQ-16 计数口径）', () => {
  it('取当前 Scene 之前最近的相同 POV Scene Draft 的末尾 600 个非空白码点', async () => {
    const paths = await projectWithScenes('ctx-14', EMOTION)
    mkdirSync(paths.draftsDir, { recursive: true })
    const long = `${'前'.repeat(700)}\n\n结尾。`
    writeFileSync(join(paths.draftsDir, 'scene-002.md'), long, 'utf8')
    // scene-005 是 CH_WOMAN 视角，之前的同 POV Draft 是 scene-002
    const result = compileContext({ paths, sceneId: 'scene-005' })
    expect(result.writerContext.draft_context?.scene_id).toBe('scene-002')
    expect(result.writerContext.draft_context?.counted_code_points).toBe(600)
    expect(result.writerContext.draft_context?.text.endsWith('结尾。')).toBe(true)
    expect(result.writerContext.draft_context?.text.startsWith('前')).toBe(true)

    const selection = selectDraftContext({
      paths,
      scene: loadScenes(paths)[4] as never,
      scenes: loadScenes(paths),
      maxChars: 10,
    })
    expect(selection?.counted_code_points).toBe(10)
  })

  it('首选最近的同 POV Draft；没有则返回 null（首个该 POV Scene 不加载）', async () => {
    const paths = await projectWithScenes('ctx-15', EMOTION)
    mkdirSync(paths.draftsDir, { recursive: true })
    const first = compileContext({ paths, sceneId: 'scene-001' })
    expect(first.writerContext.draft_context).toBeNull()

    writeFileSync(join(paths.draftsDir, 'scene-001.md'), '第一场草稿。', 'utf8')
    writeFileSync(join(paths.draftsDir, 'scene-002.md'), '第二场草稿。', 'utf8')
    const second = compileContext({ paths, sceneId: 'scene-002' })
    expect(second.writerContext.draft_context?.scene_id).toBe('scene-001')
    const third = compileContext({ paths, sceneId: 'scene-003' })
    expect(third.writerContext.draft_context?.scene_id).toBe('scene-002')
  })

  it('不加载其它 POV 的 Draft，也不加载完整上一场', async () => {
    const paths = await projectWithScenes('ctx-16', { seed: 'story2/03-realism.txt', gate2: {
      fields: {
        title: 'PROP_A', genre: 'PROP_A', pov: 'PROP_B', target_length: 'PROP_B', premise: 'PROP_A', theme: 'PROP_B',
        characters: 'PROP_B', core_conflict: 'PROP_B', arc: 'PROP_A', structure: 'PROP_A', key_knowledge: 'PROP_B',
        foreshadowing: 'PROP_A', style_direction: 'PROP_B',
      },
      resolutions: { 'PROP_B:CONF_001': 'changed_user' },
    } })
    mkdirSync(paths.draftsDir, { recursive: true })
    const scenes = loadScenes(paths)
    const dualPovScenes = scenes.filter((scene, index) => index > 0 && scene.pov !== (scenes[0] as { pov: string }).pov)
    // 双 POV 项目：为第一场写 Draft，编译另一 POV 的场景时不应加载它
    writeFileSync(join(paths.draftsDir, `${(scenes[0] as { scene_id: string }).scene_id}.md`), '第一场草稿。', 'utf8')
    if (dualPovScenes.length > 0) {
      const target = dualPovScenes[0] as { scene_id: string; pov: string }
      const result = compileContext({ paths, sceneId: target.scene_id })
      const draft = result.writerContext.draft_context
      if (draft !== null) {
        expect(draft.scene_id).not.toBe((scenes[0] as { scene_id: string }).scene_id)
      }
    }
    // 截断长度不超过配置的 max_chars
    const result = compileContext({ paths, sceneId: (scenes[1] as { scene_id: string }).scene_id })
    if (result.writerContext.draft_context !== null) {
      expect(result.writerContext.draft_context.counted_code_points).toBeLessThanOrEqual(600)
    }
  })
})

describe('Director Surface 组装规则（Story 6 起始会裁决）', () => {
  it('Scene 的 director_notes 逐条保留原 id 与 source；style_direction 固定为 DIR_BLUEPRINT_001', async () => {
    const paths = await projectWithScenes('ctx-17', EMOTION)
    const result = compileContext({ paths, sceneId: 'scene-001' })
    const scene = loadScenes(paths)[0] as { director_notes: Array<{ id: string; source: string }> }
    for (const note of scene.director_notes) {
      const entry = result.manifest.director_surface.find((candidate) => candidate.id === note.id)
      expect(entry).toBeDefined()
      expect(entry?.source).toBe(note.source === 'user' ? 'user_override' : note.source)
    }
    const blueprintEntry = result.manifest.director_surface.find((entry) => entry.id === 'DIR_BLUEPRINT_001')
    expect(blueprintEntry?.source).toBe('blueprint')
    expect(blueprintEntry?.source_ref).toContain('BP_STYLE_01')
    expect(result.manifest.overrides).toEqual([])
  })

  it('禁止把 key_knowledge.truth 或 proposed_additions 拆进 director_surface', async () => {
    const paths = await projectWithScenes('ctx-18', EMOTION)
    const result = compileContext({ paths, sceneId: 'scene-003' })
    const surfaceText = result.manifest.director_surface.map((entry) => entry.instruction).join('\n')
    expect(surfaceText).not.toContain('药') // 无关
    expect(surfaceText).not.toContain('道歉消息')
    const blueprint = loadBlueprint(paths)
    for (const knowledge of blueprint.key_knowledge) {
      expect(surfaceText).not.toContain(knowledge.truth)
    }
    const scenes = loadScenes(paths)
    for (const scene of scenes) {
      for (const addition of scene.proposed_additions) {
        expect(surfaceText).not.toContain(addition.value)
      }
    }
  })

  it('用户补充 note → DIR_USER_NNN / source=user_override，并一对一进 overrides', async () => {
    const paths = await projectWithScenes('ctx-19', EMOTION)
    const result = compileContext({ paths, sceneId: 'scene-001', userNotes: ['不要写回忆', '对白再短一点'] })
    const userEntries = result.manifest.director_surface.filter((entry) => entry.source === 'user_override')
    expect(userEntries.map((entry) => entry.id)).toEqual(['DIR_USER_001', 'DIR_USER_002'])
    expect(result.manifest.overrides).toHaveLength(2)
    for (const override of result.manifest.overrides) {
      const target = result.manifest.director_surface.find((entry) => entry.id === override.director_surface_ref)
      expect(target?.source).toBe('user_override')
      expect(override.note).toBe(target?.instruction)
    }
    expect(result.writerContext.director_surface.some((entry) => entry.source === 'user_override')).toBe(true)
  })
})

describe('批量编译与 Manifest 落盘格式', () => {
  it('compileAllContexts 为每个 Scene 各生成一份 Manifest', async () => {
    const paths = await projectWithScenes('ctx-20', EMOTION)
    const results = compileAllContexts(paths)
    expect(results).toHaveLength(loadScenes(paths).length)
    for (const result of results) {
      expect(validateContextManifest(result.manifest)).toBeDefined()
      expect(result.manifest.scene_id).toBe(result.writerContext.scene_id)
      expect(result.manifest.future_content_exposed).toBe(false)
      expect(result.manifest.unconfirmed_proposal_exposed).toBe(false)
      for (const exclusion of result.manifest.excluded_sensitive) {
        expect(exclusion.reason.length).toBeGreaterThan(0)
      }
    }
  })

  it('每个 Scene 的 excluded_sensitive 都写明理由（不为空）', async () => {
    const paths = await projectWithScenes('ctx-21', EMOTION)
    for (const result of compileAllContexts(paths)) {
      expect(result.manifest.excluded_sensitive.length, result.manifest.scene_id).toBeGreaterThan(0)
    }
  })
})
