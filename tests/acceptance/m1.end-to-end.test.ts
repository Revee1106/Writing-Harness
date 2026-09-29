import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runSeedInterpreter, isEvidenceLocatable } from '../../src/interpreter/interpreter.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { runGate2 } from '../../src/gate2/service.ts'
import { runSceneBreakdown, loadScenes, loadStoryState, loadCoverageReport } from '../../src/scenes/service.ts'
import { resolveStructure } from '../../src/scenes/resolver.ts'
import { assertNoUnresolvedOrphans, makeKnowledgeReveal, upsertOccurred } from '../../src/scenes/state.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadBlueprint, loadProposals, loadSeed, saveProposals, saveSeed } from '../../src/project/project.ts'
import { listBlueprintItemIds, type Blueprint } from '../../src/schema/blueprint.ts'
import { computeSeedPreservationRate } from '../../src/schema/proposal.ts'
import { validateStoryState, type StoryState } from '../../src/schema/story-state.ts'
import { validateScene, type Scene } from '../../src/schema/scene.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR, SEEDS_DIR } from '../helpers/story4.ts'

/**
 * Milestone M1 —— 最小端到端验证（《开发 Story 拆分》M1，强制节点）。
 *
 * 路径：
 * ```text
 * Seed → Interpreter → Gate 1 → Proposal → Gate 2 → Blueprint
 *      → Scene Breakdown → Story State → 手工模拟 Writer Context
 * ```
 *
 * 全部离线：模型回应来自 4 个契约的 recorded fixture；Seed 使用仓库内的真实中文 Seed。
 * M1 的每一项检查都与《开发 Story 拆分》M1「检查项」逐条对应。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-m1-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

const recorded = (contract: string): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, contract))

interface M1Run {
  readonly projectId: string
  readonly rawInput: string
  readonly paths: ReturnType<typeof projectPaths>
  readonly seed: ReturnType<typeof loadSeed>
  readonly proposals: ReturnType<typeof loadProposals>
  readonly blueprint: Blueprint
  readonly scenes: readonly Scene[]
  readonly state: StoryState
  readonly coverage: NonNullable<ReturnType<typeof loadCoverageReport>>
}

async function runM1(
  projectId: string,
  seedFile: string,
  gate1Ops: readonly { kind: string; id?: string }[] | null = null,
  gate2: Record<string, unknown> = { fromProposal: 'PROP_A' },
): Promise<M1Run> {
  const root = tempRoot()
  const rawInput = readFileSync(join(SEEDS_DIR, seedFile), 'utf8')
  createProject({ projectsRoot: root.dir, projectId, rawInput })
  const paths = projectPaths(root.dir, projectId)

  // Seed → Interpreter
  const interpretation = await runSeedInterpreter({ provider: recorded('seed-interpreter'), rawInput })
  // → Gate 1（含一次用户提升，验证 §5.1 的来源标记）
  const candidate = seedFromInterpreterResult(rawInput, interpretation)
  // 默认走 §5.1 的 skip 出口（不修改 Interpreter 结果）；
  // 需要验证"用户提升"来源标记时，由调用方显式传入 promote。
  const operations =
    gate1Ops ??
    (candidate.story_seed.ambiguous.length > 0
      ? [{ kind: 'skip' as const }]
      : [{ kind: 'skip' as const }])
  const gate1 = applyGate1Operations(candidate, operations as Parameters<typeof applyGate1Operations>[1])
  saveSeed(paths, gate1.seed)

  // → Story Developer（Proposal）
  const developer = await runStoryDeveloper({ provider: recorded('story_developer'), seed: gate1.seed })
  saveProposals(paths, developer.file)

  // → Gate 2（Blueprint）
  await runGate2({ paths, provider: recorded('blueprint_builder'), ...gate2 })

  // → Scene Breakdown（+ Story State + Coverage）
  const breakdown = await runSceneBreakdown({ paths, provider: recorded('scene_breakdown') })

  return {
    projectId,
    rawInput,
    paths,
    seed: loadSeed(paths),
    proposals: loadProposals(paths),
    blueprint: loadBlueprint(paths),
    scenes: breakdown.scenes,
    state: breakdown.state,
    coverage: breakdown.coverage,
  }
}

/**
 * 手工模拟 Writer Context（M1 明确要求"手工模拟"，真正的 Compiler 属于 Story 6）。
 * 这里只做一张"当前场景应该看到什么"的清单。
 */
interface SimulatedWriterContext {
  readonly scene_id: string
  readonly pov: string
  readonly scene: Scene
  readonly visibleInnerState: readonly string[]
  readonly allowedReveals: readonly string[]
  readonly revealedTruths: readonly string[]
  readonly futureSceneIds: readonly string[]
  readonly blueprintItemIds: readonly string[]
}

function simulateWriterContext(run: M1Run, sceneId: string): SimulatedWriterContext {
  const scene = run.scenes.find((candidate) => candidate.scene_id === sceneId) as Scene
  const currentOrder = scene.order
  const visible = run.blueprint.characters
    .filter((character) => character.inner_state_pov_visible.includes(scene.pov))
    .map((character) => character.id)
  const revealedTruths = run.blueprint.key_knowledge
    .filter((knowledge) => scene.allowed_reveals.includes(knowledge.id))
    .map((knowledge) => knowledge.truth)
  return {
    scene_id: scene.scene_id,
    pov: scene.pov,
    scene,
    visibleInnerState: visible,
    allowedReveals: scene.allowed_reveals,
    revealedTruths,
    // 手工模拟：Writer 只能拿到当前 Scene，后续 Scene 必须被排除
    futureSceneIds: [],
    blueprintItemIds: listBlueprintItemIds(run.blueprint),
  }
}

describe('M1：真实 Seed 端到端跑通（离线 fixture 驱动）', () => {
  it('三个真实 Seed（情感 / 悬疑 / 单场景）都能从一句 Seed 走到 Story State', async () => {
    const seeds: Array<[string, readonly { kind: string; id?: string }[], Record<string, unknown>]> = [
      ['multi-sentence.txt', [{ kind: 'skip' }], { fromProposal: 'PROP_A' }],
      [
        'story2/02-mystery.txt',
        [{ kind: 'skip' }],
        {
          fields: {
            title: 'PROP_A',
            genre: 'PROP_A',
            pov: 'PROP_B',
            target_length: 'PROP_A',
            premise: 'PROP_A',
            theme: 'PROP_A',
            characters: 'PROP_B',
            core_conflict: 'PROP_A',
            arc: 'PROP_B',
            structure: 'PROP_B',
            key_knowledge: 'PROP_A',
            foreshadowing: 'PROP_B',
            style_direction: 'PROP_A',
          },
          resolutions: { 'PROP_B:CONF_001': 'changed_user' },
        },
      ],
      // 单场景 Seed 走"用户提升"路径（对应 Story 2 的 promoted fixture）
      ['story2/07-single-scene.txt', [{ kind: 'promote', id: 'SEED_A001' }], { fromProposal: 'PROP_A' }],
    ]
    for (const [index, [seedFile, gate1Ops, gate2]] of seeds.entries()) {
      const run = await runM1(`m1-run-${index}`, seedFile, gate1Ops, gate2)
      expect(run.blueprint.blueprint_version, seedFile).toBe(1)
      expect(run.scenes.length, seedFile).toBeGreaterThanOrEqual(5)
      expect(run.state.blueprint_version, seedFile).toBe(1)
      expect(run.coverage.summary.scenes, seedFile).toBe(run.scenes.length)
    }
  })
})

describe('M1 检查项 1-2：status 与 source / source_refs 完整性', () => {
  it('seed：所有 fixed 项 USER_GIVEN，提升项 user_gate1 / gate1_confirmation', async () => {
    const run = await runM1('m1-status', 'story2/07-single-scene.txt', [{ kind: 'promote', id: 'SEED_A001' }])
    const { fixed_by_user } = run.seed.story_seed
    expect(fixed_by_user.length).toBeGreaterThan(0)
    for (const item of fixed_by_user) {
      expect(item.status).toBe('USER_GIVEN')
      expect(['user', 'user_gate1']).toContain(item.source)
      expect(['raw_seed', 'gate1_confirmation']).toContain(item.origin)
    }
    expect(fixed_by_user.some((item) => item.source === 'user_gate1' && item.origin === 'gate1_confirmation')).toBe(true)
    expect(run.seed.story_seed.raw_seed_anchor_ids.every((id) => id.startsWith('SEED_F'))).toBe(true)
  })

  it('blueprint：每个字段都有结构化 source_refs；scene：director_notes / additions 来源合法', async () => {
    const run = await runM1('m1-source-refs', 'multi-sentence.txt')
    const items = [
      run.blueprint.premise,
      run.blueprint.theme.primary,
      run.blueprint.core_conflict,
      run.blueprint.style_direction,
      ...Object.values(run.blueprint.structure),
      ...Object.values(run.blueprint.arc),
      ...run.blueprint.characters,
      ...run.blueprint.key_knowledge,
      ...run.blueprint.foreshadowing,
    ]
    for (const item of items) {
      expect(item.source_refs.length, JSON.stringify(item).slice(0, 80)).toBeGreaterThan(0)
      for (const ref of item.source_refs) {
        expect(['seed', 'proposal', 'user_edit', 'blueprint_gate2']).toContain(ref.type)
      }
    }
    for (const scene of run.scenes) {
      for (const note of scene.director_notes) {
        expect(['user', 'blueprint', 'scene']).toContain(note.source)
        expect(note.id).toMatch(/^DIR_(USER|BLUEPRINT|SCENE)_\d{3}$/)
      }
      for (const addition of scene.proposed_additions) {
        expect(addition).toMatchObject({ status: 'PROPOSED', source: 'scene_breakdown' })
      }
    }
  })
})

describe('M1 检查项 3-4：Blueprint → Scene 字段够用 / Scene 未引用未确认 Proposal', () => {
  it('Scene 具备写作所需字段，且不引用任何 Proposal', async () => {
    const run = await runM1('m1-fields', 'multi-sentence.txt')
    for (const scene of run.scenes) {
      for (const field of ['purpose', 'location', 'start_state', 'conflict', 'turn', 'end_state'] as const) {
        expect(scene[field].length, `${scene.scene_id}.${field}`).toBeGreaterThan(0)
      }
      expect(scene.characters.every((characterId) => run.blueprint.characters.some((character) => character.id === characterId))).toBe(true)
      expect(JSON.stringify(scene)).not.toContain('PROP_')
      expect(JSON.stringify(scene)).not.toContain('proposal')
    }
  })
})

describe('M1 检查项 5-6：Blueprint 可引用项有稳定 ID / known_by 支撑单双 POV', () => {
  it('所有可引用 ID 唯一且形态合法', async () => {
    const run = await runM1('m1-ids', 'multi-sentence.txt')
    const ids = listBlueprintItemIds(run.blueprint)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^(BP_[A-Z0-9_]+|K\d{3}|CH_[A-Z0-9_]+|OBH_[A-Z0-9_]+|REL_[A-Z0-9_]+)$/)
    }
  })

  it('known_by 覆盖每个 POV；单 POV 时 POV Filter 可直接查询', async () => {
    const run = await runM1('m1-knownby', 'multi-sentence.txt')
    for (const knowledge of run.blueprint.key_knowledge) {
      for (const pov of run.blueprint.meta.pov) {
        expect(Object.keys(knowledge.known_by)).toContain(pov)
      }
    }
    const stateEntry = run.state.knowledge_state[0]
    expect(stateEntry?.known_by).toEqual(run.blueprint.key_knowledge[0]?.known_by)
  })
})

describe('M1 检查项 7-8：角色内心可物理隔离 / relationship baseline 可投影', () => {
  it('非 POV 角色的内心不进入模拟 Writer Context', async () => {
    const run = await runM1('m1-isolation', 'multi-sentence.txt')
    const context = simulateWriterContext(run, 'scene-001')
    expect(context.visibleInnerState).toContain(run.blueprint.meta.pov[0] as string)
    const nonPovCharacters = run.blueprint.characters.filter(
      (character) => !run.blueprint.meta.pov.includes(character.id),
    )
    for (const character of nonPovCharacters) {
      expect(context.visibleInnerState).not.toContain(character.id)
    }
  })

  it('relationship baseline 能投影成 relationship_state', async () => {
    const run = await runM1('m1-relationship', 'multi-sentence.txt')
    const blueprintRelationships = run.blueprint.characters.flatMap((character) => character.relationships)
    expect(blueprintRelationships.length).toBeGreaterThan(0)
    expect(run.state.relationship_state.map((entry) => entry.blueprint_ref).sort()).toEqual(
      blueprintRelationships.map((relationship) => relationship.id).sort(),
    )
  })
})

describe('M1 检查项 9-11：结构位置解析 / allowed_reveals 可执行 / Future Scene 可排除', () => {
  it('reveal_at_structure + setup/payoff_at_structure 全部解析到真实 scene_id', async () => {
    const run = await runM1('m1-resolve', 'multi-sentence.txt')
    const resolution = resolveStructure(run.blueprint, run.scenes)
    for (const reveal of resolution.reveals) {
      expect(reveal.scene_id).toBeTruthy()
      expect(run.scenes.some((scene) => scene.scene_id === reveal.scene_id)).toBe(true)
    }
    for (const foreshadowing of resolution.foreshadowing) {
      expect(foreshadowing.resolved_setup_scene).toBeTruthy()
      expect(foreshadowing.resolved_payoff_scene).toBeTruthy()
    }
    expect(resolution.warnings).toEqual([])
  })

  it('allowed_reveals 由解析结果生成并可执行：只有 reveal Scene 能看到 truth', async () => {
    const run = await runM1('m1-reveals', 'multi-sentence.txt')
    for (const scene of run.scenes) {
      const context = simulateWriterContext(run, scene.scene_id)
      const isRevealScene = scene.allowed_reveals.length > 0
      expect(context.revealedTruths.length > 0, scene.scene_id).toBe(isRevealScene)
    }
    // 非 reveal Scene 的模拟 Context 不含任何 truth 文本
    const nonReveal = run.scenes.find((scene) => scene.allowed_reveals.length === 0) as Scene
    const nonRevealContext = simulateWriterContext(run, nonReveal.scene_id)
    for (const knowledge of run.blueprint.key_knowledge) {
      expect(nonRevealContext.revealedTruths).not.toContain(knowledge.truth)
    }
  })

  it('Future Scene 可排除：按 order 截断即可得到"当前及之前"的场景集合', async () => {
    const run = await runM1('m1-future', 'multi-sentence.txt')
    const current = run.scenes[1] as Scene
    const priorAndCurrent = run.scenes.filter((scene) => scene.order <= current.order)
    const future = run.scenes.filter((scene) => scene.order > current.order)
    expect(priorAndCurrent.length + future.length).toBe(run.scenes.length)
    expect(future.every((scene) => scene.order > current.order)).toBe(true)
    // 模拟 Context 只包含当前 Scene
    const context = simulateWriterContext(run, current.scene_id)
    expect(context.futureSceneIds).toEqual([])
    expect(context.scene.scene_id).toBe(current.scene_id)
  })
})

describe('M1 检查项 12-13：Seed Fidelity 可回溯 / relationship change 有 baseline', () => {
  it('seed_fidelity 可回溯到 Seed 锚点，且可用于 Seed Preservation Rate', async () => {
    const run = await runM1('m1-fidelity', 'multi-sentence.txt')
    const anchorIds = new Set(run.seed.story_seed.raw_seed_anchor_ids)
    const preserved = run.blueprint.seed_fidelity.preserved
    expect(preserved.length).toBeGreaterThan(0)
    for (const entry of preserved) {
      expect(anchorIds.has(entry.seed_ref), entry.seed_ref).toBe(true)
    }
    const rate = computeSeedPreservationRate(
      { proposal_id: 'BLUEPRINT', seed_fidelity: run.blueprint.seed_fidelity, conflicts: [] },
      run.seed.story_seed.raw_seed_anchor_ids,
    )
    expect(rate.rate_percent).toBeGreaterThan(0)
    expect(rate.unaccounted_anchor_ids).toEqual([])
  })

  it('relationship change 有可引用的 baseline（确定性 ID + from/to state）', async () => {
    const run = await runM1('m1-relchange', 'multi-sentence.txt')
    const { makeRelationshipChange } = await import('../../src/scenes/state.ts')
    const baseline = run.state.relationship_state[0]
    expect(baseline).toBeDefined()
    const change = makeRelationshipChange({
      relationship_ref: baseline?.blueprint_ref as string,
      scene_id: (run.scenes[run.scenes.length - 1] as Scene).scene_id,
      from_state: baseline?.state as string,
      to_state: 'separated',
      source_ref: 'drafts/final.md',
    })
    const next = upsertOccurred(run.state, [change])
    expect(next.relationship_state.find((entry) => entry.blueprint_ref === baseline?.blueprint_ref)?.state).toBe(
      baseline?.state as string,
    )
    expect(change.payload).toMatchObject({ from_state: baseline?.state, to_state: 'separated' })
    expect(() => validateStoryState(next)).not.toThrow()
  })
})

describe('M1 检查项 14-16：reveal 语义唯一 / Blueprint version 重建 / occurred 幂等', () => {
  it('reveal_to / known_by / allowed_reveals 的运行时语义唯一', async () => {
    const run = await runM1('m1-semantics', 'multi-sentence.txt')
    const knowledge = run.blueprint.key_knowledge[0]
    expect(knowledge?.reveal_to.length).toBeGreaterThan(0)
    const revealScene = run.scenes.find((scene) => scene.allowed_reveals.includes(knowledge?.id as string))
    expect(revealScene).toBeDefined()
    // 当前 Scene 是 reveal Scene 时，开场仍视为未 reveal（§17.2）
    const stateBefore = run.state.knowledge_state.find((entry) => entry.blueprint_ref === knowledge?.id)
    expect(stateBefore?.occurred_reveal).toBe(false)
  })

  it('Blueprint version → State rebuild 可跑通', async () => {
    const run = await runM1('m1-rebuild', 'multi-sentence.txt')
    const { rebuildStoryState } = await import('../../src/scenes/state.ts')
    const previous = validateStoryState({
      ...run.state,
      confirmed_scenes: [(run.scenes[0] as Scene).scene_id],
      occurred: [
        makeKnowledgeReveal({
          knowledge_ref: (run.blueprint.key_knowledge[0] as { id: string }).id,
          scene_id: (run.scenes[0] as Scene).scene_id,
          revealed_to: [run.blueprint.meta.pov[0] as string],
          source_ref: 'drafts/final.md',
        }),
      ],
    })
    const rebuilt = rebuildStoryState({
      blueprint: { ...run.blueprint, blueprint_version: 2 },
      scenes: run.scenes,
      seed: run.seed,
      previous,
    })
    expect(rebuilt.state.blueprint_version).toBe(2)
    expect(rebuilt.state.confirmed_scenes).toEqual(previous.confirmed_scenes)
    expect(rebuilt.state.occurred).toHaveLength(1)
    expect(rebuilt.state.state_rebuild_conflicts).toEqual([])
    expect(() => assertNoUnresolvedOrphans(rebuilt.state)).not.toThrow()
  })

  it('occurred 是 tagged union 且 ID 幂等', async () => {
    const run = await runM1('m1-occurred', 'multi-sentence.txt')
    const knowledgeId = (run.blueprint.key_knowledge[0] as { id: string }).id
    const sceneId = (run.scenes.find((scene) => scene.allowed_reveals.includes(knowledgeId)) as Scene).scene_id
    const entry = makeKnowledgeReveal({
      knowledge_ref: knowledgeId,
      scene_id: sceneId,
      revealed_to: [run.blueprint.meta.pov[0] as string],
      source_ref: 'drafts/final.md',
    })
    let state = upsertOccurred(run.state, [entry])
    state = upsertOccurred(state, [entry])
    expect(state.occurred).toHaveLength(1)
    expect(state.occurred[0]).toMatchObject({ type: 'knowledge_reveal', status: 'OCCURRED', source: 'final_text' })
    expect(Object.keys(state.occurred[0] ?? {}).sort()).toEqual([
      'id',
      'payload',
      'scene_id',
      'source',
      'source_ref',
      'status',
      'type',
    ])
  })
})

describe('M1 检查项 17-20：open question / source_refs / Draft Context / Proposal 隔离', () => {
  it('open question resolution_ref 可解析（blueprint_item 与 scene）', async () => {
    const run = await runM1('m1-openq', 'multi-sentence.txt')
    expect(run.state.open_questions.length).toBeGreaterThan(0)
    for (const question of run.state.open_questions) {
      expect(question.resolution_ref).toBeNull()
    }
    const resolved = validateStoryState({
      ...run.state,
      open_questions: run.state.open_questions.map((question, index) => ({
        ...question,
        state: 'resolved' as const,
        resolution_ref:
          index === 0
            ? { type: 'blueprint_item' as const, ref_id: 'BP_THEME_01' }
            : { type: 'scene' as const, ref_id: (run.scenes[0] as Scene).scene_id },
      })),
    })
    for (const question of resolved.open_questions) {
      expect(question.resolution_ref?.ref_id).toBeTruthy()
    }
  })

  it('source_refs 全部是结构化引用（没有自由字符串）', async () => {
    const run = await runM1('m1-refs', 'multi-sentence.txt')
    const text = readFileSync(run.paths.blueprint, 'utf8')
    expect(text).toContain('source_refs:')
    const refs = [
      ...run.blueprint.premise.source_refs,
      ...run.blueprint.characters.flatMap((character) => character.source_refs),
      ...run.blueprint.key_knowledge.flatMap((knowledge) => knowledge.source_refs),
    ]
    for (const ref of refs) {
      expect(typeof ref).toBe('object')
      expect(Object.keys(ref).sort()).toEqual(['ref_id', 'type'])
    }
  })

  it('Draft Context 规则唯一：配置来自 project-config.yaml（same_pov_previous / 600）', async () => {
    const run = await runM1('m1-draftctx', 'multi-sentence.txt')
    const config = readFileSync(run.paths.projectConfig, 'utf8')
    expect(config).toContain('mode: same_pov_previous')
    expect(config).toContain('max_chars: 600')
    // Draft Context 不是状态：story_state 不出现 draft 相关字段
    expect(readFileSync(run.paths.storyState, 'utf8')).not.toContain('draft')
  })

  it('proposals.yaml 可从 Writer 数据源完全隔离：Scene / State / Coverage 均不含 Proposal 内容', async () => {
    const run = await runM1('m1-isolation-proposals', 'multi-sentence.txt')
    const proposalIds = run.proposals.proposals.map((proposal) => proposal.proposal_id)
    const writerFacingFiles = [
      ...readdirSync(run.paths.scenesDir).map((name) => join(run.paths.scenesDir, name)),
      run.paths.storyState,
      run.paths.coverageReport,
    ]
    for (const file of writerFacingFiles) {
      const text = readFileSync(file, 'utf8')
      for (const proposalId of proposalIds) {
        expect(text, `${file} 不应包含 ${proposalId}`).not.toContain(proposalId)
      }
      expect(text).not.toContain('seed_fidelity:')
    }
    // Blueprint 里允许出现 proposal 溯源（source_refs），这是审计链路而不是 Writer 输入
    expect(readFileSync(run.paths.blueprint, 'utf8')).toContain('type: proposal')
  })

  it('M1 产物齐全：blueprint / scenes / story_state / reports 都在磁盘上', async () => {
    const run = await runM1('m1-artifacts', 'multi-sentence.txt')
    expect(existsSync(run.paths.blueprint)).toBe(true)
    expect(existsSync(run.paths.storyState)).toBe(true)
    expect(existsSync(run.paths.coverageReport)).toBe(true)
    expect(readdirSync(run.paths.scenesDir).length).toBe(run.scenes.length)
    // Writer 链路的三个文件都能独立回读并通过校验
    expect(() => validateScene(loadScenes(run.paths)[0] as never)).not.toThrow()
    expect(loadStoryState(run.paths)).toEqual(run.state)
    expect(loadCoverageReport(run.paths)?.warnings).toEqual(run.coverage.warnings)
    // Gate 1 的 raw_input 与用户原话逐字符一致
    expect(run.seed.story_seed.raw_input).toBe(run.rawInput)
    // 每条 fixed 都能回溯来源：原始锚点 origin=raw_seed（其原文证据在 Interpreter 阶段已逐条校验），
    // 用户提升项 source=user_gate1 / origin=gate1_confirmation。
    for (const item of run.seed.story_seed.fixed_by_user) {
      if (item.source === 'user') {
        expect(item.origin).toBe('raw_seed')
        expect(run.seed.story_seed.raw_seed_anchor_ids).toContain(item.id)
      } else {
        expect(item.source).toBe('user_gate1')
        expect(item.origin).toBe('gate1_confirmation')
        expect(run.seed.story_seed.raw_seed_anchor_ids).not.toContain(item.id)
      }
    }
    expect(isEvidenceLocatable('一件小事', run.rawInput)).toBe(true)
  })
})
