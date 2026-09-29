import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Gate1AlreadyClosedError,
  Gate1OperationError,
  applyGate1Operations,
  describeGate1Operation,
  gate1OperationSchema,
  seedFromInterpreterResult,
  type Gate1Operation,
} from '../../src/gate1/operations.ts'
import { assertGate1StatusTransition, deriveGate1Status, evaluateGate1StatusTransition } from '../../src/gate1/status.ts'
import { Gate1PreconditionError, runGate1 } from '../../src/gate1/service.ts'
import { runSeedInterpreter } from '../../src/interpreter/interpreter.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { createProject, loadSeed, setRawSeedInput } from '../../src/project/project.ts'
import { checkSeedInvariants } from '../../src/schema/seed.ts'
import type { SeedFile } from '../../src/schema/seed.ts'
import { GATE1_OPEN_STATUSES } from '../../src/gate1/status.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_FIXTURES_DIR, recordedProvider, story2SeedPath } from '../helpers/story2.ts'

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-gate1-')
  tempDirs.push(dir)
  return dir
}

async function candidateSeed(rawInput: string): Promise<SeedFile> {
  const interpreter = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
  return seedFromInterpreterResult(rawInput, interpreter)
}

const EMOTION_SEED = readFileSync(story2SeedPath('01-emotion.txt'), 'utf8')

describe('Gate 1 操作契约（需求规格 §5.1 / Story 2「Gate 1 允许」6 种操作）', () => {
  it('操作枚举与 §5.1 的六种操作一一对应', () => {
    const kinds = ['accept_all', 'delete', 'promote', 'demote', 'edit', 'skip']
    expect(gate1OperationSchema.options).toHaveLength(6)
    for (const kind of kinds) {
      const sample: Record<string, unknown> =
        kind === 'delete' || kind === 'promote' || kind === 'demote'
          ? { kind, id: 'SEED_A001' }
          : kind === 'edit'
            ? { kind, id: 'SEED_A001', value: 'x' }
            : { kind }
      expect(gate1OperationSchema.safeParse(sample).success, kind).toBe(true)
    }
  })

  it('拒绝文档未定义的操作与非法 ID', () => {
    expect(gate1OperationSchema.safeParse({ kind: 'rewrite_all' }).success).toBe(false)
    expect(gate1OperationSchema.safeParse({ kind: 'promote', id: '随便写的' }).success).toBe(false)
    expect(gate1OperationSchema.safeParse({ kind: 'edit', id: 'SEED_F001', value: '' }).success).toBe(false)
  })

  it('每个操作都有可读描述（CLI / 汇报共用）', () => {
    for (const kind of ['accept_all', 'skip'] as const) {
      expect(describeGate1Operation({ kind }).length).toBeGreaterThan(0)
    }
    expect(describeGate1Operation({ kind: 'promote', id: 'SEED_A001' })).toContain('user_gate1')
  })
})

describe('Gate 1 六种操作的行为（Story 2）', () => {
  it('accept_all：接受全部 → gate1_status=confirmed，条目与来源不变', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [{ kind: 'accept_all' }])
    expect(result.gate1Status).toBe('confirmed')
    expect(result.seed.story_seed.fixed_by_user).toHaveLength(5)
    expect(result.seed.story_seed.fixed_by_user.every((item) => item.source === 'user' && item.origin === 'raw_seed')).toBe(true)
  })

  it('skip：跳过 → gate1_status=skipped，Interpreter 当前结果继续保留（§5.1）', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [{ kind: 'skip' }])
    expect(result.gate1Status).toBe('skipped')
    expect(result.seed.story_seed.fixed_by_user).toHaveLength(5)
    expect(result.seed.story_seed.open_questions).toHaveLength(2)
  })

  it('delete：删除错误分类，可从任一集合删除', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [
      { kind: 'delete', id: 'SEED_F002' },
      { kind: 'delete', id: 'SEED_A002' },
      { kind: 'delete', id: 'SEED_Q001' },
    ])
    expect(result.gate1Status).toBe('partial')
    expect(result.seed.story_seed.fixed_by_user.map((item) => item.id)).toEqual([
      'SEED_F001',
      'SEED_F003',
      'SEED_F004',
      'SEED_F005',
    ])
    expect(result.seed.story_seed.ambiguous.map((item) => item.id)).toEqual(['SEED_A001'])
    expect(result.seed.story_seed.open_questions.map((item) => item.id)).toEqual(['SEED_Q002'])
  })

  it('promote：ambiguous → fixed_by_user，写入 source=user_gate1 / origin=gate1_confirmation', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [{ kind: 'promote', id: 'SEED_A001' }])
    const promoted = result.seed.story_seed.fixed_by_user.find((item) => item.id === 'SEED_A001')
    expect(promoted).toMatchObject({
      status: 'USER_GIVEN',
      source: 'user_gate1',
      origin: 'gate1_confirmation',
    })
    expect(result.seed.story_seed.ambiguous.map((item) => item.id)).toEqual(['SEED_A002'])
    expect(result.gate1Status).toBe('partial')
  })

  it('demote：fixed_by_user → ambiguous，且不删除历史 anchor 身份（§8.2）', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [{ kind: 'demote', id: 'SEED_F003' }])
    expect(result.seed.story_seed.fixed_by_user.map((item) => item.id)).not.toContain('SEED_F003')
    expect(result.seed.story_seed.ambiguous.map((item) => item.id)).toContain('SEED_F003')
    // 降级后回到 Interpreter 中间态：无 status（OQ-04）
    const demoted = result.seed.story_seed.ambiguous.find((item) => item.id === 'SEED_F003')
    expect(demoted).not.toHaveProperty('status')
    expect(result.seed.story_seed.raw_seed_anchor_ids).toContain('SEED_F003')
  })

  it('edit：编辑条目内容，保留 ID 与来源标记', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [
      { kind: 'edit', id: 'SEED_F005', value: '男方觉得自己每次都被指责小题大做' },
      { kind: 'edit', id: 'SEED_A001', value: '那件小事究竟是什么' },
      { kind: 'edit', id: 'SEED_Q001', value: '两人最终会不会再联系' },
    ])
    expect(result.seed.story_seed.fixed_by_user.find((item) => item.id === 'SEED_F005')).toMatchObject({
      value: '男方觉得自己每次都被指责小题大做',
      source: 'user',
      origin: 'raw_seed',
    })
    expect(result.seed.story_seed.ambiguous.find((item) => item.id === 'SEED_A001')?.value).toBe('那件小事究竟是什么')
    expect(result.seed.story_seed.open_questions.find((item) => item.id === 'SEED_Q001')?.value).toBe('两人最终会不会再联系')
  })
})

describe('raw_seed_anchor_ids 首次冻结后不重算（Story 2 验收）', () => {
  it('candidate seed 立即冻结 anchors，且 origin=raw_seed 与 anchors 一致', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    expect(seed.story_seed.raw_seed_anchor_ids).toEqual([
      'SEED_F001',
      'SEED_F002',
      'SEED_F003',
      'SEED_F004',
      'SEED_F005',
    ])
    expect(checkSeedInvariants(seed.story_seed)).toEqual([])
  })

  it('除 delete 之外的每一种操作，anchors 逐项不变（§8.2）', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const operationSets: Gate1Operation[][] = [
      [{ kind: 'accept_all' }],
      [{ kind: 'skip' }],
      [{ kind: 'promote', id: 'SEED_A001' }],
      [{ kind: 'demote', id: 'SEED_F003' }],
      [{ kind: 'edit', id: 'SEED_F005', value: '改写后的内容' }],
      [
        { kind: 'promote', id: 'SEED_A002' },
        { kind: 'demote', id: 'SEED_F004' },
        { kind: 'edit', id: 'SEED_A001', value: '改过的模糊项' },
      ],
    ]
    for (const operations of operationSets) {
      const result = applyGate1Operations(seed, operations)
      expect(result.anchorsAfter, JSON.stringify(operations)).toEqual(result.anchorsBefore)
      expect(result.anchorsAfter).toEqual(seed.story_seed.raw_seed_anchor_ids)
      expect(checkSeedInvariants(result.seed.story_seed)).toEqual([])
    }
  })

  it('delete 原始锚点会同步移出 anchors（解读 I-18 / OQ-29 第 5 条 / OQ-30）', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [
      { kind: 'delete', id: 'SEED_F001' },
      { kind: 'delete', id: 'SEED_A001' },
    ])
    // SEED_F001 是原始锚点：条目不存在后不允许继续留在分母里
    expect(result.anchorsAfter).toEqual(['SEED_F002', 'SEED_F003', 'SEED_F004', 'SEED_F005'])
    // SEED_A001 本来就不是锚点：删除它不影响分母
    expect(result.seed.story_seed.raw_seed_anchor_ids).not.toContain('SEED_A001')
    expect(checkSeedInvariants(result.seed.story_seed)).toEqual([])
  })

  it('delete 非锚点条目（提升后再删除）不会触碰 anchors', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const result = applyGate1Operations(seed, [
      { kind: 'delete', id: 'SEED_A002' },
      { kind: 'delete', id: 'SEED_Q001' },
    ])
    expect(result.anchorsAfter).toEqual(result.anchorsBefore)
  })

  it('提升后再次提升（同一 ID）不会进入 anchors；原始锚点降级再提升也不改变 anchors', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    const demoteThenPromote = applyGate1Operations(seed, [
      { kind: 'demote', id: 'SEED_F003' },
      { kind: 'promote', id: 'SEED_F003' },
    ])
    expect(demoteThenPromote.seed.story_seed.raw_seed_anchor_ids).toEqual(seed.story_seed.raw_seed_anchor_ids)
    const promoted = demoteThenPromote.seed.story_seed.fixed_by_user.find((item) => item.id === 'SEED_F003')
    expect(promoted?.origin).toBe('gate1_confirmation')
  })
})

describe('Gate 1 操作非法组合与前置条件', () => {
  it('skip / accept_all 必须单独使用', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    expect(() => applyGate1Operations(seed, [{ kind: 'skip' }, { kind: 'delete', id: 'SEED_F001' }])).toThrow(
      /skip 必须单独使用/,
    )
    expect(() => applyGate1Operations(seed, [{ kind: 'accept_all' }, { kind: 'promote', id: 'SEED_A001' }])).toThrow(
      /accept_all 必须单独使用/,
    )
  })

  it('目标不存在或目标集合不匹配时明确报错', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    expect(() => applyGate1Operations(seed, [{ kind: 'delete', id: 'SEED_F009' }])).toThrow(Gate1OperationError)
    expect(() => applyGate1Operations(seed, [{ kind: 'promote', id: 'SEED_F001' }])).toThrow(/必须来自 ambiguous/)
    expect(() => applyGate1Operations(seed, [{ kind: 'demote', id: 'SEED_A001' }])).toThrow(/必须来自 fixed_by_user/)
    expect(() => applyGate1Operations(seed, [{ kind: 'edit', id: 'SEED_Q009', value: 'x' }])).toThrow(/目标不存在/)
  })

  it('空操作列表被拒绝；Gate 1 已结束时禁止重跑（OQ-27）', async () => {
    const seed = await candidateSeed(EMOTION_SEED)
    expect(() => applyGate1Operations(seed, [])).toThrow(/至少需要一个操作/)
    const closed = applyGate1Operations(seed, [{ kind: 'accept_all' }]).seed
    expect(() => applyGate1Operations(closed, [{ kind: 'skip' }])).toThrow(Gate1AlreadyClosedError)
  })
})

describe('gate1_status 迁移（Story 2 验收：pending → confirmed | skipped | partial）', () => {
  it('pending 可以迁移到三个结果状态，且规则 ID 固定', () => {
    expect(evaluateGate1StatusTransition('pending', 'confirmed')).toMatchObject({ ok: true, ruleId: 'G1S-A1' })
    expect(evaluateGate1StatusTransition('pending', 'skipped')).toMatchObject({ ok: true, ruleId: 'G1S-A2' })
    expect(evaluateGate1StatusTransition('pending', 'partial')).toMatchObject({ ok: true, ruleId: 'G1S-A3' })
    expect(GATE1_OPEN_STATUSES).toEqual(['confirmed', 'skipped', 'partial'])
  })

  it('已结束的 Gate 1 不能再次迁移，也不能回到 pending', () => {
    for (const from of GATE1_OPEN_STATUSES) {
      for (const to of [...GATE1_OPEN_STATUSES, 'pending'] as const) {
        const decision = evaluateGate1StatusTransition(from, to)
        expect(decision.ok, `${from} → ${to}`).toBe(false)
        if (!decision.ok) expect(decision.ruleId).toBe('G1S-F1')
      }
    }
    expect(() => assertGate1StatusTransition('pending', 'pending')).toThrow(/不是 Gate 1 的结果状态/)
    expect(() => assertGate1StatusTransition('confirmed', 'partial')).toThrow(/不允许再次迁移/)
  })

  it('由操作推导状态：accept_all→confirmed / skip→skipped / 其余→partial', () => {
    expect(deriveGate1Status([{ kind: 'accept_all' }])).toBe('confirmed')
    expect(deriveGate1Status([{ kind: 'skip' }])).toBe('skipped')
    for (const kind of ['delete', 'promote', 'demote', 'edit']) {
      expect(deriveGate1Status([{ kind }])).toBe('partial')
    }
    expect(() => deriveGate1Status([])).toThrow(/空操作列表/)
  })
})

describe('Gate 1 服务（写盘、前置条件、离线可复现）', () => {
  it('--plan 只读：不写盘、不改 gate1_status', async () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'g1-plan', rawInput: EMOTION_SEED })
    const paths = projectPaths(root.dir, 'g1-plan')
    const result = await runGate1({ paths, provider: recordedProvider(), operations: [], dryRun: true })
    expect(result.written).toBe(false)
    expect(result.finalSeed).toBeUndefined()
    expect(result.interpreter.fixed_by_user).toHaveLength(5)
    expect(loadSeed(paths).story_seed.gate1_status).toBe('pending')
    expect(loadSeed(paths).story_seed.fixed_by_user).toEqual([])
  })

  it('写盘后可从磁盘回读，且 gate1_status 与来源标记正确', async () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'g1-write', rawInput: EMOTION_SEED })
    const paths = projectPaths(root.dir, 'g1-write')
    const result = await runGate1({
      paths,
      provider: recordedProvider(),
      operations: [{ kind: 'promote', id: 'SEED_A001' }],
    })
    expect(result.written).toBe(true)
    const reloaded = loadSeed(paths)
    expect(reloaded.story_seed.gate1_status).toBe('partial')
    expect(reloaded.story_seed.fixed_by_user.find((item) => item.id === 'SEED_A001')).toMatchObject({
      source: 'user_gate1',
      origin: 'gate1_confirmation',
    })
    expect(result.descriptions.join('\n')).toContain('gate1_status: pending → partial')
  })

  it('raw_input 为空 / 项目不存在 / Gate 1 已结束时给出明确前置条件错误', async () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'g1-empty' })
    const emptyPaths = projectPaths(root.dir, 'g1-empty')
    await expect(
      runGate1({ paths: emptyPaths, provider: recordedProvider(), operations: [{ kind: 'accept_all' }] }),
    ).rejects.toBeInstanceOf(Gate1PreconditionError)

    await expect(
      runGate1({
        paths: projectPaths(root.dir, 'no-such-project'),
        provider: recordedProvider(),
        operations: [{ kind: 'accept_all' }],
      }),
    ).rejects.toBeInstanceOf(Gate1PreconditionError)

    setRawSeedInput(emptyPaths, EMOTION_SEED)
    await runGate1({ paths: emptyPaths, provider: recordedProvider(), operations: [{ kind: 'accept_all' }] })
    await expect(
      runGate1({ paths: emptyPaths, provider: recordedProvider(), operations: [{ kind: 'accept_all' }] }),
    ).rejects.toBeInstanceOf(Gate1PreconditionError)
  })

  it('未给出任何选择时拒绝执行（Gate 1 必须显式表态）', async () => {
    const root = tempRoot()
    createProject({ projectsRoot: root.dir, projectId: 'g1-nothing', rawInput: EMOTION_SEED })
    await expect(
      runGate1({ paths: projectPaths(root.dir, 'g1-nothing'), provider: recordedProvider(), operations: [] }),
    ).rejects.toBeInstanceOf(Gate1OperationError)
  })

  it('fixture 目录可通过参数注入（离线验收的入口）', async () => {
    const provider = recordedProvider()
    expect(provider.size).toBe(14)
    expect(join(RECORDED_FIXTURES_DIR, '01-emotion.yaml')).toContain('seed-interpreter')
  })
})
