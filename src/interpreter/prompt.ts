import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProviderError } from '../providers/types.ts'

/**
 * Prompt Contract 加载与渲染（Story 2，架构设计 §33.1「单模型优先」）。
 *
 * 契约以 `.md` 文件形式冻结在 `src/prompts/`，文件名带版本号；
 * 代码只负责渲染占位符，不把提示词散落在逻辑里。
 */

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export interface PromptContract {
  readonly id: string
  readonly version: string
  readonly file: string
  readonly template: string
}

export function loadPromptContract(id: string, version: string): PromptContract {
  const file = `${id}@${version}.md`
  try {
    const template = readFileSync(join(PROMPTS_DIR, file), 'utf8')
    return { id, version, file, template }
  } catch (error) {
    throw new ProviderError(`找不到 Prompt Contract：${file}（${(error as Error).message}）`)
  }
}

export const PLACEHOLDER_PATTERN = /\{\{([a-z_][a-z0-9_]*)\}\}/g

/** 渲染占位符；缺失的键一律报错，避免把 `{{raw_input}}` 直接发给模型。 */
export function renderPrompt(
  contract: PromptContract,
  values: Readonly<Record<string, string>>,
): string {
  const rendered = contract.template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = values[key]
    if (value === undefined) {
      throw new ProviderError(`渲染 ${contract.file} 时缺少占位符取值：{{${key}}}`)
    }
    return value
  })
  const leftovers = [...rendered.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1])
  if (leftovers.length > 0) {
    throw new ProviderError(`渲染 ${contract.file} 后仍有未替换的占位符：${leftovers.join(', ')}`)
  }
  return rendered
}

export function requiredPlaceholders(contract: PromptContract): string[] {
  return [...new Set([...contract.template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] as string))]
}
