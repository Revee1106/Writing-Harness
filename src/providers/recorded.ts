import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { canonicalJson, hashContractInput } from '../core/hash.ts'
import {
  RecordedProviderMissError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './types.ts'

/**
 * RecordedProvider（Story 2）—— 离线回放，保证"至少 10 个 Seed"的验收**完全离线可复现**。
 *
 * fixture 文件（YAML，一文件一条交互）：
 * ```yaml
 * contract: seed_interpreter
 * contract_version: "0.1"
 * seed: story2/01-emotion.txt    # 仅用于工具链定位（pnpm fixtures:refresh 据此重算哈希）
 * input_sha256: 6f1c...
 * response:
 *   model: recorded-seed-interpreter
 *   text: |
 *     fixed_by_user: ...
 * ```
 *
 * 查找键 = `sha256(canonicalJson({contract, contract_version, input}))`；
 * 未命中时抛 `RecordedProviderMissError`，消息里带出可直接补 fixture 的哈希。
 */

export const recordedInteractionSchema = z.strictObject({
  contract: z.string().min(1),
  contract_version: z.string().min(1),
  /** 该 fixture 对应的 Seed 文件（相对 tests/fixtures/seeds 的路径），供 fixtures:refresh 复核哈希。 */
  seed: z.string().min(1).optional(),
  input_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'input_sha256 必须是 64 位小写十六进制'),
  response: z.strictObject({
    model: z.string().min(1),
    text: z.string(),
  }),
})
export type RecordedInteraction = z.infer<typeof recordedInteractionSchema>

export class RecordedFixtureError extends Error {
  override readonly name = 'RecordedFixtureError'
  constructor(message: string) {
    super(message)
  }
}

export function interactionKey(
  interaction: Pick<RecordedInteraction, 'contract' | 'contract_version' | 'input_sha256'>,
): string {
  return `${interaction.contract}@${interaction.contract_version}:${interaction.input_sha256}`
}

export function parseRecordedInteraction(text: string, source = '<inline>'): RecordedInteraction {
  const parsed = recordedInteractionSchema.safeParse(parseYaml(text))
  if (!parsed.success) {
    throw new RecordedFixtureError(
      `fixture 校验失败：${source}\n- ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n- ')}`,
    )
  }
  return parsed.data
}

export class RecordedProvider implements LLMProvider {
  readonly id = 'recorded'
  private readonly byKey: Map<string, RecordedInteraction>

  constructor(interactions: readonly RecordedInteraction[]) {
    this.byKey = new Map()
    for (const interaction of interactions) {
      const key = interactionKey(interaction)
      if (this.byKey.has(key)) {
        throw new RecordedFixtureError(`fixture 键重复：${key}（同一契约与输入只能有一条回应）`)
      }
      this.byKey.set(key, interaction)
    }
  }

  /** 从目录读取全部 `*.yaml` / `*.yml` fixture。 */
  static fromDirectory(dir: string): RecordedProvider {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error) {
      throw new RecordedFixtureError(`读取 recorded fixture 目录失败：${dir}（${(error as Error).message}）`)
    }
    const files = entries.filter((name) => name.endsWith('.yaml') || name.endsWith('.yml')).sort()
    if (files.length === 0) {
      throw new RecordedFixtureError(`recorded fixture 目录中没有 YAML 文件：${dir}`)
    }
    const interactions = files.map((name) => {
      const filePath = join(dir, name)
      return parseRecordedInteraction(readFileSync(filePath, 'utf8'), filePath)
    })
    return new RecordedProvider(interactions)
  }

  get size(): number {
    return this.byKey.size
  }

  keys(): string[] {
    return [...this.byKey.keys()].sort()
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const inputSha256 = hashContractInput(request.contract, request.contractVersion, request.input)
    const key = `${request.contract}@${request.contractVersion}:${inputSha256}`
    const hit = this.byKey.get(key)
    if (hit === undefined) {
      throw new RecordedProviderMissError({
        contract: request.contract,
        contractVersion: request.contractVersion,
        inputSha256,
        canonicalInput: canonicalJson(request.input),
        availableKeys: this.keys(),
      })
    }
    return {
      text: hit.response.text,
      contract: request.contract,
      contractVersion: request.contractVersion,
      provider: this.id,
      model: hit.response.model,
      inputSha256,
    }
  }
}
