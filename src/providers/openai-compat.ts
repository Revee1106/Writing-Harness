import { ProviderConfigError, type LLMProvider, type LLMRequest, type LLMResponse } from './types.ts'

/**
 * OpenAI 兼容 Provider（Story 2）。
 *
 * 单模型优先（架构设计 §33.1）：只做一次 chat completion，不引入多 Agent 编排。
 * 通过 base_url + model 即可切换 DeepSeek / OpenAI / Ollama / 其它兼容端点。
 * Story 2 的测试**不依赖本 Provider**（全部走 RecordedProvider），它只服务于真实创作运行。
 */

export interface OpenAICompatConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly timeoutMs?: number | undefined
  /** 便于测试替换（默认使用全局 fetch）。 */
  readonly fetchImpl?: typeof fetch | undefined
}

export interface OpenAICompatFromEnvOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export const OPENAI_COMPAT_ENV_KEYS = {
  baseUrl: 'HARNESS_LLM_BASE_URL',
  apiKey: 'HARNESS_LLM_API_KEY',
  model: 'HARNESS_LLM_MODEL',
  timeoutMs: 'HARNESS_LLM_TIMEOUT_MS',
} as const

interface ChatCompletionResponse {
  readonly model?: string
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number }
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id = 'openai-compat'
  readonly model: string
  private readonly config: OpenAICompatConfig

  constructor(config: OpenAICompatConfig) {
    if (config.baseUrl.trim() === '') throw new ProviderConfigError('baseUrl 不能为空')
    if (config.model.trim() === '') throw new ProviderConfigError('model 不能为空')
    this.config = config
    this.model = config.model
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const doFetch = this.config.fetchImpl ?? globalThis.fetch
    if (typeof doFetch !== 'function') {
      throw new ProviderConfigError('当前运行环境没有可用的 fetch 实现')
    }
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000)
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey === '' ? {} : { authorization: `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            ...(request.system === undefined ? [] : [{ role: 'system', content: request.system }]),
            { role: 'user', content: request.prompt },
          ],
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new ProviderConfigError(`LLM 请求失败：HTTP ${response.status} ${response.statusText} ${body.slice(0, 300)}`)
      }
      const payload = (await response.json()) as ChatCompletionResponse
      const text = payload.choices?.[0]?.message?.content
      if (typeof text !== 'string') {
        throw new ProviderConfigError('LLM 响应缺少 choices[0].message.content')
      }
      return {
        text,
        contract: request.contract,
        contractVersion: request.contractVersion,
        provider: this.id,
        model: payload.model ?? this.config.model,
        inputSha256: '',
        usage: {
          input_tokens: payload.usage?.prompt_tokens,
          output_tokens: payload.usage?.completion_tokens,
        },
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

/** 从环境变量构造；缺少 base_url / model 时明确报错（不静默降级）。 */
export function openAICompatFromEnv(options: OpenAICompatFromEnvOptions = {}): OpenAICompatProvider {
  const env = options.env ?? process.env
  const baseUrl = env[OPENAI_COMPAT_ENV_KEYS.baseUrl]
  const model = env[OPENAI_COMPAT_ENV_KEYS.model]
  const apiKey = env[OPENAI_COMPAT_ENV_KEYS.apiKey] ?? ''
  const timeoutRaw = env[OPENAI_COMPAT_ENV_KEYS.timeoutMs]
  const missing: string[] = []
  if (baseUrl === undefined || baseUrl === '') missing.push(OPENAI_COMPAT_ENV_KEYS.baseUrl)
  if (model === undefined || model === '') missing.push(OPENAI_COMPAT_ENV_KEYS.model)
  if (missing.length > 0) {
    throw new ProviderConfigError(`缺少环境变量：${missing.join(' / ')}（真实模型调用需要它们；离线测试请用 RecordedProvider）`)
  }
  const timeoutMs = timeoutRaw === undefined || timeoutRaw === '' ? undefined : Number(timeoutMsRaw(timeoutRaw))
  return new OpenAICompatProvider({ baseUrl: baseUrl as string, model: model as string, apiKey, timeoutMs })
}

function timeoutMsRaw(raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProviderConfigError(`${OPENAI_COMPAT_ENV_KEYS.timeoutMs} 必须是正数，收到 "${raw}"`)
  }
  return value
}
