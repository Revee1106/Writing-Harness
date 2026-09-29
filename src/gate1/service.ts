import { existsSync } from 'node:fs'
import { loadSeed, saveSeed } from '../project/project.ts'
import type { ProjectPaths } from '../io/paths.ts'
import type { SeedFile } from '../schema/seed.ts'
import { runSeedInterpreter, type InterpreterResult } from '../interpreter/interpreter.ts'
import type { LLMProvider } from '../providers/types.ts'
import {
  Gate1OperationError,
  applyGate1Operations,
  describeGate1Operation,
  seedFromInterpreterResult,
  type Gate1Operation,
} from './operations.ts'
import { assertGate1StatusTransition, type Gate1OpenStatus } from './status.ts'

/**
 * Gate 1 服务（Story 2）：Seed → Interpreter → Author Gate 1 → seed.yaml。
 *
 * 位置固定：Seed Interpreter → **Gate 1** → Story Developer（架构设计 §5「位置固定」）。
 * Gate 1 非阻塞：`--plan` 只读预览，`skip` 直接放行并记录 `gate1_status=skipped`（需求规格 §5.1）。
 */

export class Gate1PreconditionError extends Error {
  override readonly name = 'Gate1PreconditionError'
}

export interface RunGate1Options {
  readonly paths: ProjectPaths
  readonly provider: LLMProvider
  readonly operations: readonly Gate1Operation[]
  /** 只读预览：运行 Interpreter 并返回结果，但不写盘、不改状态。 */
  readonly dryRun?: boolean | undefined
}

export interface Gate1RunResult {
  readonly interpreter: InterpreterResult
  /** Gate 1 之前的候选 seed（`gate1_status=pending`，anchor 已按 §8.2 冻结）。 */
  readonly candidateSeed: SeedFile
  /** 只有当 dryRun=false 时才有值：Gate 1 之后写盘的 seed。 */
  readonly finalSeed: SeedFile | undefined
  readonly gate1Status: Gate1OpenStatus | undefined
  readonly appliedOperations: readonly Gate1Operation[]
  readonly anchorsBefore: readonly string[]
  readonly anchorsAfter: readonly string[]
  readonly descriptions: readonly string[]
  readonly written: boolean
}

export async function runGate1(options: RunGate1Options): Promise<Gate1RunResult> {
  const { paths, provider, operations } = options
  const dryRun = options.dryRun ?? false

  if (!existsSync(paths.seed)) {
    throw new Gate1PreconditionError(`找不到 ${paths.seed}；请先用 harness init 建立项目`)
  }
  const current = loadSeed(paths)
  if (current.story_seed.raw_input.trim() === '') {
    throw new Gate1PreconditionError('seed.yaml 的 raw_input 为空；请先用 harness seed set 保存用户 raw input')
  }
  if (current.story_seed.gate1_status !== 'pending') {
    throw new Gate1PreconditionError(
      `gate1_status=${current.story_seed.gate1_status}，Gate 1 已经结束，不允许重跑（OQ-27）`,
    )
  }

  const interpreter = await runSeedInterpreter({ provider, rawInput: current.story_seed.raw_input })
  const candidateSeed = seedFromInterpreterResult(current.story_seed.raw_input, interpreter)

  if (dryRun) {
    return {
      interpreter,
      candidateSeed,
      finalSeed: undefined,
      gate1Status: undefined,
      appliedOperations: [],
      anchorsBefore: [...candidateSeed.story_seed.raw_seed_anchor_ids],
      anchorsAfter: [...candidateSeed.story_seed.raw_seed_anchor_ids],
      descriptions: [],
      written: false,
    }
  }

  if (operations.length === 0) {
    throw new Gate1OperationError(
      'Gate 1 需要明确选择：--accept-all（接受全部）/ --skip（跳过）/ --op <修改>（删除、提升、降级、编辑）',
    )
  }

  const applied = applyGate1Operations(candidateSeed, operations)
  const ruleId = assertGate1StatusTransition('pending', applied.gate1Status)
  if (applied.anchorsBefore.join(',') !== applied.anchorsAfter.join(',')) {
    // 结构性断言：Gate 1 只读 anchor，从不重算（需求规格 §8.2）
    throw new Gate1OperationError(
      `Gate 1 不允许改写 raw_seed_anchor_ids（§8.2）：before=[${applied.anchorsBefore.join(', ')}] after=[${applied.anchorsAfter.join(', ')}]`,
    )
  }

  const saved = saveSeed(paths, applied.seed)

  return {
    interpreter,
    candidateSeed,
    finalSeed: saved,
    gate1Status: applied.gate1Status,
    appliedOperations: applied.appliedOperations,
    anchorsBefore: applied.anchorsBefore,
    anchorsAfter: applied.anchorsAfter,
    descriptions: [
      ...applied.appliedOperations.map(describeGate1Operation),
      `gate1_status: pending → ${applied.gate1Status}（规则 ${ruleId}）`,
    ],
    written: true,
  }
}
