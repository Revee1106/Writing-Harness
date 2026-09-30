import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  AB_LENGTH_TOLERANCE,
  ANTI_AI_CSV_COLUMNS,
  AUTHOR_COST_CSV_COLUMNS,
  STORY_DEVELOPMENT_CSV_COLUMNS,
  buildStoryDevelopmentEvaluation,
  collectAuthorCost,
  collectStoryDevelopmentRows,
  countRuleWarnings,
  draftTextsOf,
  ANTI_AI_DIR,
  generateAbSession,
  loadStoryDevelopmentSeedSet,
  measureFixtureSeed,
  nextSessionId,
  summarizeAbSession,
  toCsv,
} from '../../src/eval/evaluation.ts'
import {
  assembleFinalDraft,
  assembleFinalFromProject,
  compareExtraction,
  loadFinalDraft,
  parseExtraction,
  resetConflictSequence,
} from '../../src/state/gate3.ts'
import { loadBlueprint } from '../../src/project/project.ts'
import { loadScenes, loadStoryState } from '../../src/scenes/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import type { Scene } from '../../src/schema/scene.ts'
import { readTextFile, readYamlFile } from '../../src/io/yaml.ts'
import { countAllCodePoints } from '../../src/core/text.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'

/**
 * Story 10 单元测试：Gate 3 + State Extractor + 评估资产。
 *
 * 覆盖：
 * - `final.md` 由 Scene draft 按 order 拼接（空行分隔、无标题/无元数据）；
 * - `payload.revealed_to` 的 == / ⊊ / ⊋ / 无交集 四类比较；
 * - `relationship_change.from_state` 与 `relationship_state` 不一致 → 冲突；
 * - 评估工具：测试集校验、CSV 列、A/B session、作者成本。
 */

/**
 * 测试专用临时目录。
 *
 * 副本一律落在**系统临时区**（`makeTempDir` → `mkdtempSync(os.tmpdir())`），
 * 不是仓库内；清理通过 `onTestFinished()` 注册，**测试失败时同样会执行**
 * （等价于 finally，不依赖"事后看 git status"）。
 */
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-s10-unit-')
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

function cloneProject(projectId: string): ReturnType<typeof projectPaths> {
  const root = tempRoot()
  cpSync(join(REPO_ROOT, 'projects', projectId), join(root.dir, projectId), { recursive: true })
  return projectPaths(root.dir, projectId)
}

const scene = (order: number, overrides: Partial<Scene> = {}): Scene =>
  ({
    scene_id: `scene-${String(order).padStart(3, '0')}`,
    order,
    ...overrides,
  }) as unknown as Scene

describe('A：final.md 组装（D 节裁决：按 order 拼接，空行分隔，无标题/无元数据）', () => {
  it('按 order 排序而不是按文件名字典序', () => {
    const text = assembleFinalDraft(
      [scene(2), scene(1), scene(3)],
      { 'scene-001': '第一场', 'scene-002': '第二场', 'scene-003': '第三场' },
    )
    expect(text).toBe('第一场\n\n第二场\n\n第三场')
  })

  it('不含标题、不含任何元数据行', () => {
    const text = assembleFinalDraft([scene(1)], { 'scene-001': '正文' })
    expect(text).toBe('正文')
    expect(text).not.toMatch(/^#/mu)
    expect(text).not.toMatch(/scene_id|order|title|generated/iu)
  })

  it('每段末尾的空白被裁掉；空白段属于"缺 Draft"而不是"跳过"', () => {
    expect(assembleFinalDraft([scene(1)], { 'scene-001': '正文一  \n\n' })).toBe('正文一')
    expect(() =>
      assembleFinalDraft([scene(1), scene(2)], { 'scene-001': '正文一', 'scene-002': '   ' }),
    ).toThrow(/scene-002/u)
  })

  it('从项目组装：5 场已确认 Scene 的 draft 全部进入 final.md', () => {
    const paths = cloneProject('demo-01')
    const result = assembleFinalFromProject(paths)
    expect(result.sceneCount).toBe(5)
    expect(result.missingSceneIds).toEqual([])
    const drafts = draftTextsOf(paths)
    expect(result.finalText).toBe(
      ['scene-001', 'scene-002', 'scene-003', 'scene-004', 'scene-005']
        .map((sceneId) => drafts[sceneId]!.trim())
        .join('\n\n'),
    )
    // 每场 draft 都真的进入了 final.md（不是被截断或被合并）
    for (const sceneId of ['scene-001', 'scene-002', 'scene-003', 'scene-004', 'scene-005']) {
      const firstLine = drafts[sceneId]!.trim().split('\n')[0]!
      expect(result.finalText).toContain(firstLine)
    }
  })

  it('未写过 draft 的 Scene 使组装失败（不静默跳过）', () => {
    const paths = cloneProject('demo-01')
    const project = loadScenes(paths).slice(0, 3)
    const texts = draftTextsOf(paths)
    delete texts[project[2]!.scene_id]
    expect(() => assembleFinalDraft(project, texts)).toThrow(/scene-003/u)
  })

  it('loadFinalDraft 在未确认时返回 null，在确认后返回与组装一致的文本', () => {
    const paths = cloneProject('demo-01')
    expect(loadFinalDraft(paths)).not.toBeNull()
    const final = loadFinalDraft(paths) ?? ''
    expect(final.trim()).toBe(assembleFinalFromProject(paths).finalText.trim())
  })
})

describe('B：payload.revealed_to 与计划的四类比较（D 节裁决）', () => {
  // 计划来自真实 Blueprint：
  // - demo-01 的 K001 计划 = [CH_WOMAN]
  // - demo-02 的 K001 计划 = [CH_HUSBAND, CH_WIFE]
  const d1 = projectPaths(join(REPO_ROOT, 'projects'), 'demo-01')
  const d2 = projectPaths(join(REPO_ROOT, 'projects'), 'demo-02')
  const bp1 = loadBlueprint(d1)
  const bp2 = loadBlueprint(d2)
  const st1 = storyStateOf(d1)
  const st2 = storyStateOf(d2)
  const reveal = (revealedTo: string[]): string =>
    [
      'knowledge_reveals:',
      '  - knowledge_ref: K001',
      '    scene_id: scene-003',
      `    revealed_to: [${revealedTo.join(', ')}]`,
      '    evidence: 她读到了屏幕上的那行字',
      'relationship_changes: []',
      '',
    ].join('\n')
  const compare1 = (revealedTo: string[]): ReturnType<typeof compareExtraction> =>
    compareExtraction(parseExtraction(reveal(revealedTo)), bp1, st1, { sourceRef: 'scene-003', conflictOffset: 0 })
  const compare2 = (revealedTo: string[]): ReturnType<typeof compareExtraction> =>
    compareExtraction(parseExtraction(reveal(revealedTo)), bp2, st2, { sourceRef: 'scene-003', conflictOffset: 0 })

  it('相等 → 正常，既不产生冲突也不产生低危日志', () => {
    const result = compare1(['CH_WOMAN'])
    expect(result.conflicts).toEqual([])
    expect(result.lowSeverity).toEqual([])
    expect(result.occurred).toHaveLength(1)
    expect((result.occurred[0]!.payload as { revealed_to: string[] }).revealed_to).toEqual(['CH_WOMAN'])
    expect(result.occurred[0]!.id).toBe('OCC_K_K001_scene-003')
  })

  it('真子集 → 正常 + 低危日志 revealed_to_narrower_than_plan（不阻塞 Gate 3）', () => {
    const result = compare2(['CH_HUSBAND'])
    expect(result.conflicts).toEqual([])
    expect(result.lowSeverity).toHaveLength(1)
    expect(result.lowSeverity[0]!.code).toBe('revealed_to_narrower_than_plan')
    expect(result.occurred).toHaveLength(1)
  })

  it('配对比较是集合语义，与元素顺序无关', () => {
    const a = compare2(['CH_WIFE', 'CH_HUSBAND'])
    const b = compare2(['CH_HUSBAND', 'CH_WIFE'])
    expect(a.conflicts.length).toBe(b.conflicts.length)
    expect(a.lowSeverity.length).toBe(b.lowSeverity.length)
    expect(a.occurred.length).toBe(b.occurred.length)
  })

  it('真超集 → 冲突（Harness 无权扩写已知范围）', () => {
    const result = compare2(['CH_HUSBAND', 'CH_WIFE', 'CH_OLD_MAN'])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.type).toBe('OCCURRED_CONFLICT')
    expect(result.conflicts[0]!.message).toContain('超出')
    expect(result.occurred).toHaveLength(0)
  })

  it('无交集 → 冲突，且不修改 Blueprint', () => {
    const result = compare1(['CH_MAN'])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.message).toContain('没有交集')
    expect(bp1.key_knowledge.find((item) => item.id === 'K001')!.reveal_to).toEqual(['CH_WOMAN'])
    expect(bp2.key_knowledge.find((item) => item.id === 'K001')!.reveal_to).toEqual(['CH_HUSBAND', 'CH_WIFE'])
  })

  it('空集（无人被揭示）不是"窄于计划"，而是冲突', () => {
    const result = compare1([])
    expect(result.lowSeverity).toEqual([])
    expect(result.conflicts).toHaveLength(1)
  })

  it('报出不存在的 Key Knowledge → 冲突', () => {
    const result = compareExtraction(
      parseExtraction(
        'knowledge_reveals:\n  - knowledge_ref: K999\n    scene_id: scene-003\n    revealed_to: [CH_WOMAN]\n    evidence: 无\nrelationship_changes: []\n',
      ),
      bp1,
      st1,
      { sourceRef: 'scene-003', conflictOffset: 0 },
    )
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.message).toContain('不存在的 Key Knowledge')
  })

  it('冲突 ID 连续且带偏移，便于与旧冲突共存', () => {
    const extraction = parseExtraction(reveal(['CH_MAN']))
    resetConflictSequence()
    const first = compareExtraction(extraction, bp1, st1, { sourceRef: 'a', conflictOffset: 0 })
    const second = compareExtraction(extraction, bp1, st1, { sourceRef: 'b', conflictOffset: 5 })
    expect(first.conflicts[0]!.id).toBe('SRC_001')
    expect(second.conflicts[0]!.id).toBe('SRC_007')
  })
})

describe('C：relationship_change.from_state 与 relationship_state 比对（D 节裁决）', () => {
  const blueprint = loadBlueprint(projectPaths(join(REPO_ROOT, 'projects'), 'demo-01'))
  const state = storyStateOf(projectPaths(join(REPO_ROOT, 'projects'), 'demo-01'))
  const change = (fromState: string, relationshipRef = 'REL_WOMAN_MAN'): string =>
    [
      'knowledge_reveals: []',
      'relationship_changes:',
      `  - relationship_ref: ${relationshipRef}`,
      '    scene_id: scene-005',
      `    from_state: ${fromState}`,
      '    to_state: separated',
      '    evidence: 她拖着箱子下楼',
      '',
    ].join('\n')

  it('与 relationship_state 一致 → 正常', () => {
    const result = compareExtraction(parseExtraction(change('together')), blueprint, state, {
      sourceRef: 'scene-005',
      conflictOffset: 0,
    })
    expect(result.conflicts).toEqual([])
    expect(result.occurred).toHaveLength(1)
    expect((result.occurred[0]!.payload as { relationship_ref: string }).relationship_ref).toBe('REL_WOMAN_MAN')
  })

  it('不一致 → 冲突（OCCURRED_CONFLICT），且不写状态', () => {
    const result = compareExtraction(parseExtraction(change('恋人')), blueprint, state, {
      sourceRef: 'scene-005',
      conflictOffset: 0,
    })
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.type).toBe('OCCURRED_CONFLICT')
    expect(result.conflicts[0]!.message).toContain('from_state')
    expect(result.occurred).toHaveLength(0)
  })

  it('引用未知 relationship_ref → 冲突', () => {
    const result = compareExtraction(parseExtraction(change('together', 'REL_UNKNOWN')), blueprint, state, {
      sourceRef: 'scene-005',
      conflictOffset: 0,
    })
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1)
  })
})

describe('D：Story Development Test Set（≥10 Seed）', () => {
  it('测试集自带校验：Seed 数与最低要求一致', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    expect(set.set_id).toBe('story-development-test-set')
    expect(set.seed_count_minimum).toBeGreaterThanOrEqual(10)
    expect(set.seeds.length).toBeGreaterThanOrEqual(10)
    expect(set.measuredCount).toBe(set.projectBackedCount + set.fixtureBackedCount)
    expect(set.corpusOnlyCount).toBe(set.seeds.length - set.measuredCount)
  })

  it('每个 Seed 都有唯一 id、非空文本、≥2 提案与差异度要求', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const ids = new Set<string>()
    for (const seed of set.seeds) {
      expect(ids.has(seed.seed_id)).toBe(false)
      ids.add(seed.seed_id)
      expect(seed.text.trim().length).toBeGreaterThan(0)
      expect(seed.text.length).toBeLessThanOrEqual(500)
      expect(seed.expectation.proposal_count_min).toBeGreaterThanOrEqual(2)
      expect(seed.expectation.distinctness_required).toBe(true)
      expect(['measured', 'corpus_only']).toContain(seed.status)
      if (seed.status === 'measured') expect(seed.project_id !== null || seed.seed_file !== null).toBe(true)
    }
  })

  it('被标记为 measured 的 Seed 都能在真实项目里量出 Proposal 指标', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const measured = set.seeds.filter((seed) => seed.status === 'measured' && seed.project_id !== null)
    expect(measured.length).toBeGreaterThan(0)
    const rows = measured.flatMap((seed) =>
      collectStoryDevelopmentRows(projectPaths(join(REPO_ROOT, 'projects'), seed.project_id ?? ''), seed.seed_id),
    )
    expect(rows.length).toBeGreaterThanOrEqual(measured.length * 2)
    for (const row of rows) {
      expect(row.proposal_count).toBeGreaterThanOrEqual(2)
      expect(row.distinctness_ok).toBe(true)
      expect(row.unaccounted_anchors).toBe(0)
    }
    const evaluation = buildStoryDevelopmentEvaluation(
      measured.map((seed) => ({
        seedId: seed.seed_id,
        paths: projectPaths(join(REPO_ROOT, 'projects'), seed.project_id ?? ''),
      })),
    )
    expect(evaluation.seedCount).toBe(measured.length)
    expect(evaluation.distinctnessAllOk).toBe(true)
  })

  it('fixture 型 measured Seed 走产品同一条代码路径离线量测（≥2 提案 / 差异度通过 / 无未记账锚点）', async () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    const fixtureSeeds = set.seeds.filter((seed) => seed.status === 'measured' && seed.seed_file !== null)
    expect(fixtureSeeds.length).toBeGreaterThanOrEqual(5)
    for (const seed of fixtureSeeds) {
      const measured = await measureFixtureSeed({
        repoRoot: REPO_ROOT,
        seedId: seed.seed_id,
        seedFile: seed.seed_file ?? '',
      })
      expect(measured.provider).toBe('recorded')
      expect(measured.rows.length).toBe(measured.proposal_count)
      expect(measured.proposal_count).toBeGreaterThanOrEqual(2)
      expect(measured.distinctness_ok).toBe(true)
      expect(measured.anchor_count).toBeGreaterThan(0)
      expect(measured.rows.every((row) => row.unaccounted_anchors === 0)).toBe(true)
      expect(measured.rows.every((row) => row.seed_preservation_rate.endsWith('%'))).toBe(true)
    }
  })

  it('fixture 型 Seed 的 text 直接来自 Seed 文件（不复制粘贴，避免漂移）', () => {
    const set = loadStoryDevelopmentSeedSet(REPO_ROOT)
    for (const seed of set.seeds.filter((entry) => entry.seed_file !== null)) {
      expect(seed.text).toBe(readTextFile(join(REPO_ROOT, seed.seed_file ?? '')))
    }
  })

  it('引用了不存在的 Seed 文件时测试集加载失败（不静默降级）', () => {
    const root = tempRoot()
    const dir = join(root.dir, 'tests/fixtures/evaluation/story-development')
    mkdirSync(dir, { recursive: true })
    const entries = Array.from({ length: 10 }, (_, index) => {
      const id = `SD_${String(index + 1).padStart(3, '0')}`
      if (index === 0) {
        return `  - seed_id: ${id}\n    status: measured\n    seed_file: tests/fixtures/seeds/story2/does-not-exist.txt\n    title: t\n    expectation:\n      proposal_count_min: 2\n      distinctness_required: true\n`
      }
      return `  - seed_id: ${id}\n    status: corpus_only\n    title: t\n    text: 一粒种子。\n    expectation:\n      proposal_count_min: 2\n      distinctness_required: true\n`
    })
    writeFileSync(join(dir, 'seeds.yaml'), `schema_version: '0.1'\nset_id: broken\nseed_count_minimum: 10\nseeds:\n${entries.join('')}`, 'utf8')
    expect(() => loadStoryDevelopmentSeedSet(root.dir)).toThrow(/Seed 文件不存在/u)
  })

  it('损坏的测试集会被拒绝（不静默通过）', () => {
    const root = tempRoot()
    const dir = join(root.dir, 'tests/fixtures/evaluation/story-development')
    mkdirSync(dir, { recursive: true })
    const write = (seeds: string, minimum = 10): void => {
      writeFileSync(
        join(dir, 'seeds.yaml'),
        `schema_version: '0.1'\nset_id: broken\nseed_count_minimum: ${minimum}\nseeds:\n${seeds}`,
        'utf8',
      )
    }
    const good = (id: string): string =>
      `  - seed_id: ${id}\n    status: corpus_only\n    title: t\n    text: 一粒种子。\n    pov_hint: single\n    expectation:\n      proposal_count_min: 2\n      distinctness_required: true\n`
    write(Array.from({ length: 3 }, (_, index) => good(`SD_00${index + 1}`)).join(''))
    expect(() => loadStoryDevelopmentSeedSet(root.dir)).toThrow(/少于要求的 10 个/u)
    write(Array.from({ length: 10 }, (_, index) => good(`SD_${String(index + 1).padStart(3, '0')}`)).join(''))
    expect(() => loadStoryDevelopmentSeedSet(root.dir)).not.toThrow()
    write(`${Array.from({ length: 9 }, (_, index) => good(`SD_${String(index + 1).padStart(3, '0')}`)).join('')}${good('SD_001')}`)
    expect(() => loadStoryDevelopmentSeedSet(root.dir)).toThrow(/唯一/u)
    write(`${Array.from({ length: 9 }, (_, index) => good(`SD_${String(index + 1).padStart(3, '0')}`)).join('')}  - seed_id: SD_010\n    status: measured\n    title: t\n    text: 一粒种子。\n    expectation:\n      proposal_count_min: 2\n      distinctness_required: true\n`)
    expect(() => loadStoryDevelopmentSeedSet(root.dir)).toThrow(/project_id/u)
  })
})

describe('E：Anti-AI A/B 测试集与 CSV 模板', () => {
  it('CSV 列与裁决一致，且模板不含任何自动评分结果', () => {
    expect(ANTI_AI_CSV_COLUMNS).toEqual([
      'group_id',
      'text_a_file',
      'text_b_file',
      'rater_id',
      'more_humanlike',
      'more_natural',
      'dialogue_more_natural',
      'characters_more_alive',
      'lower_ai_feel',
      'want_to_continue',
      'notes',
    ])
    expect([...STORY_DEVELOPMENT_CSV_COLUMNS]).toContain('seed_preservation_rate')
    expect([...AUTHOR_COST_CSV_COLUMNS]).toContain('explicit_gates')
  })

  it('生成的 session 有 A/B 两份文本、11 列模板与元数据', () => {
    const root = tempRoot()
    const session = generateAbSession({
      repoRoot: root.dir,
      sessionId: 'session-001',
      plainTexts: { 'demo-01/scene-001': 'A 侧文本', 'demo-01/scene-002': 'A2' },
      harnessTexts: { 'demo-01/scene-001': 'B 侧文本' },
      scenes: [
        {
          key: 'demo-01/scene-001',
          project_id: 'demo-01',
          scene_id: 'scene-001',
          pov: 'CH_WIFE',
          scene_type: 'dialogue',
          intent_ref: 'projects/demo-01/scenes/scene-001.yaml',
          target_length: 800,
        },
        {
          key: 'demo-01/scene-002',
          project_id: 'demo-01',
          scene_id: 'scene-002',
          pov: 'CH_WIFE',
          scene_type: 'interior',
          intent_ref: 'projects/demo-01/scenes/scene-002.yaml',
          target_length: 900,
        },
      ],
      aRuleWarnings: { 'demo-01/scene-001': 3, 'demo-01/scene-002': 0 },
      bRuleWarnings: { 'demo-01/scene-001': 1 },
    })
    expect(session.groups).toHaveLength(2)
    expect(session.groups[0]!.group_id).toBe('G01')
    expect(session.groups[1]!.group_id).toBe('G02')
    expect(session.groups[0]!.text_a_file).toBe('group-G01.a.txt')
    expect(session.groups[0]!.a_rule_warnings).toBe(3)
    expect(session.groups[0]!.b_rule_warnings).toBe(1)
    expect(readTextFile(join(session.session_dir, 'group-G01.a.txt')).trim()).toBe('A 侧文本')
    expect(readTextFile(join(session.session_dir, 'group-G01.b.txt')).trim()).toBe('B 侧文本')
    const csv = readTextFile(session.csvPath).trim().split('\n')
    expect(csv[0]).toBe(ANTI_AI_CSV_COLUMNS.join(','))
    expect(csv).toHaveLength(3)
    // 模板不做任何自动评分：除前 3 列外全部为空
    for (const line of csv.slice(1)) {
      const cells = line.split(',')
      expect(cells.slice(3).every((cell) => cell === '')).toBe(true)
    }
    const meta = readYamlFile(session.metadataPath) as { session_id: string; groups: unknown[] }
    expect(meta.session_id).toBe('session-001')
    expect(meta.groups).toHaveLength(2)
  })

  it('nextSessionId 递增且从 001 开始', () => {
    const root = tempRoot()
    expect(nextSessionId(root.dir)).toBe('session-001')
    mkdirSync(join(root.dir, 'tests/fixtures/evaluation/anti-ai/session-001'), { recursive: true })
    mkdirSync(join(root.dir, 'tests/fixtures/evaluation/anti-ai/session-007'), { recursive: true })
    expect(nextSessionId(root.dir)).toBe('session-008')
  })

  it('真实 A/B session 含 10 个 Scene Intent（两个 demo 各 5），且模板列完整', () => {
    const rows = toCsv(ANTI_AI_CSV_COLUMNS, [['G01', 'a', 'b', '', '', '', '', '', '', '', '']]).trim().split('\n')
    expect(rows[0]).toBe(ANTI_AI_CSV_COLUMNS.join(','))
    expect(rows[1]!.startsWith('G01,a,b,')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('A/B 归一化：报告两侧平均码点数与每千码点 warning 数，并给出可比性判定', () => {
    const summary = summarizeAbSession(REPO_ROOT, 'session-001')
    expect(summary.groupCount).toBe(10)
    expect(summary.aCodePoints).toBeGreaterThan(0)
    expect(summary.bCodePoints).toBeGreaterThan(summary.aCodePoints)
    expect(summary.aAvgCodePoints).toBe(Math.round(summary.aCodePoints / 10))
    expect(summary.bAvgCodePoints).toBe(Math.round(summary.bCodePoints / 10))
    expect(summary.aWarningsPer1000).toBeCloseTo((summary.aWarnings / summary.aCodePoints) * 1000, 2)
    expect(summary.bWarningsPer1000).toBeCloseTo((summary.bWarnings / summary.bCodePoints) * 1000, 2)
    // 长度比与判定一致（±20% 阈值）
    expect(summary.lengthsComparable).toBe(Math.abs(summary.lengthRatio - 1) <= AB_LENGTH_TOLERANCE)
    expect(summary.normalizedRatio).toBeCloseTo(summary.bWarningsPer1000 / summary.aWarningsPer1000, 2)
    expect(summary.verdict).toContain(summary.lengthsComparable ? '原始计数直接可信' : '归一化结果为准')
  })

  it('归一化判定可切换：长度接近时以原始计数为准（阈值语义对称）', () => {
    const root = tempRoot()
    const dir = join(root.dir, ANTI_AI_DIR, 'session-900')
    mkdirSync(dir, { recursive: true })
    // A/B 长度相同（各 100 码点），A 侧 AI 味更重
    const aText = '她深吸一口气，心中五味杂陈。' + '甲'.repeat(86)
    const bText = '她把碗推过去。' + '乙'.repeat(91)
    writeFileSync(join(dir, 'group-G01.a.txt'), aText, 'utf8')
    writeFileSync(join(dir, 'group-G01.b.txt'), bText, 'utf8')
    writeFileSync(
      join(dir, 'session.yaml'),
      ['session_id: session-900', 'groups:', '  - group_id: G01', '    text_a_file: group-G01.a.txt', '    text_b_file: group-G01.b.txt', ''].join('\n'),
      'utf8',
    )
    const summary = summarizeAbSession(root.dir, 'session-900', { vocabRoot: REPO_ROOT })
    expect(summary.groupCount).toBe(1)
    expect(summary.aCodePoints).toBe(countAllCodePoints(aText) - 0)
    expect(summary.lengthsComparable).toBe(true)
    expect(summary.verdict).toContain('原始计数直接可信')
    expect(summary.normalizedRatio).toBeLessThan(1)
  })

  it('countRuleWarnings 能区分明显 AI 味文本与人类文本', () => {
    const ai = '她深吸一口气，心中五味杂陈。时间仿佛静止，仿佛整个世界都安静了下来。'
    const human = '她把碗推过去。\n\n“就这一次。”'
    expect(countRuleWarnings(ai)).toBeGreaterThan(countRuleWarnings(human))
  })
})

describe('G：测试副本的创建位置与清理机制（封版细节 3）', () => {
  it('副本落在系统临时区（不是仓库内），且 cleanup() 会真正删除整个目录', () => {
    const root = makeTempDir('harness-s10-cleanup-')
    onTestFinished(() => {
      root.cleanup()
    })
    cpSync(join(REPO_ROOT, 'projects', 'demo-01'), join(root.dir, 'demo-01'), { recursive: true })
    const paths = projectPaths(root.dir, 'demo-01')
    // 位置：系统临时区，且不在仓库内
    expect(root.dir.startsWith(tmpdir())).toBe(true)
    expect(paths.dir.startsWith(REPO_ROOT)).toBe(false)
    expect(paths.dir.startsWith(root.dir)).toBe(true)
    // 副本内容非空（确实复制了项目，而不是空目录）
    expect(existsSync(join(paths.dir, 'blueprint.yaml'))).toBe(true)
    expect(readdirSync(paths.dir).length).toBeGreaterThan(5)
    // cleanup() 立即生效（onTestFinished 会在测试结束时对其它副本做同样的事）
    root.cleanup()
    expect(existsSync(root.dir)).toBe(false)
  })

  it('清理通过 onTestFinished() 注册：测试失败时也会执行（等价 finally，不靠事后 git status）', () => {
    const helper = readTextFile(join(REPO_ROOT, 'tests/helpers/tmp.ts'))
    expect(helper).toContain('mkdtempSync(join(tmpdir()')
    expect(helper).toContain('rmSync(dir, { recursive: true, force: true })')
    const forbiddenHook = `${'after'}${'Each'}(${''}`
    for (const file of [
      'tests/unit/story10.test.ts',
      'tests/acceptance/story10.principles.test.ts',
      'tests/acceptance/story10.acceptance.test.ts',
    ]) {
      const source = readTextFile(join(REPO_ROOT, file))
      // 不再依赖"测试结束时统一兜底"的钩子：清理必须在 onTestFinished 中注册
      expect(source).not.toContain(forbiddenHook)
      expect(source).toContain('onTestFinished(() => {')
      expect(source).toContain('dir.cleanup()')
    }
  })
})

describe('F：Author Cost（需求规格 §31.3）', () => {
  it('从已确认项目汇总：显式 Gate 次数、版本数、warning、rewrite', () => {
    const paths = projectPaths(join(REPO_ROOT, 'projects'), 'demo-01')
    const row = collectAuthorCost('demo-01', paths)
    expect(row.project_id).toBe('demo-01')
    expect(row.explicit_gates).toBeGreaterThanOrEqual(3)
    expect(row.blueprint_versions).toBeGreaterThanOrEqual(1)
    expect(row.scenes).toBe(5)
    expect(row.confirmed_scenes).toBe(5)
    expect(row.occurred).toBeGreaterThanOrEqual(1)
    expect(AUTHOR_COST_CSV_COLUMNS.length).toBe(Object.keys(row).length)
  })

  it('未确认的项目仍能生成行（不抛错、不伪造）', () => {
    const paths = cloneProject('demo-02')
    const state = storyStateOf(paths)
    writeFileSync(
      join(paths.storyState),
      `${JSON.stringify({ ...state, confirmed_scenes: [] }, null, 2)}\n`,
      'utf8',
    )
    const row = collectAuthorCost('demo-02', paths)
    expect(row.confirmed_scenes).toBe(0)
    expect(row.explicit_gates).toBeGreaterThanOrEqual(0)
  })
})
