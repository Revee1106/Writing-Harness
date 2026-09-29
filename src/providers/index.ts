import { join } from 'node:path'
import { OpenAICompatProvider, openAICompatFromEnv } from './openai-compat.ts'
import { RecordedProvider } from './recorded.ts'
import { ProviderConfigError, type LLMProvider } from './types.ts'

/**
 * Provider 解析（Story 2）。
 *
 * - `recorded`：离线回放，所有测试与可复现验收都走它。
 * - `openai-compat`：真实模型调用（需要环境变量）。
 * - `auto`：显式指定 fixtures 目录时用 recorded；否则尝试环境变量；都没有就明确报错。
 *
 * 绝不静默降级：没有可用 Provider 时报错，而不是偷偷换一个模型。
 */

export const PROVIDER_NAMES = ['auto', 'recorded', 'openai-compat'] as const
export type ProviderName = (typeof PROVIDER_NAMES)[number]

export interface ResolveProviderOptions {
  readonly name?: ProviderName | undefined
  /** recorded fixture 目录（全局或项目级）。 */
  readonly fixturesDir?: string | undefined
  readonly repoRoot?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export const DEFAULT_RECORDED_FIXTURES_REL_PATH = join('tests', 'fixtures', 'recorded', 'seed-interpreter')

export interface ResolvedProvider {
  readonly provider: LLMProvider
  readonly name: Exclude<ProviderName, 'auto'>
  readonly fixturesDir?: string | undefined
}

export function resolveProvider(options: ResolveProviderOptions = {}): ResolvedProvider {
  const name = options.name ?? 'auto'
  const fixturesDir =
    options.fixturesDir ??
    (options.repoRoot === undefined ? undefined : join(options.repoRoot, DEFAULT_RECORDED_FIXTURES_REL_PATH))

  if (name === 'recorded' || (name === 'auto' && fixturesDir !== undefined)) {
    if (fixturesDir === undefined) {
      throw new ProviderConfigError('provider=recorded 需要 --fixtures <dir> 或 repoRoot')
    }
    return { provider: RecordedProvider.fromDirectory(fixturesDir), name: 'recorded', fixturesDir }
  }

  if (name === 'openai-compat' || name === 'auto') {
    return { provider: openAICompatFromEnv({ env: options.env }), name: 'openai-compat' }
  }

  throw new ProviderConfigError(`未知 provider：${String(name)}（可选：${PROVIDER_NAMES.join(' / ')}）`)
}

export { OpenAICompatProvider, RecordedProvider }
export type { LLMProvider, LLMRequest, LLMResponse } from './types.ts'
export { ProviderConfigError, ProviderError, RecordedProviderMissError } from './types.ts'
export { RecordedFixtureError, parseRecordedInteraction, interactionKey } from './recorded.ts'
