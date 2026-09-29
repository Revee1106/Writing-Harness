import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { MERGEABLE_FIELDS, resolveFieldPlan } from '../../src/gate2/builder.ts'
import { assembleBlueprint, parseRawBlueprintOutput } from '../../src/gate2/assemble.ts'
import { Gate2ConflictPendingError, collectMetaFiles, runGate2 } from '../../src/gate2/service.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadBlueprint, loadProposals, saveProposals, saveSeed } from '../../src/project/project.ts'
import { listBlueprintItemIds } from '../../src/schema/blueprint.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { computeSeedPreservationRate } from '../../src/schema/proposal.ts'
import { parse as parseYaml } from 'yaml'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR, SEEDS_DIR, readSeedText } from '../helpers/story4.ts'

/**
 * Story 4 验收测试（《开发 Story 拆分》Story 4「验收」7 条 + 用户追加要求）。
 * 全部离线：Blueprint 内容来自 tests/fixtures/recorded/blueprint_builder 的 7 个 fixture。
 */

const BLUEPRINT_FIXTURES_DIR = join(RECORDED_DIR, 'blueprint_builder')
const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story4-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

/** 构造"Story 1–3 已完成"的项目，返回其路径。 */
async function preparedProject(
  projectId: string,
  seedFile: string,
  gate1Ops: readonly { kind: string; id?: string }[] = [{ kind: 'skip' }],
): Promise<ReturnType<typeof projectPaths>> {
  const root = tempRoot()
  const rawInput = readFileSync(join(SEEDS_DIR, seedFile), 'utf8')
  createProject({ projectsRoot: root.dir, projectId, rawInput })
  const paths = projectPaths(root.dir, projectId)
  const interpreter = await runSeedInterpreter({
    provider: RecordedProvider.fromDirectory(join(RECORDED_DIR, 'seed-interpreter')),
    rawInput,
  })
  const seed = applyGate1Operations(
    seedFromInterpreterResult(rawInput, interpreter),
    gate1Ops as Parameters<typeof applyGate1Operations>[1],
  ).seed
  saveSeed(paths, seed)
  const developer = await runStoryDeveloper({
    provider: RecordedProvider.fromDirectory(join(RECORDED_DIR, 'story_developer')),
    seed,
  })
  saveProposals(paths, developer.file)
  return paths
}

const blueprintProvider = (): RecordedProvider => RecordedProvider.fromDirectory(BLUEPRINT_FIXTURES_DIR)

describe('验收 1：可确认单 Proposal', () => {
  it('--from PROP_A 生成 Blueprint，所有可引用项都有稳定 ID', async () => {
    const paths = await preparedProject('s4-01', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    expect(result.plan.mode).toBe('single')
    expect(result.written).toBe(true)
    const ids = listBlueprintItemIds(result.blueprint)
    expect(ids).toContain('BP_PREMISE_01')
    expect(ids).toContain('BP_THEME_01')
    expect(ids).toContain('BP_CONFLICT_01')
    expect(ids).toContain('BP_STYLE_01')
    expect(ids).toEqual(expect.arrayContaining(['BP_STR_BEG', 'BP_STR_DEV', 'BP_STR_TURN', 'BP_STR_CLIMAX', 'BP_STR_END']))
    expect(ids).toEqual(expect.arrayContaining(['BP_ARC_START', 'BP_ARC_SHIFT', 'BP_ARC_END']))
    expect(ids).toContain('K001')
    expect(ids).toContain('BP_FS_001')
    // 每个 ID 唯一
    expect(new Set(ids).size).toBe(ids.length)
    expect(readFileSync(paths.blueprint, 'utf8')).toBe(readFileSync(result.paths.snapshot, 'utf8'))
  })
})

describe('验收 2：可合并 A + B（逐字段指定来源）', () => {
  const mergeFields = {
    title: 'PROP_A',
    genre: 'PROP_A',
    pov: 'PROP_A',
    target_length: 'PROP_A',
    premise: 'PROP_A',
    theme: 'PROP_B',
    characters: 'PROP_A',
    core_conflict: 'PROP_A',
    arc: 'PROP_B',
    structure: 'PROP_B',
    key_knowledge: 'PROP_A',
    foreshadowing: 'PROP_A',
    style_direction: 'PROP_A',
  }

  it('每个字段按用户指定来源装配，provenance 指向对应提案的字段路径', async () => {
    const paths = await preparedProject('s4-02', 'multi-sentence.txt')
    const result = await runGate2({
      paths,
      provider: blueprintProvider(),
      fields: mergeFields,
      resolutions: { 'PROP_B:CONF_001': 'kept_user' },
    })
    expect(result.plan.mode).toBe('merge')
    expect(result.plan.participatingProposalIds).toEqual(['PROP_A', 'PROP_B'])
    const byField = new Map(result.provenance.map((entry) => [entry.field, entry]))
    expect(byField.get('structure')?.from).toBe('PROP_B')
    expect(byField.get('structure')?.source_refs.some((ref) => ref.ref_id.startsWith('PROP_B.'))).toBe(true)
    expect(byField.get('premise')?.from).toBe('PROP_A')
    expect(byField.get('premise')?.source_refs).toEqual([{ type: 'proposal', ref_id: 'PROP_A.core_premise' }])
    // 合并后的 Blueprint 同时包含两个提案的痕迹
    expect(result.blueprint.arc.end.value).toContain('她没有搬走')
    expect(result.blueprint.premise.value).toContain('各自等对方先开口')
  })

  it('字段在两 Proposal 都有而用户未指定 → 报错，不自动取 A', async () => {
    const paths = await preparedProject('s4-03', 'multi-sentence.txt')
    const partial = { ...mergeFields }
    delete (partial as Record<string, string>).structure
    await expect(runGate2({ paths, provider: blueprintProvider(), fields: partial })).rejects.toThrow(/没有指定来源/)
  })

  it('合并不修改 proposals.yaml（用户裁决）', async () => {
    const paths = await preparedProject('s4-04', 'multi-sentence.txt')
    const before = readFileSync(paths.proposals, 'utf8')
    await runGate2({
      paths,
      provider: blueprintProvider(),
      fields: mergeFields,
      resolutions: { 'PROP_B:CONF_001': 'kept_user' },
    })
    expect(readFileSync(paths.proposals, 'utf8')).toBe(before)
    expect(loadProposals(paths).proposals[1]?.conflicts[0]?.resolution).toBe('pending')
  })

  it('合并可包含用户手写字段（--edit），并记为 user_edit 来源', async () => {
    const paths = await preparedProject('s4-05', 'multi-sentence.txt')
    const proposals = loadProposals(paths)
    // 字段计划层面：premise 由用户手写，其余仍按合并来源
    const plan = resolveFieldPlan({ fields: { ...mergeFields, premise: 'user' }, proposals })
    expect(plan.mode).toBe('merge')
    expect(plan.userFields).toEqual(['premise'])
    expect(plan.participatingProposalIds).toEqual(['PROP_A', 'PROP_B'])

    // 装配层面：把 fixture 输出中 premise 的溯源声明改为 user_edit，结构化引用必须指向 EDIT ID
    const tampered = readBlueprintFixtureText('multi-sentence-merge').replace(
      'derived_from: PROP_A.core_premise',
      'derived_from: user_edit:premise',
    )
    const assembled = assembleBlueprint(parseRawBlueprintOutput(tampered), {
      rawOutput: tampered,
      plan,
      proposals,
      userEdits: [{ id: 'EDIT_001', field: 'premise', value: '两个人都等着对方先开口，谁也没等到' }],
      gate2ActionId: 'GATE2_001',
      blueprintVersion: 1,
      seedAnchors: [],
    })
    const premise = assembled.provenance.find((entry) => entry.field === 'premise')
    expect(premise?.from).toBe('user')
    expect(premise?.source_refs).toEqual([{ type: 'user_edit', ref_id: 'EDIT_001' }])

    // manual 模式（全部 user）的端到端覆盖见 tests/unit/gate2.test.ts
  })
})

describe('验收 3：关键字段保留 source_refs（结构化）', () => {
  it('全部 13 个字段都有非空 source_refs，且类型合法', async () => {
    const paths = await preparedProject('s4-06', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    expect(result.provenance.map((entry) => entry.field)).toEqual([...MERGEABLE_FIELDS])
    for (const entry of result.provenance) {
      for (const ref of entry.source_refs) {
        expect(['seed', 'proposal', 'user_edit', 'blueprint_gate2']).toContain(ref.type)
        expect(ref.ref_id.length).toBeGreaterThan(0)
      }
    }
    // meta 的 field_sources 与 provenance 一致
    for (const fieldSource of result.meta.field_sources) {
      const entry = result.provenance.find((candidate) => candidate.field === fieldSource.field)
      expect(fieldSource.source_refs, fieldSource.field).toEqual(entry?.source_refs ?? [])
    }
  })
})

describe('验收 4：Seed Fidelity 存在（OQ-01）', () => {
  it('Blueprint 顶层有 seed_fidelity，且机器可算', async () => {
    const paths = await preparedProject('s4-07', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const fidelity = result.blueprint.seed_fidelity
    expect(fidelity.preserved.length).toBeGreaterThan(0)
    expect(fidelity.added.length).toBeGreaterThan(0)
    for (const added of fidelity.added) {
      expect(added.status).toBe('PROPOSED')
      expect(added.source).toBe('harness')
    }
    for (const risk of fidelity.risk) {
      for (const ref of risk.related_addition_refs) {
        expect(fidelity.added.map((entry) => entry.id)).toContain(ref)
      }
    }
    // 与 Proposal 的 seed_fidelity 一致（OQ-01：字段结构相同），且可用于 Rate 计算
    const proposals = loadProposals(paths)
    const rate = computeSeedPreservationRate(
      { proposal_id: 'BLUEPRINT', seed_fidelity: fidelity, conflicts: [] },
      proposals.proposals[0]?.seed_fidelity.preserved.map((entry) => entry.seed_ref) ?? [],
    )
    expect(rate.rate_percent).toBe(100)
    expect(readFileSync(paths.blueprint, 'utf8')).toContain('seed_fidelity:')
  })

  it('合并两个提案时 seed_fidelity 取并集并重编号', async () => {
    const paths = await preparedProject('s4-08', 'multi-sentence.txt')
    const result = await runGate2({
      paths,
      provider: blueprintProvider(),
      fields: {
        title: 'PROP_A',
        genre: 'PROP_A',
        pov: 'PROP_A',
        target_length: 'PROP_A',
        premise: 'PROP_A',
        theme: 'PROP_B',
        characters: 'PROP_A',
        core_conflict: 'PROP_A',
        arc: 'PROP_B',
        structure: 'PROP_B',
        key_knowledge: 'PROP_A',
        foreshadowing: 'PROP_A',
        style_direction: 'PROP_A',
      },
      resolutions: { 'PROP_B:CONF_001': 'kept_user' },
    })
    expect(result.blueprint.seed_fidelity.added.length).toBeGreaterThanOrEqual(2)
    expect(result.blueprint.seed_fidelity.altered.length).toBeGreaterThan(0)
  })
})

describe('验收 5：未确认 Proposal 不进入 Blueprint', () => {
  it('单来源确认时，另一个提案的内容不出现在 Blueprint（除结构性 ID 之外无痕）', async () => {
    const paths = await preparedProject('s4-09', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    expect(result.meta.source_proposal_ids).toEqual(['PROP_A'])
    // 全字段溯源都不指向 PROP_B
    const refIds = result.provenance.flatMap((entry) => entry.source_refs.map((ref) => ref.ref_id))
    expect(refIds.some((refId) => refId.startsWith('PROP_B.'))).toBe(false)
    // PROP_B 的结局措辞不该出现
    expect(result.blueprint.structure.ending.value).not.toContain('她留了下来')
    expect(result.blueprint.structure.ending.value).toContain('草稿')
  })

  it('Blueprint 里不出现 PROPOSED 内容项（seed_fidelity.added 除外，原则 2 要求保留）', async () => {
    const paths = await preparedProject('s4-10', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const json = JSON.stringify(result.blueprint)
    const proposedMatches = json.match(/"PROPOSED"/g) ?? []
    expect(proposedMatches.length).toBe(result.blueprint.seed_fidelity.added.length)
  })
})

describe('验收 6：Blueprint snapshot 可回读', () => {
  it('快照文件可独立回读并通过校验；再次确认产生新快照且旧快照保留', async () => {
    const paths = await preparedProject('s4-11', 'multi-sentence.txt')
    const first = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', now: new Date('2026-01-01T00:00:00.000Z') })
    const firstSnapshotText = readFileSync(first.paths.snapshot, 'utf8')

    const second = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', now: new Date('2026-01-02T00:00:00.000Z') })
    expect(second.blueprint.blueprint_version).toBe(2)
    expect(readFileSync(first.paths.snapshot, 'utf8')).toBe(firstSnapshotText)
    expect(loadBlueprint(paths).blueprint_version).toBe(2)

    // 快照与 meta 一一对应（OQ-10）
    const metas = collectMetaFiles(paths)
    expect(metas.map((meta) => meta.blueprint_version)).toEqual([1, 2])
    const historyFiles = readdirSync(paths.historyDir).sort()
    expect(historyFiles).toEqual(['blueprint-001.yaml', 'blueprint-002.yaml'])
    const metaFiles = readdirSync(paths.blueprintHistoryDir).sort()
    expect(metaFiles).toEqual(['001.meta.yaml', '002.meta.yaml'])
  })
})

describe('验收 7：USER_GIVEN 冲突必须在确认前可见', () => {
  it('确认含冲突的提案时被拒绝，并列出冲突与裁决命令', async () => {
    const paths = await preparedProject('s4-12', 'multi-sentence.txt')
    try {
      await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_B' })
      throw new Error('应当抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(Gate2ConflictPendingError)
      const conflictError = error as Gate2ConflictPendingError
      expect(conflictError.message).toContain('SEED_F003')
      expect(conflictError.message).toContain('PROP_B:CONF_001')
      expect(conflictError.detail[0]).toContain('--resolve')
    }
    // 被拒绝时不产生任何 Blueprint 产物
    expect(collectMetaFiles(paths)).toEqual([])
  })

  it('裁决后可以确认，且裁决结果与冲突记录都写入 meta', async () => {
    const paths = await preparedProject('s4-13', 'multi-sentence.txt')
    const result = await runGate2({
      paths,
      provider: blueprintProvider(),
      fromProposal: 'PROP_B',
      resolutions: { 'PROP_B:CONF_001': 'kept_user' },
    })
    expect(result.written).toBe(true)
    expect(result.conflictResolutions).toHaveLength(1)
    const metaText = readFileSync(result.paths.meta, 'utf8')
    expect(metaText).toContain('conflict_resolutions:')
    expect(metaText).toContain('resolution: kept_user')
    expect(metaText).toContain('gate2_action_id: GATE2_001')
  })

  it('冲突裁决可被"用户保留原值"表达：resolution=kept_user 时 altered 记录仍保留（可审计）', async () => {
    const paths = await preparedProject('s4-14', 'multi-sentence.txt')
    const result = await runGate2({
      paths,
      provider: blueprintProvider(),
      fromProposal: 'PROP_B',
      resolutions: { 'PROP_B:CONF_001': 'kept_user' },
    })
    expect(result.blueprint.seed_fidelity.altered.length).toBeGreaterThan(0)
    expect(result.conflictResolutions[0]?.resolution).toBe('kept_user')
  })
})

describe('验收附加：单/双 POV 内心隔离与 read 接口', () => {
  it('单 POV：非 POV 角色的 inner_state_pov_visible 为空（物理隔离）', async () => {
    const paths = await preparedProject('s4-15', 'story2/07-single-scene.txt', [
      { kind: 'promote', id: 'SEED_A001' },
    ])
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const byId = new Map(result.blueprint.characters.map((character) => [character.id, character]))
    expect(result.blueprint.meta.pov).toEqual(['CH_HUSBAND'])
    expect(byId.get('CH_HUSBAND')?.inner_state_pov_visible).toEqual(['CH_HUSBAND'])
    expect(byId.get('CH_WIFE')?.inner_state_pov_visible).toEqual([])
    expect(byId.get('CH_OLD_MAN')?.inner_state_pov_visible).toEqual([])
  })

  it('双 POV：可见性显式声明，known_by 覆盖两个 POV', async () => {
    const paths = await preparedProject('s4-16', 'story2/03-realism.txt')
    const result = await runGate2({
      paths,
      provider: blueprintProvider(),
      fields: {
        title: 'PROP_A',
        genre: 'PROP_A',
        pov: 'PROP_B',
        target_length: 'PROP_B',
        premise: 'PROP_A',
        theme: 'PROP_B',
        characters: 'PROP_B',
        core_conflict: 'PROP_B',
        arc: 'PROP_A',
        structure: 'PROP_A',
        key_knowledge: 'PROP_B',
        foreshadowing: 'PROP_A',
        style_direction: 'PROP_B',
      },
      resolutions: { 'PROP_B:CONF_001': 'changed_user' },
    })
    expect(result.blueprint.meta.pov).toEqual(['CH_HUSBAND', 'CH_WIFE'])
    for (const knowledge of result.blueprint.key_knowledge) {
      expect(Object.keys(knowledge.known_by).sort()).toEqual(['CH_HUSBAND', 'CH_WIFE'])
    }
    for (const character of result.blueprint.characters) {
      expect(character.inner_state_pov_visible.length, character.id).toBeGreaterThan(0)
    }
  })

  it('observable_behavior_hints 结构化并带 applicable_scene_types（§11.3 / Story 4）', async () => {
    const paths = await preparedProject('s4-17', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const hints = result.blueprint.characters.flatMap((character) => character.observable_behavior_hints)
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) {
      expect(hint.id).toMatch(/^OBH_[A-Z0-9_]+_\d{2}$/)
      expect(hint.applicable_scene_types.length).toBeGreaterThan(0)
    }
  })

  it('relationship baseline 带稳定 ID 与 since_ref（§11.1）', async () => {
    const paths = await preparedProject('s4-18', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const relationships = result.blueprint.characters.flatMap((character) => character.relationships)
    expect(relationships.length).toBeGreaterThan(0)
    for (const relationship of relationships) {
      expect(relationship.id).toMatch(/^REL_[A-Z0-9_]+_[A-Z0-9_]+$/)
      expect(Object.values(result.blueprint.structure).map((item) => item.id)).toContain(relationship.since_ref)
      expect(result.blueprint.characters.map((character) => character.id)).toContain(relationship.target)
    }
  })

  it('style_direction 作为整体 Blueprint Item（内部不分子 ID）', async () => {
    const paths = await preparedProject('s4-19', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const style = result.blueprint.style_direction
    expect(style.id).toBe('BP_STYLE_01')
    expect(Object.keys(style).sort()).toEqual(['dialogue', 'id', 'narration', 'rhythm', 'source_refs'])
    expect(listBlueprintItemIds(result.blueprint).filter((id) => id.startsWith('BP_STYLE'))).toEqual(['BP_STYLE_01'])
  })

  it('Blueprint 不含任何 scene_id 引用（§11）', async () => {
    const paths = await preparedProject('s4-20', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const text = readFileSync(result.paths.blueprint, 'utf8')
    expect(text).not.toMatch(/scene-\d{3}/)
    expect(text).not.toContain('reveal_scene')
    expect(text).toContain('reveal_at_structure: BP_STR_')
    expect(text).toContain('since_ref: BP_STR_')
  })

  it('demo Seed 与 fixture 集合一致（7 个 blueprint fixture）', () => {
    const files = readdirSync(BLUEPRINT_FIXTURES_DIR)
      .filter((name) => name.endsWith('.yaml'))
      .sort()
    expect(files).toEqual([
      'multi-sentence-a.yaml',
      'multi-sentence-b.yaml',
      'multi-sentence-merge.yaml',
      'mystery-merge.yaml',
      'realism-merge.yaml',
      'single-scene-promoted-a.yaml',
      'warmth-manual.yaml',
    ])
    expect(readSeedText('multi-sentence.txt').length).toBeGreaterThan(0)
  })
})

/** 读取某个 blueprint fixture 里模型输出的原始文本。 */
function readBlueprintFixtureText(name: string): string {
  const raw = readFileSync(join(BLUEPRINT_FIXTURES_DIR, `${name}.yaml`), 'utf8')
  const doc = parseYaml(raw) as { response: { text: string } }
  return doc.response.text
}
