import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashContractInput } from '../core/hash.ts'
import { parseRecordedInteraction, RecordedProvider, type RecordedInteraction } from './recorded.ts'

/**
 * recorded fixture 的哈希复核工具（Story 2 / Story 3）。
 *
 * 每个 fixture 都声明它对应的 Seed 文件（`seed: story2/01-emotion.txt`），
 * 并按契约重建"运行时会发给 Provider 的结构化输入"，据此重算 `input_sha256`，
 * 保证 **fixture 与 Seed 文本 / Gate 1 状态不会静默漂移**。
 *
 * 契约的输入构造是显式注册的（不靠猜）：
 * - `seed_interpreter`  → `{ raw_input }`
 * - `story_developer`   → 用 recorded interpreter fixture 复现 Gate 1 之后的 seed 状态，
 *   再走 `buildDeveloperInput()`；因此 fixture 需要额外声明 `gate1_ops`（fixture 元数据）。
 * - `blueprint_builder` → 在上一链条基础上再跑 Story Developer（recorded）得到 proposals，
 *   然后按 fixture 元数据 `gate2_plan` 解析字段计划并构造输入。
 */

export interface FixtureCheckEntry {
  readonly file: string
  readonly contract: string
  readonly seedFile: string | undefined
  readonly expectedSha256: string | undefined
  readonly actualSha256: string | undefined
  readonly ok: boolean
  readonly problem?: string | undefined
}

export interface FixtureToolOptions {
  readonly fixturesDir: string
  readonly seedsDir: string
  /** seed-interpreter fixture 目录：story_developer 复核需要用它复现 Gate 1 状态。 */
  readonly interpreterFixturesDir: string
}

type InputBuilder = (context: {
  interaction: RecordedInteraction
  rawInput: string
  interpreterFixturesDir: string
}) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>

const INPUT_BUILDERS: Record<string, InputBuilder> = {
  seed_interpreter: ({ rawInput }) => ({ raw_input: rawInput }),
  story_developer: async ({ interaction, rawInput, interpreterFixturesDir }) => {
    const { buildDeveloperInput } = await import('../developer/developer.ts')
    const { applyGate1Operations, gate1OperationSchema, seedFromInterpreterResult } = await import('../gate1/operations.ts')
    const { runSeedInterpreter } = await import('../interpreter/interpreter.ts')
    const provider = RecordedProvider.fromDirectory(interpreterFixturesDir)
    const interpreter = await runSeedInterpreter({ provider, rawInput })
    const candidate = seedFromInterpreterResult(rawInput, interpreter)
    // fixture 元数据解析为正式的 Gate 1 操作（非法元数据直接报错，而不是被忽略）
    const operations = (interaction.gate1_ops ?? []).map((operation) => gate1OperationSchema.parse(operation))
    const applied = applyGate1Operations(candidate, operations)
    return buildDeveloperInput(applied.seed, interaction.style_preference)
  },
}

const INPUT_BUILDERS_EXTRA: Record<string, InputBuilder> = {
  blueprint_builder: async ({ interaction, rawInput, interpreterFixturesDir }) => {
    const { applyGate1Operations, seedFromInterpreterResult } = await import('../gate1/operations.ts')
    const { runSeedInterpreter } = await import('../interpreter/interpreter.ts')
    const { runStoryDeveloper } = await import('../developer/developer.ts')
    const { buildBlueprintBuilderInput, resolveFieldPlan } = await import('../gate2/builder.ts')

    const interpreterProvider = RecordedProvider.fromDirectory(interpreterFixturesDir)
    const interpreter = await runSeedInterpreter({ provider: interpreterProvider, rawInput })
    const candidate = seedFromInterpreterResult(rawInput, interpreter)
    const seed = applyGate1Operations(candidate, (interaction.gate1_ops ?? []).map((op) => op as never)).seed

    const developerDir = interpreterFixturesDir.replace(/seed-interpreter$/, 'story_developer')
    const developer = await runStoryDeveloper({
      provider: RecordedProvider.fromDirectory(developerDir),
      seed,
      stylePreference: interaction.style_preference,
    })

    const plan = resolveFieldPlan({
      fromProposal: interaction.gate2_plan?.from,
      fields: interaction.gate2_plan?.fields,
      proposals: developer.file,
    })
    const edits = interaction.gate2_plan?.edits ?? {}
    const userEdits = plan.userFields.map((field, index) => ({
      id: `EDIT_${String(index + 1).padStart(3, '0')}`,
      field,
      value: edits[field] ?? '',
    }))
    const conflictResolutions = Object.entries(interaction.gate2_plan?.resolutions ?? {}).map(([key, resolution]) => {
      const [proposalId, conflictId] = key.split(':') as [string, string]
      const proposal = developer.file.proposals.find((candidateProposal) => candidateProposal.proposal_id === proposalId)
      const conflict = proposal?.conflicts.find((candidateConflict) => candidateConflict.id === conflictId)
      if (conflict === undefined) {
        throw new Error(
          `fixture 元数据 gate2_plan.resolutions 指向不存在的冲突 ${key}（该提案只有 ${proposal?.conflicts.map((item) => item.id).join(', ') ?? '无'}）`,
        )
      }
      return { id: conflictId, proposal_id: proposalId, seed_ref: conflict.seed_ref, resolution }
    })
    return buildBlueprintBuilderInput(developer.file, {
      plan,
      userEdits,
      conflictResolutions,
      gate2ActionId: 'GATE2_001',
    })
  },
}

function listFixtureFiles(fixturesDir: string): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
}

export async function checkRecordedFixtures(options: FixtureToolOptions): Promise<FixtureCheckEntry[]> {
  const entries: FixtureCheckEntry[] = []
  for (const file of listFixtureFiles(options.fixturesDir)) {
    const filePath = join(options.fixturesDir, file)
    const interaction = parseRecordedInteraction(readFileSync(filePath, 'utf8'), filePath)
    const base = {
      file,
      contract: interaction.contract,
      actualSha256: interaction.input_sha256,
    }

    if (interaction.seed === undefined) {
      entries.push({
        ...base,
        seedFile: undefined,
        expectedSha256: undefined,
        ok: false,
        problem: '缺少 seed 字段：无法复核该 fixture 与 Seed 文本是否一致',
      })
      continue
    }

    const builder: InputBuilder | undefined = INPUT_BUILDERS[interaction.contract] ?? INPUT_BUILDERS_EXTRA[interaction.contract]
    if (builder === undefined) {
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: undefined,
        ok: false,
        problem: `契约 ${interaction.contract} 没有注册输入构造函数，无法复核哈希`,
      })
      continue
    }

    let rawInput: string
    try {
      rawInput = readFileSync(join(options.seedsDir, interaction.seed), 'utf8')
    } catch (error) {
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: undefined,
        ok: false,
        problem: `读取 Seed 文件失败：${(error as Error).message}`,
      })
      continue
    }

    try {
      const input = await builder({ interaction, rawInput, interpreterFixturesDir: options.interpreterFixturesDir })
      const expected = hashContractInput(interaction.contract, interaction.contract_version, input)
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: expected,
        ok: expected === interaction.input_sha256,
        problem:
          expected === interaction.input_sha256
            ? undefined
            : 'input_sha256 与当前 Seed 文本 / Gate 1 状态不一致，请运行 pnpm fixtures:refresh',
      })
    } catch (error) {
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: undefined,
        ok: false,
        problem: `重建输入失败：${(error as Error).message}`,
      })
    }
  }
  return entries
}

export async function refreshRecordedFixtures(
  options: FixtureToolOptions & { write: boolean },
): Promise<FixtureCheckEntry[]> {
  const entries = await checkRecordedFixtures(options)
  if (!options.write) return entries

  for (const entry of entries) {
    if (entry.ok || entry.expectedSha256 === undefined) continue
    const filePath = join(options.fixturesDir, entry.file)
    const text = readFileSync(filePath, 'utf8')
    const replaced = text.replace(/^input_sha256:.*$/m, `input_sha256: "${entry.expectedSha256}"`)
    if (replaced === text) {
      throw new Error(`无法在 ${filePath} 中定位 input_sha256 行`)
    }
    writeFileSync(filePath, replaced, 'utf8')
  }
  return checkRecordedFixtures(options)
}
