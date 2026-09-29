import { parse as parseYaml } from 'yaml'
import { hashContractInput } from '../core/hash.ts'
import { loadPromptContract, renderPrompt } from './prompt.ts'
import {
  SEED_INTERPRETER_CONTRACT_ID,
  SEED_INTERPRETER_CONTRACT_VERSION,
  InterpreterOutputError,
  extractYamlBlock,
  interpreterOutputSchema,
  type InterpreterOutput,
} from './schema.ts'
import type { LLMProvider } from '../providers/types.ts'

/**
 * Seed Interpreter（Story 2；需求规格 §4「Seed Interpreter 不弹问卷」、§8.1；架构设计 §4）。
 *
 * 流程：渲染 Prompt Contract → 调 Provider → 解析 YAML → 分配稳定 ID → 校验原文可追溯性 →
 *       产出可与 Gate 1 交互的结构化结果。
 *
 * 关键规则（Story 2「规则」）：
 * - `fixed_by_user` 必须能追溯用户原文：`evidence` 必须在 `raw_input` 中可定位（规范化后比对）；
 * - 定位失败的条目**不得**成为 USER_GIVEN（原则 2：可以提案，不能伪装），降级为 `ambiguous` 并给出 notice；
 * - 推断不混入 fixed；
 * - 不生成问卷：`open_questions` 只是数据。
 */

export interface InterpreterItem {
  readonly id: string
  readonly value: string
  /** 用户原文中的连续片段（transient：见 OQ-26，不写入 seed.yaml）。 */
  readonly evidence: string
}

export const INTERPRETER_NOTICE_CODES = [
  'EVIDENCE_NOT_FOUND',
  'EVIDENCE_MISSING',
  'DUPLICATE_ITEM',
  'EMPTY_OUTPUT',
] as const
export type InterpreterNoticeCode = (typeof INTERPRETER_NOTICE_CODES)[number]

export interface InterpreterNotice {
  readonly code: InterpreterNoticeCode
  readonly message: string
  readonly value?: string | undefined
}

export interface InterpreterResult {
  readonly contract: string
  readonly contractVersion: string
  readonly provider: string
  readonly model: string
  readonly inputSha256: string
  /** 模型原样输出（审计用；不落盘，见 OQ-25）。 */
  readonly rawOutput: string
  readonly prompt: string
  readonly fixed_by_user: readonly InterpreterItem[]
  readonly ambiguous: readonly InterpreterItem[]
  readonly open_questions: readonly InterpreterItem[]
  readonly notices: readonly InterpreterNotice[]
}

export interface RunSeedInterpreterOptions {
  readonly provider: LLMProvider
  readonly rawInput: string
  /** 关闭"原文可定位"校验（默认开启）。关闭仅用于诊断，不建议在正常流程中使用。 */
  readonly evidenceCheck?: boolean | undefined
}

/** 比较用的规范化：NFKC + 去除全部空白，避免全/半角与换行差异造成误判。 */
export function normalizeForEvidence(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '')
}

export function isEvidenceLocatable(evidence: string, rawInput: string): boolean {
  const needle = normalizeForEvidence(evidence)
  if (needle === '') return false
  return normalizeForEvidence(rawInput).includes(needle)
}

function assignIds(prefix: 'SEED_F' | 'SEED_A' | 'SEED_Q', count: number, startAt = 1): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}${String(startAt + index).padStart(3, '0')}`)
}

interface ParsedCollections {
  readonly fixed: InterpreterOutput['fixed_by_user']
  readonly ambiguous: InterpreterOutput['ambiguous']
  readonly questions: InterpreterOutput['open_questions']
}

function parseModelOutput(rawOutput: string): ParsedCollections {
  const yamlText = extractYamlBlock(rawOutput)
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch (error) {
    throw new InterpreterOutputError([`YAML 解析失败：${(error as Error).message}`], rawOutput)
  }
  const result = interpreterOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new InterpreterOutputError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      rawOutput,
    )
  }
  return {
    fixed: result.data.fixed_by_user,
    ambiguous: result.data.ambiguous,
    questions: result.data.open_questions,
  }
}

export async function runSeedInterpreter(options: RunSeedInterpreterOptions): Promise<InterpreterResult> {
  const contract = loadPromptContract(SEED_INTERPRETER_CONTRACT_ID, SEED_INTERPRETER_CONTRACT_VERSION)
  const prompt = renderPrompt(contract, { raw_input: options.rawInput })
  const input = { raw_input: options.rawInput }

  const response = await options.provider.complete({
    contract: contract.id,
    contractVersion: contract.version,
    input,
    prompt,
    system: '你只输出符合约定的 YAML，不输出解释。',
    temperature: 0,
  })

  const { fixed, ambiguous, questions } = parseModelOutput(response.text)
  const evidenceCheck = options.evidenceCheck ?? true
  const notices: InterpreterNotice[] = []

  const acceptedFixed: { value: string; evidence: string }[] = []
  const downgraded: { value: string; evidence: string }[] = []
  const seen = new Set<string>()

  for (const entry of fixed) {
    const value = entry.value.trim()
    if (value === '') continue
    const evidence = (entry.evidence ?? '').trim()
    if (seen.has(value)) {
      notices.push({ code: 'DUPLICATE_ITEM', message: `fixed_by_user 出现重复条目，仅保留第一条：${value}`, value })
      continue
    }
    seen.add(value)
    if (!evidenceCheck) {
      acceptedFixed.push({ value, evidence })
      continue
    }
    if (evidence === '') {
      downgraded.push({ value, evidence })
      notices.push({
        code: 'EVIDENCE_MISSING',
        message: `该条没有给出用户原文片段，无法确认是用户明说的内容，已降级为 ambiguous（原则 2）：${value}`,
        value,
      })
      continue
    }
    if (!isEvidenceLocatable(evidence, options.rawInput)) {
      downgraded.push({ value, evidence })
      notices.push({
        code: 'EVIDENCE_NOT_FOUND',
        message: `原文片段在 Story Seed 中找不到，该条可能是推断而非用户明说，已降级为 ambiguous（原则 2）：${value}`,
        value,
      })
      continue
    }
    acceptedFixed.push({ value, evidence })
  }

  const ambiguousEntries = [...ambiguous, ...downgraded]
    .map((entry) => ({ value: entry.value.trim(), evidence: (entry.evidence ?? '').trim() }))
    .filter((entry) => entry.value !== '')
  const questionEntries = questions
    .map((entry) => ({ value: entry.value.trim(), evidence: (entry.evidence ?? '').trim() }))
    .filter((entry) => entry.value !== '')

  if (acceptedFixed.length === 0 && ambiguousEntries.length === 0 && questionEntries.length === 0) {
    notices.push({
      code: 'EMPTY_OUTPUT',
      message: 'Interpreter 没有产出任何条目：Story Seed 可能过短或输出格式异常，Gate 1 将无事可做',
    })
  }

  const fixedIds = assignIds('SEED_F', acceptedFixed.length)
  const ambiguousIds = assignIds('SEED_A', ambiguousEntries.length)
  const questionIds = assignIds('SEED_Q', questionEntries.length)

  return {
    contract: contract.id,
    contractVersion: contract.version,
    provider: response.provider,
    model: response.model,
    inputSha256: hashContractInput(contract.id, contract.version, input),
    rawOutput: response.text,
    prompt,
    fixed_by_user: acceptedFixed.map((entry, index) => ({ id: fixedIds[index] as string, ...entry })),
    ambiguous: ambiguousEntries.map((entry, index) => ({ id: ambiguousIds[index] as string, ...entry })),
    open_questions: questionEntries.map((entry, index) => ({ id: questionIds[index] as string, ...entry })),
    notices,
  }
}
