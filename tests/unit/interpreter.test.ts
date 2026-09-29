import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  INTERPRETER_NOTICE_CODES,
  isEvidenceLocatable,
  normalizeForEvidence,
  runSeedInterpreter,
} from '../../src/interpreter/interpreter.ts'
import {
  SEED_INTERPRETER_CONTRACT_ID,
  SEED_INTERPRETER_CONTRACT_VERSION,
  InterpreterOutputError,
  extractYamlBlock,
  interpreterOutputSchema,
} from '../../src/interpreter/schema.ts'
import { loadPromptContract, renderPrompt, requiredPlaceholders } from '../../src/interpreter/prompt.ts'
import { ProviderError } from '../../src/providers/types.ts'
import { INTERPRETER_CONTRACT, SEED_FIXTURES_DIR_STORY2, StubProvider, recordedProvider, story2SeedPath } from '../helpers/story2.ts'

function readSeed(fileName: string): string {
  return readFileSync(story2SeedPath(fileName), 'utf8')
}

describe('Prompt Contract（架构设计 §33.1 单模型优先）', () => {
  it('契约文件按 "id@version.md" 冻结，且只要求 raw_input 一个占位符', () => {
    const contract = loadPromptContract(SEED_INTERPRETER_CONTRACT_ID, SEED_INTERPRETER_CONTRACT_VERSION)
    expect(contract.file).toBe('seed_interpreter@0.1.md')
    expect(requiredPlaceholders(contract)).toEqual(['raw_input'])
    expect(contract.template).toContain('不要提问、不要请求澄清、不要输出问卷')
  })

  it('渲染会替换占位符；缺值或残留占位符都会报错', () => {
    const contract = loadPromptContract(SEED_INTERPRETER_CONTRACT_ID, SEED_INTERPRETER_CONTRACT_VERSION)
    const rendered = renderPrompt(contract, { raw_input: '一句话种子。' })
    expect(rendered).toContain('一句话种子。')
    expect(rendered).not.toContain('{{raw_input}}')
    expect(() => renderPrompt(contract, {})).toThrow(ProviderError)
    expect(() => loadPromptContract('not_a_contract', '9.9')).toThrow(/找不到 Prompt Contract/)
  })
})

describe('模型输出解析（Story 2：三件套 + 不弹问卷）', () => {
  it('接受裸 YAML 与 ```yaml 围栏两种形态', () => {
    const bare = 'fixed_by_user: []\nambiguous: []\nopen_questions: []\n'
    const fenced = `说明文字\n\`\`\`yaml\n${bare}\`\`\`\n`
    expect(extractYamlBlock(fenced)).toBe(bare.trim())
    expect(interpreterOutputSchema.parse(extractYamlToObject(bare))).toBeDefined()
    expect(interpreterOutputSchema.safeParse(extractYamlToObject(fenced)).success).toBe(true)
  })

  it('拒绝缺少三件套或含未定义字段的输出', () => {
    expect(interpreterOutputSchema.safeParse({ fixed_by_user: [] }).success).toBe(false)
    expect(
      interpreterOutputSchema.safeParse({
        fixed_by_user: [{ value: 'x', evidence: 'x', confidence: 0.9 }],
        ambiguous: [],
        open_questions: [],
      }).success,
    ).toBe(false)
  })

  it('非法输出抛 InterpreterOutputError 且带原始输出', async () => {
    const provider = new StubProvider('这不是 YAML: [')
    await expect(
      runSeedInterpreter({ provider, rawInput: '任意种子' }),
    ).rejects.toBeInstanceOf(InterpreterOutputError)
  })
})

function extractYamlToObject(text: string): unknown {
  return parseYaml(extractYamlBlock(text))
}

describe('ID 分配与原文可追溯（Story 2「规则」）', () => {
  it('按出现顺序确定性地分配 SEED_F / SEED_A / SEED_Q', async () => {
    const rawInput = readSeed('01-emotion.txt')
    const result = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    expect(result.fixed_by_user.map((item) => item.id)).toEqual([
      'SEED_F001',
      'SEED_F002',
      'SEED_F003',
      'SEED_F004',
      'SEED_F005',
    ])
    expect(result.ambiguous.map((item) => item.id)).toEqual(['SEED_A001', 'SEED_A002'])
    expect(result.open_questions.map((item) => item.id)).toEqual(['SEED_Q001', 'SEED_Q002'])
    expect(result.provider).toBe('recorded')
    expect(result.contractVersion).toBe(INTERPRETER_CONTRACT.version)
    expect(result.inputSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('每一条 fixed_by_user 的证据都能在用户原文中定位（用户明确事实不遗漏的前提）', async () => {
    for (const fileName of SEED_FIXTURES_DIR_STORY2) {
      const rawInput = readSeed(fileName)
      const result = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
      expect(result.fixed_by_user.length, fileName).toBeGreaterThan(0)
      for (const item of result.fixed_by_user) {
        expect(isEvidenceLocatable(item.evidence, rawInput), `${fileName} / ${item.id} / ${item.evidence}`).toBe(true)
      }
    }
  })

  it('原文定位失败的内容不会成为 USER_GIVEN，而是降级为 ambiguous 并给出 notice（原则 2）', async () => {
    const rawInput = readSeed('11-evidence-probe.txt')
    const result = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    expect(result.fixed_by_user.map((item) => item.value)).toEqual(['她把旧相机留给了我', '她不再拍照了'])
    const codes = result.notices.map((notice) => notice.code)
    expect(codes).toContain('EVIDENCE_NOT_FOUND')
    expect(codes).toContain('EVIDENCE_MISSING')
    expect(result.ambiguous.map((item) => item.value)).toContain('这台相机是她父亲留下的')
    expect(result.ambiguous.map((item) => item.value)).toContain('相机里还有半卷没拍完的胶卷')
    for (const notice of result.notices) {
      expect(INTERPRETER_NOTICE_CODES).toContain(notice.code)
    }
  })

  it('规范化比对容忍全/半角与空白差异，但不接受凭空改写', () => {
    expect(normalizeForEvidence(' 妻子 已经\n死亡 ')).toBe('妻子已经死亡')
    expect(isEvidenceLocatable('妻子已经死亡', '他说：妻子已经死亡。')).toBe(true)
    expect(isEvidenceLocatable('妻子已经死亡', '妻子已经去世')).toBe(false)
    expect(isEvidenceLocatable('', '任意文本')).toBe(false)
  })

  it('可以关闭证据校验（仅诊断用途）', async () => {
    const rawInput = readSeed('11-evidence-probe.txt')
    const result = await runSeedInterpreter({ provider: recordedProvider(), rawInput, evidenceCheck: false })
    expect(result.fixed_by_user).toHaveLength(4)
    expect(result.notices).toEqual([])
  })

  it('空输出会给出 EMPTY_OUTPUT notice，而不是崩溃', async () => {
    const provider = new StubProvider('fixed_by_user: []\nambiguous: []\nopen_questions: []\n')
    const result = await runSeedInterpreter({ provider, rawInput: '种子' })
    expect(result.notices.map((notice) => notice.code)).toEqual(['EMPTY_OUTPUT'])
  })

  it('重复条目只保留第一条并给出 DUPLICATE_ITEM', async () => {
    const provider = new StubProvider(
      ['fixed_by_user:', "  - value: '重复项'", "    evidence: '种子'", "  - value: '重复项'", "    evidence: '种子'", 'ambiguous: []', 'open_questions: []'].join('\n'),
    )
    const result = await runSeedInterpreter({ provider, rawInput: '种子' })
    expect(result.fixed_by_user).toHaveLength(1)
    expect(result.notices.map((notice) => notice.code)).toContain('DUPLICATE_ITEM')
  })

  it('Interpreter 不生成问卷：open_questions 只是数据，回放结果里没有任何提问行为', async () => {
    const rawInput = readSeed('06-open-ending.txt')
    const result = await runSeedInterpreter({ provider: recordedProvider(), rawInput })
    expect(result.open_questions.length).toBeGreaterThan(0)
    expect(result.prompt).toContain('不要输出问卷')
    expect(result.rawOutput).not.toContain('？请回答')
  })
})
