/**
 * 文本计数工具（Story 6；OQ-16 裁决）。
 *
 * 计数口径（冻结）：
 * - **按 Unicode 码点计**（不是 UTF-16 code unit，也不是字节）；
 * - **含所有非空白字符**（中文、拉丁字母、数字、标点、emoji 都算 1）；
 * - **不含空白 / 换行 / 制表符**（空格、\t、\n、\r、全角空格等都排除）。
 *
 * 用途：`draft_context.max_chars`（默认 600）与其它需要"字数"的地方。
 */

const WHITESPACE_PATTERN = /\s/u

export function isWhitespaceCodePoint(codePoint: string): boolean {
  return WHITESPACE_PATTERN.test(codePoint)
}

/** 统计非空白码点数量。 */
export function countNonWhitespaceCodePoints(text: string): number {
  let count = 0
  for (const codePoint of text) {
    if (!isWhitespaceCodePoint(codePoint)) count += 1
  }
  return count
}

export function countAllCodePoints(text: string): number {
  let count = 0
  for (const _codePoint of text) count += 1
  return count
}

export interface TruncationResult {
  readonly text: string
  /** 截取部分中包含的非空白码点数。 */
  readonly countedCodePoints: number
  /** 是否发生了截断。 */
  readonly truncated: boolean
}

/**
 * 取"末尾 N 个非空白码点"。
 *
 * 语义（OQ-16）：计数不含空白，但**保留原文中的空白**（截取的是原始文本切片，
 * 不做空白压缩），这样 Draft Context 仍然是"用户原文的末尾"而不是被重排过的文本。
 */
export function takeLastNonWhitespaceCodePoints(text: string, limit: number): TruncationResult {
  if (limit <= 0) return { text: '', countedCodePoints: 0, truncated: text.length > 0 }
  const codePoints = [...text]
  let counted = 0
  let startIndex = codePoints.length
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index] as string
    if (!isWhitespaceCodePoint(codePoint)) {
      counted += 1
      if (counted === limit) {
        startIndex = index
        break
      }
    }
    startIndex = index
  }
  const sliced = codePoints.slice(startIndex).join('')
  return {
    text: sliced,
    countedCodePoints: countNonWhitespaceCodePoints(sliced),
    truncated: startIndex > 0,
  }
}
