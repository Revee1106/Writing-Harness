import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, hashContractInput, sha256Hex } from '../../src/core/hash.ts'
import { ROOT_WITH_PROMPTS } from '../helpers/paths.ts'
import { INTERPRETER_CONTRACT, SEED_FIXTURES_DIR_STORY2 } from '../helpers/story2.ts'
import {
  RecordedProvider,
  interactionKey,
  parseRecordedInteraction,
} from '../../src/providers/recorded.ts'
import {
  ProviderConfigError,
  RecordedProviderMissError,
  type LLMRequest,
} from '../../src/providers/types.ts'
import { OpenAICompatProvider, openAICompatFromEnv } from '../../src/providers/openai-compat.ts'
import { resolveProvider } from '../../src/providers/index.ts'
import { checkRecordedFixtures } from '../../src/providers/recorded-fixtures-tools.ts'
import { readFileSync } from 'node:fs'

const FIXTURES_DIR = join(ROOT_WITH_PROMPTS, 'tests', 'fixtures', 'recorded', 'seed-interpreter')
const SEEDS_DIR = join(ROOT_WITH_PROMPTS, 'tests', 'fixtures', 'seeds')

function requestFor(rawInput: string): LLMRequest {
  return {
    contract: INTERPRETER_CONTRACT.id,
    contractVersion: INTERPRETER_CONTRACT.version,
    input: { raw_input: rawInput },
    prompt: '<prompt 不参与 fixture 匹配>',
  }
}

describe('确定性哈希（Story 2）', () => {
  it('canonicalJson 对键顺序不敏感，对值敏感', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: 2 })).not.toBe(canonicalJson({ a: 3 }))
  })

  it('hashContractInput 是 64 位小写十六进制，且契约版本参与计算', () => {
    const hash = hashContractInput('c', '0.1', { raw_input: 'x' })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(sha256Hex(canonicalJson({ contract: 'c', contract_version: '0.1', input: { raw_input: 'x' } })))
    expect(hashContractInput('c', '0.2', { raw_input: 'x' })).not.toBe(hash)
  })
})

describe('RecordedProvider（离线回放）', () => {
  it('14 个 seed-interpreter fixture 全部加载成功，键唯一', () => {
    const provider = RecordedProvider.fromDirectory(FIXTURES_DIR)
    expect(provider.size).toBe(14)
    expect(new Set(provider.keys()).size).toBe(14)
  })

  it('按 contract + 契约版本 + 输入哈希命中，返回固定回应', async () => {
    const provider = RecordedProvider.fromDirectory(FIXTURES_DIR)
    const rawInput = readFileSync(join(SEEDS_DIR, 'story2/01-emotion.txt'), 'utf8')
    const first = await provider.complete(requestFor(rawInput))
    const second = await provider.complete(requestFor(rawInput))
    expect(first.text).toBe(second.text)
    expect(first.provider).toBe('recorded')
    expect(first.model).toBe('recorded-seed-interpreter-v0.1')
    expect(first.text).toContain('fixed_by_user:')
  })

  it('未命中时报错并给出可直接补 fixture 的哈希与规范化输入', async () => {
    const provider = RecordedProvider.fromDirectory(FIXTURES_DIR)
    await expect(provider.complete(requestFor('一个完全不在 fixture 里的种子。'))).rejects.toBeInstanceOf(
      RecordedProviderMissError,
    )
    try {
      await provider.complete(requestFor('未登记的种子'))
    } catch (error) {
      const miss = error as RecordedProviderMissError
      expect(miss.inputSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(miss.canonicalInput).toContain('未登记的种子')
      expect(miss.message).toContain('fixtures:refresh')
    }
  })

  it('契约版本变化会让旧 fixture 失效（避免"提示词改了还用旧结果"）', async () => {
    const provider = RecordedProvider.fromDirectory(FIXTURES_DIR)
    const rawInput = readFileSync(join(SEEDS_DIR, 'story2/01-emotion.txt'), 'utf8')
    await expect(
      provider.complete({ ...requestFor(rawInput), contractVersion: '0.2' }),
    ).rejects.toBeInstanceOf(RecordedProviderMissError)
  })

  it('拒绝重复键与非法 fixture', () => {
    const single = readFileSync(join(FIXTURES_DIR, '01-emotion.yaml'), 'utf8')
    const parsed = parseRecordedInteraction(single)
    expect(interactionKey(parsed)).toContain('seed_interpreter@0.1:')
    expect(() => new RecordedProvider([parsed, parsed])).toThrow(/fixture 键重复/)
    expect(() => parseRecordedInteraction('contract: x\n')).toThrow(/fixture 校验失败/)
  })
})

describe('fixture 与 Seed 文本不漂移（fixtures:check 的库内版本）', () => {
  it('每个 fixture 声明的 seed 文件都存在，且 input_sha256 与当前文本一致', async () => {
    const entries = await checkRecordedFixtures({
      fixturesDir: FIXTURES_DIR,
      seedsDir: SEEDS_DIR,
      interpreterFixturesDir: FIXTURES_DIR,
      repoRoot: ROOT_WITH_PROMPTS,
    })
    expect(entries).toHaveLength(14)
    const failing = entries.filter((entry) => !entry.ok)
    expect(failing.map((entry) => `${entry.file}: ${entry.problem ?? ''}`)).toEqual([])
  })

  it('Story 2 的 10 个类型化 Seed 全部在 fixture 集合中', async () => {
    const entries = await checkRecordedFixtures({
      fixturesDir: FIXTURES_DIR,
      seedsDir: SEEDS_DIR,
      interpreterFixturesDir: FIXTURES_DIR,
      repoRoot: ROOT_WITH_PROMPTS,
    })
    const seeds = entries.map((entry) => entry.seedFile).filter((value): value is string => value !== undefined)
    for (const name of SEED_FIXTURES_DIR_STORY2) {
      expect(seeds).toContain(`story2/${name}`)
    }
  })
})

describe('Provider 解析与配置（不静默降级）', () => {
  it('显式 recorded 会加载 fixture 目录', () => {
    const resolved = resolveProvider({ name: 'recorded', fixturesDir: FIXTURES_DIR })
    expect(resolved.name).toBe('recorded')
    expect(resolved.provider.id).toBe('recorded')
  })

  it('auto 在给定 repoRoot 时优先使用离线 fixture', () => {
    const resolved = resolveProvider({ name: 'auto', repoRoot: ROOT_WITH_PROMPTS })
    expect(resolved.name).toBe('recorded')
  })

  it('真实 Provider 缺少环境变量时报错，而不是偷偷换模型', () => {
    expect(() => resolveProvider({ name: 'openai-compat', env: {} })).toThrow(ProviderConfigError)
    expect(() => openAICompatFromEnv({ env: {} })).toThrow(/HARNESS_LLM_BASE_URL/)
    expect(() => openAICompatFromEnv({ env: { HARNESS_LLM_BASE_URL: 'http://x', HARNESS_LLM_MODEL: '' } })).toThrow(
      /HARNESS_LLM_MODEL/,
    )
  })

  it('真实 Provider 可构造，且 HTTP 失败时明确抛错（不发真实请求）', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 50,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'x' }), { status: 401, statusText: 'Unauthorized' }),
    })
    await expect(
      provider.complete({
        contract: 'c',
        contractVersion: '0.1',
        input: {},
        prompt: 'p',
      }),
    ).rejects.toThrow(/HTTP 401/)
  })

  it('真实 Provider 能从成功响应中取出文本', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ model: 'm-2024', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
          { status: 200 },
        ),
    })
    const response = await provider.complete({ contract: 'c', contractVersion: '0.1', input: {}, prompt: 'p' })
    expect(response.text).toBe('hello')
    expect(response.usage?.input_tokens).toBe(3)
    expect(response.provider).toBe('openai-compat')
  })
})
