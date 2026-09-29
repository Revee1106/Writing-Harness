/**
 * LLM Provider 接口（Story 2，需求规格 §33.1「单模型优先」/ 架构设计 §33.1）。
 *
 * v0.1 只有"一个模型 + 多份 Prompt Contract"的模型调用方式，不引入多 Agent 编排。
 * 所有能力差异都表达在 `contract` / `contract_version` 上，Provider 只负责"文本进、文本出"。
 */

export interface LLMRequest {
  /** Prompt Contract 标识，例如 `seed_interpreter`。 */
  readonly contract: string
  /** Prompt Contract 版本。契约变更必须升版本，会让旧 fixture 自动失效。 */
  readonly contractVersion: string
  /** 结构化输入。它同时参与 fixture 查找键的计算，因此必须是可规范化 JSON 化的纯数据。 */
  readonly input: Readonly<Record<string, unknown>>
  /** 渲染后的提示词正文。 */
  readonly prompt: string
  readonly system?: string | undefined
  readonly temperature?: number | undefined
  readonly maxTokens?: number | undefined
}

export interface LLMUsage {
  readonly input_tokens?: number | undefined
  readonly output_tokens?: number | undefined
}

export interface LLMResponse {
  readonly text: string
  readonly contract: string
  readonly contractVersion: string
  readonly provider: string
  readonly model: string
  readonly inputSha256: string
  readonly usage?: LLMUsage | undefined
}

export interface LLMProvider {
  readonly id: string
  complete(request: LLMRequest): Promise<LLMResponse>
}

/**
 * Story 9：Linter / Rewrite 与 Writer 使用同一个 Provider 接口
 * （单模型优先；能力差异只体现在 Prompt Contract 上）。
 */
export type LinterProvider = LLMProvider

export class ProviderError extends Error {
  override readonly name: string = 'ProviderError'
}

export class ProviderConfigError extends ProviderError {
  override readonly name = 'ProviderConfigError'
}

/** 回放未命中：消息里带出可直接用于补 fixture 的哈希与规范化输入。 */
export class RecordedProviderMissError extends ProviderError {
  override readonly name = 'RecordedProviderMissError'
  readonly contract: string
  readonly contractVersion: string
  readonly inputSha256: string
  readonly canonicalInput: string

  constructor(params: {
    contract: string
    contractVersion: string
    inputSha256: string
    canonicalInput: string
    availableKeys: readonly string[]
  }) {
    super(
      [
        `RecordedProvider 未命中：contract=${params.contract} contract_version=${params.contractVersion}`,
        `input_sha256=${params.inputSha256}`,
        `规范化输入：${params.canonicalInput}`,
        `可用 fixture 数：${params.availableKeys.length}`,
        '补齐方式：在 fixture 文件中新增一条记录，写入上面的 input_sha256，然后运行 `pnpm fixtures:refresh` 复核。',
      ].join('\n'),
    )
    this.contract = params.contract
    this.contractVersion = params.contractVersion
    this.inputSha256 = params.inputSha256
    this.canonicalInput = params.canonicalInput
  }
}
