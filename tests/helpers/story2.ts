import { SEED_INTERPRETER_CONTRACT_ID, SEED_INTERPRETER_CONTRACT_VERSION } from '../../src/interpreter/schema.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/providers/types.ts'
import { RECORDED_FIXTURES_DIR, SEEDS_DIR, STORY2_SEEDS_DIR } from './paths.ts'

/** Story 2 共用的契约常量与 Provider 工厂。 */
export const INTERPRETER_CONTRACT = {
  id: SEED_INTERPRETER_CONTRACT_ID,
  version: SEED_INTERPRETER_CONTRACT_VERSION,
} as const

/** Story 10 C 节要求覆盖的 Seed 类型（前 8 个来自文档，后 2 个为自选）。 */
export const SEED_FIXTURES_DIR_STORY2 = [
  '01-emotion.txt', // 情感
  '02-mystery.txt', // 悬疑
  '03-realism.txt', // 现实
  '04-warmth.txt', // 温情
  '05-light-scifi.txt', // 轻科幻
  '06-open-ending.txt', // 开放结局
  '07-single-scene.txt', // 单场景
  '08-twist.txt', // 强反转
  '09-dark-humor.txt', // 自选：黑色幽默
  '10-growth.txt', // 自选：成长
] as const

export function recordedProvider(): RecordedProvider {
  return RecordedProvider.fromDirectory(RECORDED_FIXTURES_DIR)
}

export function story2SeedPath(fileName: string): string {
  return `${STORY2_SEEDS_DIR}/${fileName}`
}

export { RECORDED_FIXTURES_DIR, SEEDS_DIR, STORY2_SEEDS_DIR }

/** 断言"使用不会升级"时复用的桩 Provider（固定返回给定文本）。 */
export class StubProvider implements LLMProvider {
  readonly id = 'stub'
  readonly requests: LLMRequest[] = []
  constructor(private readonly text: string) {}
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request)
    return {
      text: this.text,
      contract: request.contract,
      contractVersion: request.contractVersion,
      provider: this.id,
      model: 'stub-model',
      inputSha256: 'stub',
    }
  }
}
