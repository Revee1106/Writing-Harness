import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Document, Scalar, isScalar, parse, visit } from 'yaml'

/**
 * 确定性 YAML 读写（Story 1）。
 *
 * 目标：
 * 1. key 顺序稳定（由 zod schema 的 shape 顺序决定，写入前不再重排）；
 * 2. 用户 raw input 原样保留（含多行 Markdown）—— 多行字符串使用 block literal；
 * 3. `undefined` 一律剪枝，不写成空值；`null` 保留（文档明确使用 `null` 表示占位/无值）。
 */

const DUMP_OPTIONS = { indent: 2, lineWidth: 0 } as const

/** 递归剪掉 `undefined` 值；数组中的 `undefined` 变为 `null`（YAML 无 `undefined` 概念）。 */
export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : pruneUndefined(item))) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue
      out[key] = pruneUndefined(item)
    }
    return out as T
  }
  return value
}

/**
 * 多行字符串使用 block literal（解读 I-7）。
 * 仅在包含换行、且首行不以空白开头时使用 —— 后者需要 indentation indicator，
 * 交给 yaml 库自行选择更安全的引号风格，避免破坏"原样保留"。
 */
function applyBlockLiteralStyle(doc: Document): void {
  visit(doc, (_key, node) => {
    if (
      isScalar(node) &&
      typeof node.value === 'string' &&
      node.value.includes('\n') &&
      !/^\s/.test(node.value)
    ) {
      node.type = Scalar.BLOCK_LITERAL
    }
  })
}

export function dumpYaml(value: unknown): string {
  const doc = new Document(pruneUndefined(value))
  applyBlockLiteralStyle(doc)
  const text = doc.toString(DUMP_OPTIONS)
  return text.endsWith('\n') ? text : `${text}\n`
}

export function loadYaml(text: string): unknown {
  return parse(text) ?? null
}

export interface WriteYamlOptions {
  /** 写在文件最前面的注释行（OQ-49：Manifest 顶部标注最后编译的 Scene）。 */
  readonly headerComments?: readonly string[] | undefined
}

export function writeYamlFile(filePath: string, value: unknown, options: WriteYamlOptions = {}): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const header = (options.headerComments ?? []).map((line) => `# ${line}\n`).join('')
  writeFileSync(filePath, `${header}${dumpYaml(value)}`, { encoding: 'utf8' })
}

/** 纯文本落盘（用于 drafts/*.md 这类非 YAML 产物）。 */
export function writeTextFile(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, text, { encoding: 'utf8' })
}

export function readTextFile(filePath: string): string {
  return readFileSync(filePath, { encoding: 'utf8' })
}

export function readYamlFile(filePath: string): unknown {
  return loadYaml(readFileSync(filePath, 'utf8'))
}
