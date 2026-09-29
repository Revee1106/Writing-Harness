import { z } from 'zod'
import { deepFreeze } from '../core/freeze.ts'
import { ID_PATTERNS } from '../core/ids.ts'
import { validateSeedFile, type SeedFile, type StorySeed } from '../schema/seed.ts'
import type { InterpreterResult } from '../interpreter/interpreter.ts'

/**
 * Author Gate 1（Story 2）—— 需求规格 §5.1 / 架构设计 §5；Story 2「Gate 1 允许」6 种操作。
 *
 * ```text
 * accept_all  接受全部
 * delete      删除错误分类（fixed_by_user / ambiguous / open_questions 任一）
 * promote     ambiguous → fixed_by_user
 * demote      fixed_by_user → ambiguous
 * edit        编辑条目内容
 * skip        跳过（§5.1：跳过必须记录 gate1_status=skipped，且不得变成问卷）
 * ```
 *
 * 状态影响（需求规格 §5.1 / §7.1；架构设计 §5）：
 * - 用户主动提升 → `status=USER_GIVEN` / `source=user_gate1` / `origin=gate1_confirmation`
 * - 原始 Seed 直接抽取 → `source=user` / `origin=raw_seed`
 */

export const GATE1_OPERATION_KINDS = ['accept_all', 'delete', 'promote', 'demote', 'edit', 'skip'] as const
export type Gate1OperationKind = (typeof GATE1_OPERATION_KINDS)[number]

export const gate1OperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accept_all') }),
  z.strictObject({ kind: z.literal('skip') }),
  z.strictObject({ kind: z.literal('delete'), id: z.string().regex(ID_PATTERNS.seedItem, '必须是 SEED_F/SEED_A/SEED_Q ID') }),
  // 解读 I-16：条目在集合之间移动时保留原 ID，因此 promote / demote 的目标只约束"是 Seed item"，
  // 真正的约束是"目标必须当前位于来源集合"（运行时检查）。
  z.strictObject({ kind: z.literal('promote'), id: z.string().regex(ID_PATTERNS.seedItem, '必须是 Seed item ID') }),
  z.strictObject({ kind: z.literal('demote'), id: z.string().regex(ID_PATTERNS.seedItem, '必须是 Seed item ID') }),
  z.strictObject({
    kind: z.literal('edit'),
    id: z.string().regex(ID_PATTERNS.seedItem, '必须是 SEED_F/SEED_A/SEED_Q ID'),
    value: z.string().min(1, '编辑后的内容不能为空'),
  }),
])
export type Gate1Operation = z.infer<typeof gate1OperationSchema>

export class Gate1OperationError extends Error {
  override readonly name = 'Gate1OperationError'
  readonly detail: readonly string[]

  constructor(message: string, detail: readonly string[] = []) {
    super(detail.length === 0 ? message : `${message}\n- ${detail.join('\n- ')}`)
    this.detail = detail
  }
}

export class Gate1AlreadyClosedError extends Error {
  override readonly name = 'Gate1AlreadyClosedError'
  constructor(gate1Status: string) {
    super(
      `Gate 1 已经结束（gate1_status=${gate1Status}），不允许重跑：否则会二次改写 §8.2 已冻结的 anchor 集合与来源（OQ-27）`,
    )
  }
}

/** 由 Interpreter 结果构造候选 seed：此时 Gate 1 尚未发生，`gate1_status=pending`，anchor 立即冻结。 */
export function seedFromInterpreterResult(rawInput: string, result: InterpreterResult): SeedFile {
  const fixedIds = result.fixed_by_user.map((item) => item.id)
  return validateSeedFile({
    schema_version: '0.1',
    story_seed: {
      raw_input: rawInput,
      // 需求规格 §8.2：首次 Interpreter 产出后立即冻结，Gate 1 不重算
      raw_seed_anchor_ids: fixedIds,
      gate1_status: 'pending',
      fixed_by_user: result.fixed_by_user.map((item) => ({
        id: item.id,
        value: item.value,
        status: 'USER_GIVEN',
        source: 'user',
        origin: 'raw_seed',
      })),
      ambiguous: result.ambiguous.map((item) => ({
        id: item.id,
        value: item.value,
        source: 'interpreter',
      })),
      open_questions: result.open_questions.map((item) => ({
        id: item.id,
        value: item.value,
        source: 'interpreter',
      })),
    },
  })
}

export interface Gate1ApplyResult {
  readonly seed: SeedFile
  readonly gate1Status: 'confirmed' | 'skipped' | 'partial'
  readonly appliedOperations: readonly Gate1Operation[]
  /** 冻结前后的 anchor 集合必须逐项相同（Story 2 验收：Gate 1 升降级不重算）。 */
  readonly anchorsBefore: readonly string[]
  readonly anchorsAfter: readonly string[]
}

/**
 * 应用 Gate 1 操作。纯函数：输入候选 seed + 操作列表，输出新的（已校验、已冻结）seed。
 * **anchor 集合只被读取、从不被改写**：本函数没有任何写入 `raw_seed_anchor_ids` 的路径。
 */
export function applyGate1Operations(
  seed: SeedFile,
  operations: readonly Gate1Operation[],
): Gate1ApplyResult {
  if (seed.story_seed.gate1_status !== 'pending') {
    throw new Gate1AlreadyClosedError(seed.story_seed.gate1_status)
  }
  if (operations.length === 0) {
    throw new Gate1OperationError('Gate 1 至少需要一个操作（接受全部 / 跳过 / 修改）')
  }

  const parsedOperations = operations.map((operation) => {
    const parsed = gate1OperationSchema.safeParse(operation)
    if (!parsed.success) {
      throw new Gate1OperationError(
        'Gate 1 操作非法',
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      )
    }
    return parsed.data
  })

  const hasSkip = parsedOperations.some((operation) => operation.kind === 'skip')
  const hasAcceptAll = parsedOperations.some((operation) => operation.kind === 'accept_all')
  if (hasSkip && parsedOperations.length > 1) {
    throw new Gate1OperationError('skip 必须单独使用：跳过 Gate 1 不能再叠加其他修改')
  }
  if (hasAcceptAll && parsedOperations.length > 1) {
    throw new Gate1OperationError('accept_all 必须单独使用：接受全部不能再叠加其他修改')
  }

  const anchorsBefore = [...seed.story_seed.raw_seed_anchor_ids]
  let storySeed: StorySeed = {
    ...seed.story_seed,
    fixed_by_user: seed.story_seed.fixed_by_user.map((item) => ({ ...item })),
    ambiguous: seed.story_seed.ambiguous.map((item) => ({ ...item })),
    open_questions: seed.story_seed.open_questions.map((item) => ({ ...item })),
  }

  const touched = new Set<string>()

  for (const operation of parsedOperations) {
    switch (operation.kind) {
      case 'accept_all':
      case 'skip':
        break

      case 'delete': {
        const removed = removeEverywhere(storySeed, operation.id)
        if (!removed) {
          throw new Gate1OperationError(`delete 的目标不存在：${operation.id}`)
        }
        touched.add(operation.id)
        break
      }

      case 'promote': {
        const index = storySeed.ambiguous.findIndex((item) => item.id === operation.id)
        if (index < 0) {
          throw new Gate1OperationError(`promote 的目标必须来自 ambiguous：${operation.id}`)
        }
        const [item] = storySeed.ambiguous.splice(index, 1)
        storySeed.fixed_by_user.push({
          id: item?.id as string,
          value: item?.value as string,
          status: 'USER_GIVEN',
          // 需求规格 §5.1 / 架构设计 §5：用户主动提升的来源标记
          source: 'user_gate1',
          origin: 'gate1_confirmation',
        })
        touched.add(operation.id)
        break
      }

      case 'demote': {
        const index = storySeed.fixed_by_user.findIndex((item) => item.id === operation.id)
        if (index < 0) {
          throw new Gate1OperationError(`demote 的目标必须来自 fixed_by_user：${operation.id}`)
        }
        const [item] = storySeed.fixed_by_user.splice(index, 1)
        // 降级后回到 Interpreter 的中间态：无 status（OQ-04），来源仍是 interpreter
        storySeed.ambiguous.push({
          id: item?.id as string,
          value: item?.value as string,
          source: 'interpreter',
        })
        // 注意：raw_seed_anchor_ids 不动 —— §8.2「fixed → ambiguous：不删除历史 anchor」
        touched.add(operation.id)
        break
      }

      case 'edit': {
        const target = findEverywhere(storySeed, operation.id)
        if (target === undefined) {
          throw new Gate1OperationError(`edit 的目标不存在：${operation.id}`)
        }
        if (target.collection === 'fixed_by_user') {
          const item = storySeed.fixed_by_user[target.index]
          if (item !== undefined) storySeed.fixed_by_user[target.index] = { ...item, value: operation.value }
        } else if (target.collection === 'ambiguous') {
          const item = storySeed.ambiguous[target.index]
          if (item !== undefined) storySeed.ambiguous[target.index] = { ...item, value: operation.value }
        } else {
          const item = storySeed.open_questions[target.index]
          if (item !== undefined) storySeed.open_questions[target.index] = { ...item, value: operation.value }
        }
        touched.add(operation.id)
        break
      }
    }
  }

  const gate1Status: Gate1ApplyResult['gate1Status'] = hasSkip
    ? 'skipped'
    : hasAcceptAll
      ? 'confirmed'
      : 'partial'

  const next = validateSeedFile({
    schema_version: seed.schema_version,
    story_seed: { ...storySeed, gate1_status: gate1Status },
  })

  return deepFreeze({
    seed: next,
    gate1Status,
    appliedOperations: parsedOperations,
    anchorsBefore,
    anchorsAfter: [...next.story_seed.raw_seed_anchor_ids],
  }) as Gate1ApplyResult
}

type CollectionName = 'fixed_by_user' | 'ambiguous' | 'open_questions'

function findEverywhere(
  storySeed: StorySeed,
  id: string,
): { collection: CollectionName; index: number } | undefined {
  const collections: CollectionName[] = ['fixed_by_user', 'ambiguous', 'open_questions']
  for (const collection of collections) {
    const index = storySeed[collection].findIndex((item) => item.id === id)
    if (index >= 0) return { collection, index }
  }
  return undefined
}

function removeEverywhere(storySeed: StorySeed, id: string): boolean {
  const found = findEverywhere(storySeed, id)
  if (found === undefined) return false
  storySeed[found.collection].splice(found.index, 1)
  return true
}

/** 操作的可读描述（CLI 与汇报共用）。 */
export function describeGate1Operation(operation: Gate1Operation): string {
  switch (operation.kind) {
    case 'accept_all':
      return '接受全部（gate1_status=confirmed）'
    case 'skip':
      return '跳过 Gate 1（gate1_status=skipped）'
    case 'delete':
      return `删除条目 ${operation.id}`
    case 'promote':
      return `提升 ${operation.id} 为 fixed_by_user（source=user_gate1 / origin=gate1_confirmation）`
    case 'demote':
      return `降级 ${operation.id} 为 ambiguous（保留历史 anchor 身份）`
    case 'edit':
      return `编辑 ${operation.id} 的内容为「${operation.value}」`
  }
}
