import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { runGate3 } from '../../src/state/gate3.ts'
import { applyOccurredToState, compareExtraction, parseExtraction, assembleFinalFromProject } from '../../src/state/gate3.ts'
import { loadBlueprint, loadSeed, loadProjectConfig } from '../../src/project/project.ts'
import { loadScenes, loadStoryState } from '../../src/scenes/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { readTextFile, writeYamlFile } from '../../src/io/yaml.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { validateStoryState } from '../../src/schema/story-state.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'

/**
 * Story 10 原则测试（《开发 Story 拆分》Story 10 F / 《架构设计》§34 的四条不可违反原则）。
 *
 * P1 `LLM 无权修改现实`：State Extractor 的输出不能改动 Blueprint / Seed / 计划本身。
 * P2 `可以提案，不能伪装`：Harness 新增内容一律 source=harness / status=PROPOSED（Blueprint 除外，见 OQ-18）。
 * P3 `Context Compiler 必须可审计`：final.md 的每个 Scene 都能追溯到 draft 文件与 Scene Intent。
 * P4 `推演不会产生事实`：State Extractor 的候选只有在 Harness 校验通过后才写入 story_state；
 *    冲突只记录，不落状态，也不回写 Blueprint。
 */

/**
 * 测试专用临时目录。
 *
 * 副本一律落在**系统临时区**（`makeTempDir` → `mkdtempSync(os.tmpdir())`），
 * 不是仓库内；清理通过 `onTestFinished()` 注册，**测试失败时同样会执行**
 * （等价于 finally，不依赖"事后看 git status"）。
 */
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-s10-principles-')
  onTestFinished(() => {
    dir.cleanup()
  })
  return dir
}

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

const provider = (): RecordedProvider =>
  RecordedProvider.fromDirectory(join(REPO_ROOT, 'tests/fixtures/recorded/state_extractor'))

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files[full.slice(dir.length + 1)] = readFileSync(full, 'utf8')
    }
  }
  walk(dir)
  return files
}

describe('P1：LLM 无权修改现实', () => {
  it('Gate 3 运行后 Blueprint / Seed / project.yaml / scenes 逐字节不变', async () => {
    const paths = cloneProject('demo-01')
    const before = snapshot(paths.dir)
    await runGate3({ paths, provider: provider(), confirm: true, now: new Date('2026-01-01T00:00:00.000Z') })
    const after = snapshot(paths.dir)
    for (const file of ['blueprint.yaml', 'seed.yaml', 'project.yaml']) {
      expect(after[file]).toBe(before[file])
    }
    const scenesBefore = Object.keys(before).filter((name) => name.startsWith('scenes/'))
    for (const file of scenesBefore) expect(after[file]).toBe(before[file])
    // 只有 drafts/final.md 与 story_state.yaml 允许变化（外加 history 快照）
    const changed = Object.keys(after).filter((name) => after[name] !== before[name])
    for (const file of changed) {
      expect(file === 'drafts/final.md' || file === 'story_state.yaml' || file.startsWith('history/')).toBe(true)
    }
  })

  it('State Extractor 输出越界（不存在的 K / REL）只产生冲突，不改任何计划', async () => {
    const paths = cloneProject('demo-01')
    const blueprint = loadBlueprint(paths)
    const state = storyStateOf(paths)
    const before = JSON.stringify(blueprint)
    const extraction = parseExtraction(
      [
        'knowledge_reveals:',
        '  - knowledge_ref: K042',
        '    scene_id: scene-003',
        '    revealed_to: [CH_WOMAN]',
        '    evidence: 不存在的知识',
        'relationship_changes:',
        '  - relationship_ref: REL_GHOST',
        '    scene_id: scene-005',
        '    from_state: together',
        '    to_state: separated',
        '    evidence: 不存在的关系',
        '',
      ].join('\n'),
    )
    const comparison = compareExtraction(extraction, blueprint, state, { sourceRef: 'drafts/final.md', conflictOffset: 0 })
    expect(comparison.conflicts).toHaveLength(2)
    expect(comparison.occurred).toEqual([])
    const applied = applyOccurredToState(state, comparison.occurred, comparison.conflicts, loadScenes(paths))
    expect(applied.state.occurred).toEqual(state.occurred)
    expect(applied.state.knowledge_state).toEqual(state.knowledge_state)
    expect(JSON.stringify(loadBlueprint(paths))).toBe(before)
  })

  it('demo-02 的"窄于计划"只写低危日志，不写冲突、不改计划揭示范围', async () => {
    const paths = cloneProject('demo-02')
    const planBefore = loadBlueprint(paths).key_knowledge.find((item) => item.id === 'K001')!.reveal_to
    const result = await runGate3({ paths, provider: provider(), confirm: true })
    expect(result.lowSeverity.map((entry) => entry.code)).toContain('revealed_to_narrower_than_plan')
    expect(result.conflicts).toEqual([])
    expect(loadBlueprint(paths).key_knowledge.find((item) => item.id === 'K001')!.reveal_to).toEqual(planBefore)
  })
})

describe('P2：可以提案，不能伪装', () => {
  it('Story Seed 与 Proposal 都保留人类来源；harness 不写进 seed/proposals', async () => {
    const paths = cloneProject('demo-01')
    const seedBefore = readTextFile(paths.seed)
    const proposalsBefore = readTextFile(paths.proposals)
    await runGate3({ paths, provider: provider(), confirm: true })
    expect(readTextFile(paths.seed)).toBe(seedBefore)
    expect(readTextFile(paths.proposals)).toBe(proposalsBefore)
    expect(loadSeed(paths).story_seed.raw_seed_anchor_ids.length).toBeGreaterThan(0)
  })

  it('story_state 中的 OCCURRED 全部带 source_ref（来自 Scene / final.md），不是 LLM 的自由文本', async () => {
    const paths = cloneProject('demo-01')
    const result = await runGate3({ paths, provider: provider(), confirm: true })
    expect(result.occurred.length).toBeGreaterThan(0)
    for (const occurred of result.occurred) {
      // OCCURRED 必须指向真实文件/场景，而不是 LLM 的自由文本
      expect(occurred.source_ref.length).toBeGreaterThan(0)
      expect(['final_text', 'draft']).toContain(occurred.source)
      expect(occurred.scene_id).toMatch(/^scene-\d{3}$/u)
      expect(occurred.source_ref).toBe('drafts/final.md')
      expect(occurred.status).toBe('OCCURRED')
    }
    const open = result.state.state_rebuild_conflicts
    expect(open).toEqual([])
  })

  it('Gate 3 写入的 state 通过 Story State Schema 校验（不产生非法字段）', async () => {
    const paths = cloneProject('demo-01')
    const result = await runGate3({ paths, provider: provider(), confirm: true })
    expect(() => validateStoryState(result.state)).not.toThrow()
    const stored = storyStateOf(paths)
    expect(stored.confirmed_scenes).toEqual(['scene-001', 'scene-002', 'scene-003', 'scene-004', 'scene-005'])
  })
})

describe('P3：Context Compiler 必须可审计', () => {
  it('final.md 的每一段都能在某个 Scene draft 中找到出处', () => {
    const paths = cloneProject('demo-01')
    const assembled = assembleFinalFromProject(paths)
    const drafts = loadScenes(paths).map((scene) =>
      readTextFile(join(paths.draftsDir, `${scene.scene_id}.md`)).trim(),
    )
    expect(drafts).toHaveLength(5)
    for (const draft of drafts) {
      // 每个 Scene 的 draft 原文完整出现在 final.md 中（不被改写、不被合并）
      expect(assembled.finalText).toContain(draft)
    }
    // 出现顺序与 Scene order 一致
    const positions = drafts.map((draft) => assembled.finalText.indexOf(draft))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(assembled.finalText.indexOf(drafts[0]!)).toBe(0)
  })

  it('Context Compiler 的 manifest 仍在且可追溯（Gate 3 不破坏审计链）', async () => {
    const paths = cloneProject('demo-01')
    expect(existsSync(paths.contextManifestReport)).toBe(true)
    const manifest = readTextFile(paths.contextManifestReport)
    await runGate3({ paths, provider: provider(), confirm: true })
    expect(readTextFile(paths.contextManifestReport)).toBe(manifest)
    expect(manifest).toContain('# Last compiled scene: scene-')
    expect(manifest).toContain('OQ-49')
  })

  it('Scene Intent 与 final.md 段数一致（不合并、不丢弃场景）', async () => {
    const paths = cloneProject('demo-01')
    const scenes = loadScenes(paths)
    const result = await runGate3({ paths, provider: provider(), confirm: true })
    expect(result.sceneCount).toBe(scenes.length)
    expect(result.confirmedScenes).toEqual(scenes.map((scene) => scene.scene_id))
    // final.md 的段落数 ≥ 场景数：场景之间用空行分隔，场景内部也可能有空行
    expect(result.finalText).toContain('\n\n')
    expect(loadProjectConfig(paths).project.id).toBe('demo-01')
    const drafts = scenes.map((scene) => readTextFile(join(paths.draftsDir, `${scene.scene_id}.md`)).trim())
    expect(result.finalText).toBe(drafts.join('\n\n'))
  })
})

describe('P4：推演不会产生事实', () => {
  it('候选先比对、后写入：冲突条目不进入 occurred', () => {
    const paths = cloneProject('demo-01')
    const blueprint = loadBlueprint(paths)
    const state = storyStateOf(paths)
    const extraction = parseExtraction(
      'knowledge_reveals:\n  - knowledge_ref: K001\n    scene_id: scene-003\n    revealed_to: [CH_MAN]\n    evidence: 无交集\nrelationship_changes: []\n',
    )
    const comparison = compareExtraction(extraction, blueprint, state, { sourceRef: 'x', conflictOffset: 0 })
    expect(comparison.occurred).toEqual([])
    const applied = applyOccurredToState(state, comparison.occurred, comparison.conflicts, loadScenes(paths))
    expect(applied.state.occurred).toHaveLength(state.occurred.length)
    expect(applied.state.state_rebuild_conflicts.length).toBe(state.state_rebuild_conflicts.length + 1)
  })

  it('Gate 3 重跑是幂等的：occurred 使用确定性 ID，不会重复累积', async () => {
    const paths = cloneProject('demo-01')
    const first = await runGate3({ paths, provider: provider(), confirm: true })
    const firstIds = first.occurred.map((entry) => entry.id)
    const second = await runGate3({ paths, provider: provider(), confirm: true })
    expect(second.occurred.map((entry) => entry.id)).toEqual(firstIds)
    expect(storyStateOf(paths).occurred.map((entry) => entry.id)).toEqual(firstIds)
  })

  it('未确认不会写 final.md，也不会写 story_state（Gate 3 是显式的）', async () => {
    const paths = cloneProject('demo-02')
    const finalPath = join(paths.draftsDir, 'final.md')
    const hadFinal = existsSync(finalPath)
    const stateBefore = readTextFile(paths.storyState)
    await expect(runGate3({ paths, provider: provider(), confirm: false })).rejects.toThrow(/--confirm/u)
    expect(existsSync(finalPath)).toBe(hadFinal)
    expect(readTextFile(paths.storyState)).toBe(stateBefore)
  })

  it('dry-run 不落盘，但结论文本与真实运行一致', async () => {
    const paths = cloneProject('demo-01')
    const stateBefore = readTextFile(paths.storyState)
    const dry = await runGate3({ paths, provider: provider(), confirm: true, dryRun: true })
    expect(dry.written).toBe(false)
    expect(readTextFile(paths.storyState)).toBe(stateBefore)
    const real = await runGate3({ paths, provider: provider(), confirm: true })
    expect(dry.finalText).toBe(real.finalText)
    expect(dry.occurred.map((entry) => entry.id)).toEqual(real.occurred.map((entry) => entry.id))
  })

  it('缺少 Draft 时 Gate 3 抛错（不让 final.md 悄悄少一场）', async () => {
    const paths = cloneProject('demo-01')
    const draft = join(paths.draftsDir, 'scene-004.md')
    writeFileSync(draft, '   \n', 'utf8')
    await expect(runGate3({ paths, provider: provider(), confirm: true })).rejects.toThrow(/scene-004/u)
  })

  it('story_state 中的 occurred 与 knowledge_state 投影一致（OQ-06）', async () => {
    const paths = cloneProject('demo-01')
    const result = await runGate3({ paths, provider: provider(), confirm: true })
    const state = result.state
    for (const occurred of state.occurred) {
      if (occurred.type !== 'knowledge_reveal') continue
      const ref = (occurred.payload as { knowledge_ref: string }).knowledge_ref
      const projection = state.knowledge_state.find((entry) => entry.blueprint_ref === ref)
      expect(projection).toBeDefined()
      expect(projection!.occurred_reveal).toBe(true)
    }
    // 反向也不会出现"投影说有、occurred 里没有"的孤儿
    for (const entry of state.knowledge_state) {
      if (!entry.occurred_reveal) continue
      expect(
        state.occurred.some(
          (item) => (item.payload as { knowledge_ref?: string }).knowledge_ref === entry.blueprint_ref,
        ),
      ).toBe(true)
    }
  })
})

describe('额外：状态文件由 Harness 重写而不是追加（保持单文件最后写入语义）', () => {
  it('连续两次 Gate 3 后 story_state 内容稳定', async () => {
    const paths = cloneProject('demo-01')
    await runGate3({ paths, provider: provider(), confirm: true })
    const once = readTextFile(paths.storyState)
    await runGate3({ paths, provider: provider(), confirm: true })
    expect(readTextFile(paths.storyState)).toBe(once)
  })

  it('手工制造 from_state 不一致 → 冲突，且 state 不被改动', () => {
    const paths = cloneProject('demo-01')
    const state = storyStateOf(paths)
    writeYamlFile(paths.storyState, state, { headerComments: ['p4'] })
    const extraction = parseExtraction(
      'knowledge_reveals: []\nrelationship_changes:\n  - relationship_ref: REL_WOMAN_MAN\n    scene_id: scene-005\n    from_state: 陌生人\n    to_state: separated\n    evidence: 不一致\n',
    )
    const comparison = compareExtraction(extraction, loadBlueprint(paths), state, { sourceRef: 'x', conflictOffset: 0 })
    expect(comparison.conflicts).toHaveLength(1)
    const applied = applyOccurredToState(state, comparison.occurred, comparison.conflicts, loadScenes(paths))
    expect(applied.state.relationship_state).toEqual(state.relationship_state)
  })
})
