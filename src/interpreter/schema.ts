import { z } from 'zod'

/**
 * Seed Interpreter 的输入/输出契约（Story 2；需求规格 §4、§8.1；架构设计 §4）。
 *
 * 模型只输出三件事（`fixed_by_user` / `ambiguous` / `open_questions`），
 * 且**不输出 id / status / source / origin** —— 这些由 Harness 确定性地分配（解读 I-13）。
 */

export const SEED_INTERPRETER_CONTRACT_ID = 'seed_interpreter'
export const SEED_INTERPRETER_CONTRACT_VERSION = '0.1'

/** 模型输出的一条条目：`value` 是陈述，`evidence` 是用户原文中可核对的连续片段。 */
export const interpreterEntrySchema = z.strictObject({
  value: z.string().min(1),
  evidence: z.string().optional(),
})

export const interpreterOutputSchema = z.strictObject({
  fixed_by_user: z.array(interpreterEntrySchema),
  ambiguous: z.array(interpreterEntrySchema),
  open_questions: z.array(interpreterEntrySchema),
})
export type InterpreterOutput = z.infer<typeof interpreterOutputSchema>

export class InterpreterOutputError extends Error {
  override readonly name = 'InterpreterOutputError'
  readonly detail: readonly string[]
  readonly rawOutput: string

  constructor(detail: readonly string[], rawOutput: string) {
    super(`Seed Interpreter 输出不符合契约：\n- ${detail.join('\n- ')}`)
    this.detail = detail
    this.rawOutput = rawOutput
  }
}

/** 去掉 ```yaml 围栏（模型常带围栏）；只取第一段围栏内容，或整段文本。 */
export function extractYamlBlock(text: string): string {
  const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(text)
  if (fenced !== null && typeof fenced[1] === 'string') {
    return fenced[1].trim()
  }
  return text.trim()
}
