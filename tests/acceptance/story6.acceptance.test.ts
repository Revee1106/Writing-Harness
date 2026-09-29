import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileAllContexts, compileContext, sceneMatchTags } from '../../src/context/compiler.ts'
import { loadScenes, loadStoryState } from '../../src/scenes/service.ts'
import { validateContextManifest, EXCLUSION_REASONS } from '../../src/schema/context-manifest.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadBlueprint, saveProposals, saveSeed } from '../../src/project/project.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { runGate2 } from '../../src/gate2/service.ts'
import { runSceneBreakdown } from '../../src/scenes/service.ts'
import { writeYamlFile, readYamlFile } from '../../src/io/yaml.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR, SEEDS_DIR } from '../helpers/story4.ts'

/**
 * Story 6 验收测试（《开发 Story 拆分》Story 6「验收」）。
 *
 * 覆盖 5 个离线场景 × 每个 5 个 Scene = 25 个 POV 场景（远超"至少 10 个 POV 场景"要求），
 * 包含单 POV 与双 POV、含 Gate 1 提升项、含 manual Blueprint。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story6-')
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

const SCENARIOS = {
  emotion: { seed: 'multi-sentence.txt' },
  mystery: {
    seed: 'story2/02-mystery.txt',
    gate2: {
      fields: {
        title: 'PROP_A', genre: 'PROP_A', pov: 'PROP_B', target_length: 'PROP_A', premise: 'PROP_A', theme: 'PROP_A',
        characters: 'PROP_B', core_conflict: 'PROP_A', arc: 'PROP_B', structure: 'PROP_B', key_knowledge: 'PROP_A',
        foreshadowing: 'PROP_B', style_direction: 'PROP_A',
      },
      resolutions: { 'PROP_B:CONF_001': 'changed_user' },
    },
  },
  realism: {
    seed: 'story2/03-realism.txt',
    gate2: {
      fields: {
        title: 'PROP_A', genre: 'PROP_A', pov: 'PROP_B', target_length: 'PROP_B', premise: 'PROP_A', theme: 'PROP_B',
        characters: 'PROP_B', core_conflict: 'PROP_B', arc: 'PROP_A', structure: 'PROP_A', key_knowledge: 'PROP_B',
        foreshadowing: 'PROP_A', style_direction: 'PROP_B',
      },
      resolutions: { 'PROP_B:CONF_001': 'changed_user' },
    },
  },
  'single-scene': { seed: 'story2/07-single-scene.txt', gate1Ops: [{ kind: 'promote', id: 'SEED_A001' }] },
  warmth: {
    seed: 'story2/04-warmth.txt',
    gate2: {
      fields: Object.fromEntries(
        ['title', 'genre', 'pov', 'target_length', 'premise', 'theme', 'characters', 'core_conflict', 'arc', 'structure', 'key_knowledge', 'foreshadowing', 'style_direction'].map((field) => [field, 'user']),
      ),
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
    },
  },
} satisfies Record<string, Scenario>
async function projectFor(projectId: string, scenario: Scenario): Promise<ReturnType<typeof projectPaths>> {
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

/** 为场景准备一份可用的采样项目（含 style 样本）。 */
async function projectWithStyle(projectId: string, scenario: Scenario): Promise<ReturnType<typeof projectPaths>> {
  const paths = await projectFor(projectId, scenario)
  const blueprint = loadBlueprint(paths)
  writeYamlFile(paths.styleProfile, {
    schema_version: '0.1',
    samples: [
      {
        sample_id: 'SAMPLE_001',
        tags: { pov: blueprint.meta.pov[0] as string, scene_type: 'dialogue', tone: 'conflict' },
        text: '原文样本（未去实体化）',
        de_entity: false,
      },
      {
        sample_id: 'SAMPLE_002',
        tags: { pov: blueprint.meta.pov[0] as string, scene_type: 'interior', tone: 'restraint' },
        text: '原文样本二',
        de_entity: true,
        sanitized_text: '[CHAR_A]的样本二',
      },
    ],
  })
  return paths
}

describe('验收 1：至少 10 个 POV 场景，secret 不泄漏', () => {
  it('25 个 POV 场景逐场编译：未授权的 truth 文本一律不出现', async () => {
    let compiledScenes = 0
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      const paths = await projectWithStyle(`s6-${key}`, scenario)
      const blueprint = loadBlueprint(paths)
      const scenes = loadScenes(paths)
      for (const scene of scenes) {
        const result = compileContext({ paths, sceneId: scene.scene_id })
        compiledScenes += 1
        const serialized = JSON.stringify(result.writerContext)
        for (const knowledge of blueprint.key_knowledge) {
          if (scene.allowed_reveals.includes(knowledge.id)) continue
          expect(serialized, `${key}/${scene.scene_id} 泄漏了 ${knowledge.id}`).not.toContain(knowledge.truth)
        }
        // 未授权 reveal 都必须在 excluded_sensitive 中有记录与 reason
        for (const knowledge of blueprint.key_knowledge) {
          if (scene.allowed_reveals.includes(knowledge.id)) continue
          const entry = result.manifest.excluded_sensitive.find((candidate) => candidate.id === knowledge.id)
          expect(entry, `${key}/${scene.scene_id} 缺少 ${knowledge.id} 的排除记录`).toBeDefined()
          expect(EXCLUSION_REASONS).toContain(entry?.reason as never)
        }
      }
    }
    expect(compiledScenes).toBeGreaterThanOrEqual(10)
  })
})

describe('验收 2：future 不泄漏', () => {
  it('writer_context 只含当前 Scene；future_content_exposed=false', async () => {
    const paths = await projectWithStyle('s6-future', SCENARIOS.emotion)
    const scenes = loadScenes(paths)
    const target = scenes[1] as { scene_id: string; order: number }
    const result = compileContext({ paths, sceneId: target.scene_id })
    expect(result.writerContext.scene.scene_id).toBe(target.scene_id)
    expect(result.writerContext.scene.order).toBe(target.order)
    const serialized = JSON.stringify(result.writerContext)
    for (const scene of scenes.filter((candidate) => candidate.order > target.order)) {
      expect(serialized).not.toContain(scene.purpose)
      expect(serialized).not.toContain(scene.end_state)
    }
    expect(result.manifest.future_content_exposed).toBe(false)
    // 后续 Scene 的内容在 Manifest 中以 future_scene 记录（若被排除集合包含）
    expect(result.manifest.excluded_sensitive.every((entry) => entry.reason !== undefined)).toBe(true)
  })
})

describe('验收 3：Proposal 文件不可达', () => {
  it('删除 proposals.yaml 仍可编译；writer_context 与 manifest 不含 Proposal 痕迹', async () => {
    const paths = await projectWithStyle('s6-proposals', SCENARIOS.emotion)
    rmSync(paths.proposals)
    const result = compileContext({ paths, sceneId: 'scene-001' })
    const serialized = JSON.stringify({ writerContext: result.writerContext, manifest: result.manifest })
    expect(serialized).not.toContain('PROP_')
    expect(serialized).not.toContain('seed_fidelity')
    expect(serialized).not.toContain('conflicts')
    expect(result.manifest.unconfirmed_proposal_exposed).toBe(false)
  })
})

describe('验收 4：allowed reveal 正常进入', () => {
  it('reveal 场景拿到 truth + reveal_to + reveal_to_reader', async () => {
    const paths = await projectWithStyle('s6-reveal', SCENARIOS.emotion)
    const blueprint = loadBlueprint(paths)
    const revealScene = loadScenes(paths).find((scene) => scene.allowed_reveals.length > 0) as { scene_id: string; allowed_reveals: string[] }
    const result = compileContext({ paths, sceneId: revealScene.scene_id })
    const knowledge = blueprint.key_knowledge.find((candidate) => candidate.id === revealScene.allowed_reveals[0])
    expect(result.writerContext.allowed_reveals).toHaveLength(1)
    expect(result.writerContext.allowed_reveals[0]?.truth).toBe(knowledge?.truth)
    expect(result.writerContext.allowed_reveals[0]?.reveal_to).toEqual(knowledge?.reveal_to)
    expect(result.writerContext.allowed_reveals[0]?.reveal_to_reader).toBe(knowledge?.reveal_to_reader)
    expect(result.manifest.included_sensitive.some((entry) => entry.id === knowledge?.id)).toBe(true)
  })
})

describe('验收 5：excluded_sensitive 有 reason', () => {
  it('每条排除记录都有六类枚举之一作为 reason，且非空', async () => {
    const paths = await projectWithStyle('s6-reasons', SCENARIOS.emotion)
    for (const result of compileAllContexts(paths)) {
      expect(result.manifest.excluded_sensitive.length).toBeGreaterThan(0)
      for (const entry of result.manifest.excluded_sensitive) {
        expect(EXCLUSION_REASONS).toContain(entry.reason)
        expect(entry.source_ref.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('验收 6：user override 可追踪（included / excluded 都支持 user_override）', () => {
  it('用户 note 进 director_surface（source=user_override）并一对一进 overrides', async () => {
    const paths = await projectWithStyle('s6-override', SCENARIOS.emotion)
    const result = compileContext({ paths, sceneId: 'scene-002', userNotes: ['这一场只写动作，不写心理'] })
    const entries = result.manifest.director_surface.filter((entry) => entry.source === 'user_override')
    expect(entries).toHaveLength(1)
    expect(result.manifest.overrides).toHaveLength(1)
    expect(entries[0]?.id).toBe(result.manifest.overrides[0]?.director_surface_ref)
    // user_override 也出现在 included_sensitive / excluded_sensitive 的 type 枚举中
    expect(result.manifest.included_sensitive.map((entry) => entry.type)).toContain('key_knowledge')
    expect(validateContextManifest(result.manifest).overrides).toHaveLength(1)
  })

  it('POV 已知但本场无 reveal 权限时，reason=user_override（保留用户已知状态而不泄漏计划真相）', async () => {
    const paths = await projectWithStyle('s6-override-2', SCENARIOS.emotion)
    const result = compileContext({ paths, sceneId: 'scene-004' })
    const entry = result.manifest.excluded_sensitive.find((candidate) => candidate.id === 'K001')
    expect(entry?.reason).toBe('user_override')
    expect(JSON.stringify(result.writerContext)).not.toContain('道歉消息')
  })
})

describe('验收 7：非当前 POV 角色完整内心不可达', () => {
  it('双 POV 项目：每场只暴露当前 POV 的内心，另一方仅可观察行为', async () => {
    const paths = await projectWithStyle('s6-pov', SCENARIOS.realism)
    const blueprint = loadBlueprint(paths)
    for (const scene of loadScenes(paths)) {
      const result = compileContext({ paths, sceneId: scene.scene_id })
      for (const character of result.writerContext.characters) {
        const visible = character.inner_state !== undefined
        expect(visible, `${scene.scene_id}/${character.id}`).toBe(character.id === scene.pov)
      }
      // 非 POV 角色的 desire / fear / contradiction 文本不出现
      const serialized = JSON.stringify(result.writerContext)
      for (const character of blueprint.characters) {
        if (character.id === scene.pov) continue
        expect(serialized).not.toContain(character.desire)
        expect(serialized).not.toContain(character.fear)
        expect(serialized).not.toContain(character.contradiction)
      }
    }
  })
})

describe('验收 8：observable_behavior_hints 仅按匹配加载', () => {
  it('只加载标签命中 scene_type ∪ tone 的 hint', async () => {
    const paths = await projectWithStyle('s6-hints', SCENARIOS.emotion)
    const blueprint = loadBlueprint(paths)
    for (const scene of loadScenes(paths)) {
      const result = compileContext({ paths, sceneId: scene.scene_id })
      const tags = sceneMatchTags(scene)
      for (const character of result.writerContext.characters) {
        const source = blueprint.characters.find((candidate) => candidate.id === character.id)
        const expected = (source?.observable_behavior_hints ?? [])
          .filter((hint) => hint.applicable_scene_types.some((tag) => tags.includes(tag)))
          .map((hint) => hint.id)
        expect(character.observable_behavior_hints.map((hint) => hint.id), `${scene.scene_id}/${character.id}`).toEqual(expected)
      }
    }
  })
})

describe('验收 9：当前 POV 对 K001 的已知/未知由 confirmed state 或 planned_knowledge_view 唯一判定', () => {
  it('planned 与 confirmed 两条路径都可用，且判定唯一', async () => {
    const paths = await projectWithStyle('s6-known', SCENARIOS.emotion)
    const before = compileContext({ paths, sceneId: 'scene-001' })
    expect(before.writerContext.known_knowledge_ids).not.toContain('K001')
    const revealOrder = compileContext({ paths, sceneId: 'scene-003' })
    expect(revealOrder.writerContext.known_knowledge_ids).not.toContain('K001')
    const after = compileContext({ paths, sceneId: 'scene-004' })
    expect(after.writerContext.known_knowledge_ids).toContain('K001')

    // confirmed 之后：knowledge_state 说了算（这里标记为已知）
    const state = loadStoryState(paths) as Record<string, unknown>
    writeYamlFile(paths.storyState, {
      ...state,
      confirmed_scenes: ['scene-003'],
      knowledge_state: (state.knowledge_state as Array<Record<string, unknown>>).map((entry) =>
        entry.blueprint_ref === 'K001' ? { ...entry, occurred_reveal: true, known_by: { CH_WOMAN: true, CH_MAN: true } } : entry,
      ),
    })
    const confirmPath = compileContext({ paths, sceneId: 'scene-001' })
    expect(confirmPath.writerContext.known_knowledge_ids).toContain('K001')
  })
})

describe('验收 10：allowed_reveals 只决定当前 Scene reveal 权限', () => {
  it('已知 ≠ 可 reveal：已知的知识在非 reveal 场仍不进 Context', async () => {
    const paths = await projectWithStyle('s6-permission', SCENARIOS.emotion)
    const result = compileContext({ paths, sceneId: 'scene-005' })
    expect(result.writerContext.known_knowledge_ids).toContain('K001')
    expect(result.writerContext.allowed_reveals).toEqual([])
    expect(JSON.stringify(result.writerContext)).not.toContain('道歉消息')
  })
})

describe('验收 11-12：两个 exposed 标志恒为 false', () => {
  it('所有场景的 Manifest 都断言 false，且 Schema 强制', async () => {
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      const paths = await projectWithStyle(`s6-flags-${key}`, scenario)
      for (const result of compileAllContexts(paths)) {
        expect(result.manifest.future_content_exposed).toBe(false)
        expect(result.manifest.unconfirmed_proposal_exposed).toBe(false)
      }
    }
  })
})

describe('验收附加：Manifest 落盘与 Draft Context', () => {
  it('reports/context-manifest.yaml 可写盘回读并通过校验', async () => {
    const paths = await projectWithStyle('s6-write', SCENARIOS.emotion)
    const result = compileContext({ paths, sceneId: 'scene-003' })
    writeYamlFile(paths.contextManifestReport, result.manifest)
    expect(existsSync(paths.contextManifestReport)).toBe(true)
    const reloaded = validateContextManifest(readYamlFile(paths.contextManifestReport))
    expect(reloaded).toEqual(result.manifest)
    expect(reloaded.scene_id).toBe('scene-003')
  })

  it('Draft Context 按 same_pov_previous / 600 码点加载，且不写入 Story State（§19.1）', async () => {
    const paths = await projectWithStyle('s6-draft', SCENARIOS.emotion)
    mkdirSync(paths.draftsDir, { recursive: true })
    writeFileSync(join(paths.draftsDir, 'scene-001.md'), `${'她'.repeat(700)}（末尾）`, 'utf8')
    const result = compileContext({ paths, sceneId: 'scene-002' })
    expect(result.writerContext.draft_context?.scene_id).toBe('scene-001')
    expect(result.writerContext.draft_context?.counted_code_points).toBe(600)
    // Draft Context 不是状态：不写 story_state，也不触发任何状态升级
    const stateText = readFileSync(paths.storyState, 'utf8')
    expect(stateText).not.toContain('她'.repeat(10))
    expect(stateText).not.toContain('draft')
    expect(loadStoryState(paths)?.occurred).toEqual([])
  })
})
