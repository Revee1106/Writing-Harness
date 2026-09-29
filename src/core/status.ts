import { z } from 'zod'

/**
 * 四状态枚举 —— 需求规格 §6.1 / 架构设计 §7。
 * 需求规格 §33「冻结结论」：四种状态，v0.1 不扩展、不新增第五种。
 */
export const STATUS = ['USER_GIVEN', 'PROPOSED', 'CONFIRMED', 'OCCURRED'] as const
export const statusSchema = z.enum(STATUS)
export type Status = z.infer<typeof statusSchema>

/**
 * 状态来源枚举 —— 需求规格 §7 / 架构设计 §7 给出的五个值，
 * 加上 OQ-02 裁决收编的两个文档自身已在使用、但原枚举遗漏的值：
 * - `interpreter`：Seed Interpreter 产出（需求规格 §8.1 open_questions 示例）
 * - `scene_breakdown`：Scene Breakdown 新增内容（Story 5「关键规则」）
 */
export const SOURCES = [
  'user',
  'user_gate1',
  'interpreter',
  'harness',
  'blueprint',
  'scene_breakdown',
  'final_text',
] as const
export const sourceSchema = z.enum(SOURCES)
export type Source = z.infer<typeof sourceSchema>

/**
 * origin 枚举 —— 需求规格 §7.1。**仅对 USER_GIVEN 有意义**：
 * - `raw_seed`：用户原始输入直接形成的 Seed Anchor
 * - `gate1_confirmation`：Interpreter 推测经用户在 Gate 1 明确确认后提升
 * 其他状态必须省略 origin 或置为 null。
 */
export const ORIGINS = ['raw_seed', 'gate1_confirmation'] as const
export const originSchema = z.enum(ORIGINS)
export type Origin = z.infer<typeof originSchema>

/**
 * USER_GIVEN 的 source ⇔ origin 配对（需求规格 §7.1；架构设计 §5）。
 * 解读 OQ-24：Story 1 按严格解读实现 —— USER_GIVEN 必须携带 origin，且必须与 source 配对。
 */
export const USER_GIVEN_SOURCE_ORIGIN = {
  user: 'raw_seed',
  user_gate1: 'gate1_confirmation',
} as const
export type UserGivenSource = keyof typeof USER_GIVEN_SOURCE_ORIGIN
