import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BLUEPRINT_BUILDER_CONTRACT_ID,
  Gate2PlanError,
  MERGEABLE_FIELDS,
  buildBlueprintBuilderInput,
  parseDerivedFrom,
  resolveFieldPlan,
} from '../../src/gate2/builder.ts'
import { BlueprintBuilderOutputError, assembleBlueprint, mergeSeedFidelity, parseRawBlueprintOutput } from '../../src/gate2/assemble.ts'
import {
  Gate2ConflictPendingError,
  Gate2PreconditionError,
  collectKnownGate2ActionIds,
  collectKnownUserEditIds,
  collectMetaFiles,
  nextBlueprintVersion,
  nextUserEditSequence,
  runGate2,
} from '../../src/gate2/service.ts'
import { gate2ActionId, metaFileName, snapshotFileName, userEditId } from '../../src/schema/gate2-meta.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadBlueprint, loadSeed, saveProposals, saveSeed } from '../../src/project/project.ts'
import { applyGate1Operations, seedFromInterpreterResult } from '../../src/gate1/operations.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { runStoryDeveloper } from '../../src/developer/developer.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { StubProvider } from '../helpers/story2.ts'
import { RECORDED_DIR, SEEDS_DIR, readSeedText } from '../helpers/story4.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'

const BLUEPRINT_FIXTURES_DIR = join(RECORDED_DIR, 'blueprint_builder')
const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-gate2-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

/** 建一个已完成 Story 1–3 的项目（离线 fixture 状态）。 */
async function projectWithProposals(projectId: string, seedFile: string): Promise<ReturnType<typeof projectPaths>> {
  const root = tempRoot()
  const rawInput = readFileSync(join(SEEDS_DIR, seedFile), 'utf8')
  createProject({ projectsRoot: root.dir, projectId, rawInput })
  const paths = projectPaths(root.dir, projectId)
  const interpreter = await runSeedInterpreter({ provider: RecordedProvider.fromDirectory(join(RECORDED_DIR, 'seed-interpreter')), rawInput })
  const seed = applyGate1Operations(seedFromInterpreterResult(rawInput, interpreter), [{ kind: 'skip' }]).seed
  // 把 Gate 1 的结果落盘（模拟 Story 1–3 已完成的真实项目状态）
  saveSeed(paths, seed)
  const developer = await runStoryDeveloper({
    provider: RecordedProvider.fromDirectory(join(RECORDED_DIR, 'story_developer')),
    seed,
  })
  saveProposals(paths, developer.file)
  return paths
}

const blueprintProvider = (): RecordedProvider => RecordedProvider.fromDirectory(BLUEPRINT_FIXTURES_DIR)

describe('Gate 2 字段计划（用户裁决：逐字段指定来源，不自动取 A）', () => {
  const proposals = {
    schema_version: '0.1' as const,
    proposals: [
      { proposal_id: 'PROP_A' },
      { proposal_id: 'PROP_B' },
    ],
  } as unknown as Parameters<typeof resolveFieldPlan>[0]['proposals']

  it('缺少字段来源时报错并逐条列出（不静默取 PROPOSITION A）', () => {
    try {
      resolveFieldPlan({ proposals })
      throw new Error('应当抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(Gate2PlanError)
      const planError = error as Gate2PlanError
      expect(planError.detail.length).toBe(MERGEABLE_FIELDS.length)
      expect(planError.message).toContain('没有指定来源')
    }
  })

  it('--from 提供单来源快捷方式；--field 覆盖个别字段', () => {
    const plan = resolveFieldPlan({ fromProposal: 'PROP_A', fields: { structure: 'PROP_B' }, proposals })
    expect(plan.sources.find((source) => source.field === 'premise')?.from).toBe('PROP_A')
    expect(plan.sources.find((source) => source.field === 'structure')?.from).toBe('PROP_B')
    expect(plan.mode).toBe('merge')
    const allA = resolveFieldPlan({ fromProposal: 'PROP_A', proposals })
    expect(allA.mode).toBe('single')
    expect(allA.participatingProposalIds).toEqual(['PROP_A'])
  })

  it('手改字段自动视为 user 来源，全部 user 时为 manual 模式', () => {
    const fields = Object.fromEntries(MERGEABLE_FIELDS.map((field) => [field, 'user']))
    const plan = resolveFieldPlan({ fields, proposals })
    expect(plan.mode).toBe('manual')
    expect(plan.userFields).toHaveLength(MERGEABLE_FIELDS.length)
    expect(plan.participatingProposalIds).toEqual([])
  })

  it('拒绝未知字段与不存在的提案', () => {
    expect(() => resolveFieldPlan({ fromProposal: 'PROP_Z', proposals })).toThrow(Gate2PlanError)
    expect(() => resolveFieldPlan({ fromProposal: 'PROP_A', fields: { nope: 'PROP_A' }, proposals })).toThrow(/未知字段/)
    expect(() => resolveFieldPlan({ fromProposal: 'PROP_A', fields: { structure: 'PROP_Z' }, proposals })).toThrow(/来源无效/)
  })

  it('derived_from 三种形态可解析，其它形态为 null', () => {
    expect(parseDerivedFrom('PROP_A.core_premise')).toEqual({
      kind: 'proposal',
      proposalId: 'PROP_A',
      fieldPath: 'core_premise',
    })
    expect(parseDerivedFrom('user_edit:ending')).toEqual({ kind: 'user_edit', field: 'ending' })
    expect(parseDerivedFrom('harness')).toEqual({ kind: 'harness' })
    expect(parseDerivedFrom('随便写的')).toBeNull()
    expect(parseDerivedFrom('PROP_A')).toBeNull()
  })

  it('结构化输入只含字段计划 / 参与提案 / 手改 / 冲突裁决（不含 Gate 2 动作 ID）', () => {
    const input = buildBlueprintBuilderInput(proposals, {
      plan: resolveFieldPlan({ fromProposal: 'PROP_A', proposals }),
      userEdits: [],
      conflictResolutions: [],
      gate2ActionId: 'GATE2_001',
    })
    expect(Object.keys(input).sort()).toEqual(['conflict_resolutions', 'field_plan', 'proposals', 'user_edits'])
    expect(JSON.stringify(input)).not.toContain('GATE2_001')
  })
})

describe('Blueprint 装配（稳定 ID + 结构化 source_refs）', () => {
  it('ID 由 Harness 分配：structure/arc/premise/theme/K/BP_FS/OBH/REL 全部稳定', async () => {
    const paths = await projectWithProposals('asm-01', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', dryRun: true })
    const blueprint = result.blueprint
    expect(blueprint.premise.id).toBe('BP_PREMISE_01')
    expect(blueprint.theme.primary.id).toBe('BP_THEME_01')
    expect(blueprint.core_conflict.id).toBe('BP_CONFLICT_01')
    expect(blueprint.style_direction.id).toBe('BP_STYLE_01')
    expect(Object.values(blueprint.structure).map((item) => item.id)).toEqual([
      'BP_STR_BEG',
      'BP_STR_DEV',
      'BP_STR_TURN',
      'BP_STR_CLIMAX',
      'BP_STR_END',
    ])
    expect(blueprint.key_knowledge[0]?.id).toBe('K001')
    expect(blueprint.foreshadowing[0]?.id).toBe('BP_FS_001')
    expect(blueprint.characters[0]?.observable_behavior_hints[0]?.id).toMatch(/^OBH_[A-Z0-9_]+_\d{2}$/)
    expect(blueprint.characters[0]?.relationships[0]?.id).toMatch(/^REL_[A-Z0-9_]+_[A-Z0-9_]+$/)
  })

  it('单 POV 默认 inner_state_pov_visible：POV 角色 [self]、非 POV 角色 []（解读 I-34 + 架构 §21 隔离）', async () => {
    const paths = await projectWithProposals('asm-02', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', dryRun: true })
    const byId = new Map(result.blueprint.characters.map((character) => [character.id, character]))
    expect(byId.get('CH_WOMAN')?.inner_state_pov_visible).toEqual(['CH_WOMAN'])
    expect(byId.get('CH_MAN')?.inner_state_pov_visible).toEqual([])
  })

  it('每个 Blueprint 字段都有非空 source_refs（用户裁决）', async () => {
    const paths = await projectWithProposals('asm-03', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', dryRun: true })
    expect(result.provenance).toHaveLength(MERGEABLE_FIELDS.length)
    for (const entry of result.provenance) {
      expect(entry.source_refs.length, entry.field).toBeGreaterThan(0)
    }
    const premise = result.provenance.find((entry) => entry.field === 'premise')
    expect(premise?.source_refs[0]).toEqual({ type: 'proposal', ref_id: 'PROP_A.core_premise' })
  })

  it('声明了与字段计划不符的来源 → 报错（不静默换源）', async () => {
    const paths = await projectWithProposals('asm-04', 'multi-sentence.txt')
    const seed = loadSeed(paths)
    const fixtureText = readBlueprintFixtureText('multi-sentence-a')
    const tampered = fixtureText.replace('derived_from: PROP_A.core_premise', 'derived_from: PROP_B.core_premise')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', dryRun: true })
    // 用篡改后的输出重建装配上下文
    const raw = parseRawBlueprintOutput(tampered)
    expect(() =>
      assembleBlueprint(raw, {
        rawOutput: tampered,
        plan: result.plan,
        proposals: { schema_version: '0.1', proposals: [] } as never,
        userEdits: [],
        gate2ActionId: 'GATE2_001',
        blueprintVersion: 1,
        seedAnchors: seed.story_seed.raw_seed_anchor_ids.map((id) => ({ id, value: id })),
      }),
    ).toThrow(BlueprintBuilderOutputError)
  })

  it('声明 user_edit 但用户并没有手改该字段 → 报错', async () => {
    const paths = await projectWithProposals('asm-05', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', dryRun: true })
    const tampered = readBlueprintFixtureText('multi-sentence-a').replace(
      'derived_from: PROP_A.core_premise',
      'derived_from: user_edit:premise',
    )
    expect(() =>
      assembleBlueprint(parseRawBlueprintOutput(tampered), {
        rawOutput: tampered,
        plan: result.plan,
        proposals: { schema_version: '0.1', proposals: [] } as never,
        userEdits: [],
        gate2ActionId: 'GATE2_001',
        blueprintVersion: 1,
        seedAnchors: [],
      }),
    ).toThrow(/用户并没有手改该字段/)
  })

  it('双 POV 必须显式 inner_state_pov_visible', async () => {
    const paths = await projectWithProposals('asm-06', 'story2/03-realism.txt')
    // realism-merge 的 fixture 是双 POV 且显式声明 → 正常
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
      dryRun: true,
    })
    expect(result.blueprint.meta.pov).toEqual(['CH_HUSBAND', 'CH_WIFE'])
    for (const character of result.blueprint.characters) {
      expect(character.inner_state_pov_visible.length).toBeGreaterThan(0)
    }
  })

  it('mergeSeedFidelity 合并多提案并重编号 ADD / RISK，引用保持可解析', () => {
    const proposals = {
      schema_version: '0.1',
      proposals: [
        {
          proposal_id: 'PROP_A',
          seed_fidelity: {
            preserved: [{ seed_ref: 'SEED_F001', value_in_proposal: 'a' }],
            altered: [],
            added: [{ id: 'ADD_001', value: 'A 的新增', status: 'PROPOSED', source: 'harness' }],
            risk: [{ id: 'RISK_001', value: 'A 的风险', related_addition_refs: ['ADD_001'] }],
          },
        },
        {
          proposal_id: 'PROP_B',
          seed_fidelity: {
            preserved: [{ seed_ref: 'SEED_F001', value_in_proposal: 'b' }, { seed_ref: 'SEED_F002', value_in_proposal: 'c' }],
            altered: [{ seed_ref: 'SEED_F003', original: 'o', changed_to: 'c' }],
            added: [
              { id: 'ADD_001', value: 'B 的新增一', status: 'PROPOSED', source: 'harness' },
              { id: 'ADD_002', value: 'B 的新增二', status: 'PROPOSED', source: 'harness' },
            ],
            risk: [{ id: 'RISK_001', value: 'B 的风险', related_addition_refs: ['ADD_002'] }],
          },
        },
      ],
    } as unknown as Parameters<typeof mergeSeedFidelity>[0]

    const merged = mergeSeedFidelity(proposals, ['PROP_A', 'PROP_B'], [])
    expect(merged.preserved.map((entry) => entry.seed_ref)).toEqual(['SEED_F001', 'SEED_F002'])
    expect(merged.added.map((entry) => entry.id)).toEqual(['ADD_001', 'ADD_002', 'ADD_003'])
    expect(merged.risk.map((entry) => entry.id)).toEqual(['RISK_001', 'RISK_002'])
    // B 的风险原本引用 B 的 ADD_002 → 合并后应指向 ADD_003
    expect(merged.risk[1]?.related_addition_refs).toEqual(['ADD_003'])
    for (const risk of merged.risk) {
      for (const ref of risk.related_addition_refs) {
        expect(merged.added.map((entry) => entry.id)).toContain(ref)
      }
    }
  })

  it('manual 模式：preserved 来自 Seed 锚点自身，不新增任何内容', () => {
    const proposals = { schema_version: '0.1', proposals: [] } as unknown as Parameters<typeof mergeSeedFidelity>[0]
    const merged = mergeSeedFidelity(proposals, [], [{ id: 'SEED_F001', value: '用户明写的事实' }])
    expect(merged.preserved).toEqual([{ seed_ref: 'SEED_F001', value_in_proposal: '用户明写的事实' }])
    expect(merged.added).toEqual([])
  })
})

describe('Gate 2 服务：版本、快照、元数据、前置条件', () => {
  it('第一次确认写 blueprint.yaml + 快照 + meta，三者一致', async () => {
    const paths = await projectWithProposals('g2-01', 'multi-sentence.txt')
    const result = await runGate2({
      paths,
      provider: blueprintProvider(),
      fromProposal: 'PROP_A',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(result.written).toBe(true)
    expect(result.blueprint.blueprint_version).toBe(1)
    expect(result.meta.gate2_action_id).toBe('GATE2_001')
    expect(result.meta.snapshot).toBe('blueprint-001.yaml')
    expect(loadBlueprint(paths)).toEqual(result.blueprint)
    expect(readFileSync(result.paths.snapshot, 'utf8')).toBe(readFileSync(paths.blueprint, 'utf8'))
    expect(readFileSync(result.paths.meta, 'utf8')).toContain('gate2_action_id: GATE2_001')
  })

  it('再次确认 → blueprint_version +1，快照与 meta 按 NNN 一一对应', async () => {
    const paths = await projectWithProposals('g2-02', 'multi-sentence.txt')
    await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    const second = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A' })
    expect(second.blueprint.blueprint_version).toBe(2)
    expect(second.paths.snapshot.endsWith('blueprint-002.yaml')).toBe(true)
    expect(second.paths.meta.endsWith('002.meta.yaml')).toBe(true)
    const metas = collectMetaFiles(paths)
    expect(metas.map((meta) => meta.blueprint_version)).toEqual([1, 2])
    expect(collectKnownGate2ActionIds(paths)).toEqual(['GATE2_001', 'GATE2_002'])
    // 快照 NNN 与 meta NNN 对应
    for (const meta of metas) {
      expect(meta.snapshot).toBe(snapshotFileName(meta.blueprint_version))
      expect(readFileSync(join(paths.blueprintHistoryDir, metaFileName(meta.blueprint_version)), 'utf8')).toContain(
        gate2ActionId(meta.blueprint_version),
      )
    }
  })

  it('--plan 只读：不写任何文件', async () => {
    const paths = await projectWithProposals('g2-03', 'multi-sentence.txt')
    const result = await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', dryRun: true })
    expect(result.written).toBe(false)
    expect(nextBlueprintVersion(paths)).toBe(1)
    expect(collectMetaFiles(paths)).toEqual([])
  })

  it('前置条件：Gate 1 未完成 / proposals 缺失时明确报错', async () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'g2-empty', rawInput: readSeedText('multi-sentence.txt') })
    const emptyPaths = projectPaths(root.dir, 'g2-empty')
    await expect(runGate2({ paths: emptyPaths, provider: blueprintProvider(), fromProposal: 'PROP_A' })).rejects.toBeInstanceOf(
      Gate2PreconditionError,
    )
    await expect(runGate2({ paths: projectPaths(root.dir, 'nope'), provider: blueprintProvider() })).rejects.toBeInstanceOf(
      Gate2PreconditionError,
    )
  })

  it('user_edit ID 跨版本全局递增，且可被解析集合取回（OQ-38 / I-29）', async () => {
    const paths = await projectWithProposals('g2-04', 'story2/04-warmth.txt')
    const allUser = Object.fromEntries(MERGEABLE_FIELDS.map((field) => [field, 'user']))
    const edits = {
      title: '最后一页的那句话',
      genre: '温情短篇',
      pov: 'CH_GRANDSON',
      target_length: '6000',
      premise: '孙子回到老家，本子最后一页写着奶奶托人代笔的一句话',
      theme: '不识字的人如何把期待写下来',
      characters: '孙子与奶奶两人，奶奶在本子最后一页留下了话',
      core_conflict: '他想告诉奶奶结果，而奶奶已经不在了',
      arc: '从回来看看，到把这句话带回城里',
      structure: '从回家发现本子，到他把本子带回城里',
      key_knowledge: '最后一页不是奶奶亲笔，是邻居代笔',
      foreshadowing: '本子前几页的圈和数字',
      style_direction: '白描、少形容词、对白短',
    }
    const first = await runGate2({ paths, provider: blueprintProvider(), fields: allUser, edits })
    expect(first.plan.mode).toBe('manual')
    expect(first.userEdits[0]?.id).toBe('EDIT_001')
    const second = await runGate2({ paths, provider: blueprintProvider(), fields: allUser, edits })
    expect(second.userEdits[0]?.id).toBe(`EDIT_${String(13 + 1).padStart(3, '0')}`)
    const known = collectKnownUserEditIds(paths)
    expect(known).toContain('EDIT_001')
    expect(known).toContain(userEditId(14))
    // Blueprint 的 user_edit 引用必须能解析回 meta 里的 EDIT ID
    const refs = second.blueprint.premise.source_refs
    expect(refs[0]?.type).toBe('user_edit')
    expect(known).toContain(refs[0]?.ref_id)
  })
})

describe('Gate 2 冲突处理（需求规格 §6.2 / §9.2）', () => {
  it('参与提案存在 pending 冲突时拒绝确认，并逐条给出裁决命令', async () => {
    const paths = await projectWithProposals('g2-conflict', 'multi-sentence.txt')
    try {
      await runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_B' })
      throw new Error('应当抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(Gate2ConflictPendingError)
      const conflictError = error as Gate2ConflictPendingError
      expect(conflictError.message).toContain('PROP_B:CONF_001')
      expect(conflictError.message).toContain('--resolve')
    }
  })

  it('--resolve 语法与取值都被校验', async () => {
    const paths = await projectWithProposals('g2-conflict-2', 'multi-sentence.txt')
    await expect(
      runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_B', resolutions: { CONF_001: 'dropped' } }),
    ).rejects.toThrow(/必须形如 PROP_A:CONF_001/)
    await expect(
      runGate2({
        paths,
        provider: blueprintProvider(),
        fromProposal: 'PROP_B',
        resolutions: { 'PROP_B:CONF_001': 'whatever' },
      }),
    ).rejects.toThrow(/非法/)
    await expect(
      runGate2({ paths, provider: blueprintProvider(), fromProposal: 'PROP_A', resolutions: { 'PROP_B:CONF_001': 'dropped' } }),
    ).rejects.toThrow(/冲突不存在于本次参与的提案中/)
  })

  it('裁决结果写入 meta，且不修改 proposals.yaml（用户裁决）', async () => {
    const paths = await projectWithProposals('g2-conflict-3', 'multi-sentence.txt')
    const before = readFileSync(paths.proposals, 'utf8')
    const result = await runGate2({
      paths,
      provider: blueprintProvider(),
      fromProposal: 'PROP_B',
      resolutions: { 'PROP_B:CONF_001': 'kept_user' },
      dryRun: true,
    })
    expect(result.conflictResolutions).toEqual([
      { id: 'CONF_001', proposal_id: 'PROP_B', seed_ref: 'SEED_F003', resolution: 'kept_user' },
    ])
    expect(readFileSync(paths.proposals, 'utf8')).toBe(before)
  })
})

describe('Gate 2 输出错误处理', () => {
  it('非法 YAML / 缺字段 / 出现 scene_id 都会明确报错', async () => {
    const paths = await projectWithProposals('g2-bad', 'multi-sentence.txt')
    await expect(
      runGate2({ paths, provider: new StubProvider('这不是 YAML: ['), fromProposal: 'PROP_A' }),
    ).rejects.toBeInstanceOf(BlueprintBuilderOutputError)
    await expect(
      runGate2({ paths, provider: new StubProvider('meta:\n  title: x'), fromProposal: 'PROP_A' }),
    ).rejects.toBeInstanceOf(BlueprintBuilderOutputError)
  })

  it('Builder 输出里出现 scene_id 会被 Blueprint 校验拦下（§11）', async () => {
    const paths = await projectWithProposals('g2-bad-2', 'multi-sentence.txt')
    const tampered = readBlueprintFixtureText('multi-sentence-a').replace(
      "value: '她搬走，留下那条没被发出的消息'",
      "value: '她在 scene-004 里搬走'",
    )
    await expect(
      runGate2({ paths, provider: new StubProvider(tampered), fromProposal: 'PROP_A' }),
    ).rejects.toThrow(/scene_id|scene-004/)
  })

  it('contract id / 版本与 fixture 一致', async () => {
    expect(BLUEPRINT_BUILDER_CONTRACT_ID).toBe('blueprint_builder')
    const fixture = readBlueprintFixtureText('multi-sentence-a')
    expect(fixture.length).toBeGreaterThan(0)
  })
})

function readBlueprintFixtureText(name: string): string {
  const raw = readFileSync(join(BLUEPRINT_FIXTURES_DIR, `${name}.yaml`), 'utf8')
  const doc = parseYaml(raw) as { response: { text: string } }
  return doc.response.text
}
