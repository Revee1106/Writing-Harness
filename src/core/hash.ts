import { createHash } from 'node:crypto'

/**
 * 确定性哈希工具（Story 2）。
 *
 * 用途：`RecordedProvider` 用「契约 + 契约版本 + 结构化输入」的规范化哈希作为 fixture 查找键，
 * 从而做到**完全离线、可复现**，且不依赖提示词的措辞（提示词属于契约版本的一部分）。
 */

/** 规范化 JSON：对象键排序、递归，保证同样的输入永远得到同样的字符串。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * fixture 查找键：`sha256(canonicalJson({contract, contract_version, input}))`。
 * 契约版本变化会让旧 fixture 失效 —— 这是刻意的，避免"提示词改了但回放还在用旧结果"。
 */
export function hashContractInput(
  contract: string,
  contractVersion: string,
  input: Readonly<Record<string, unknown>>,
): string {
  return sha256Hex(canonicalJson({ contract, contract_version: contractVersion, input }))
}
