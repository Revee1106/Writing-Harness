/**
 * 深度冻结工具（Story 1，解读 I-2）
 *
 * 状态项在解析/构造后一律冻结，任何"顺手改一下 status"的代码会在严格模式下直接抛错，
 * 而不是悄悄产生一次未授权的状态升级（需求规格 §32 原则 1 / 原则 4）。
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') {
    return value as Readonly<T>
  }
  if (Object.isFrozen(value)) {
    return value as Readonly<T>
  }
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value as Readonly<T>
}
