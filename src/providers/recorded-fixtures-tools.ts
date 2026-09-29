import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashContractInput } from '../core/hash.ts'
import { parseRecordedInteraction } from './recorded.ts'

/**
 * recorded fixture 的哈希复核工具（Story 2）。
 *
 * 每个 fixture 都声明它对应的 Seed 文件（`seed: story2/01-emotion.txt`）；
 * 本工具据此重算 `input_sha256`，保证 **fixture 与 Seed 文本不会静默漂移**：
 * - `check`：只检查，不写入（测试用）；
 * - `refresh`：把哈希写回 fixture 文件（Seed 文本调整后使用）。
 */

export interface FixtureCheckEntry {
  readonly file: string
  readonly seedFile: string | undefined
  readonly expectedSha256: string | undefined
  readonly actualSha256: string | undefined
  readonly ok: boolean
  readonly problem?: string | undefined
}

export interface FixtureToolOptions {
  readonly fixturesDir: string
  readonly seedsDir: string
}

function listFixtureFiles(fixturesDir: string): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
}

export function checkRecordedFixtures(options: FixtureToolOptions): FixtureCheckEntry[] {
  return listFixtureFiles(options.fixturesDir).map((file) => {
    const filePath = join(options.fixturesDir, file)
    const text = readFileSync(filePath, 'utf8')
    const interaction = parseRecordedInteraction(text, filePath)
    if (interaction.seed === undefined) {
      return {
        file,
        seedFile: undefined,
        expectedSha256: undefined,
        actualSha256: interaction.input_sha256,
        ok: false,
        problem: '缺少 seed 字段：无法复核该 fixture 与 Seed 文本是否一致',
      }
    }
    const seedPath = join(options.seedsDir, interaction.seed)
    let expected: string
    try {
      const rawInput = readFileSync(seedPath, 'utf8')
      expected = hashContractInput(interaction.contract, interaction.contract_version, { raw_input: rawInput })
    } catch (error) {
      return {
        file,
        seedFile: interaction.seed,
        expectedSha256: undefined,
        actualSha256: interaction.input_sha256,
        ok: false,
        problem: `读取 Seed 文件失败：${seedPath}（${(error as Error).message}）`,
      }
    }
    return {
      file,
      seedFile: interaction.seed,
      expectedSha256: expected,
      actualSha256: interaction.input_sha256,
      ok: expected === interaction.input_sha256,
      problem: expected === interaction.input_sha256 ? undefined : 'input_sha256 与 Seed 文本不一致，请运行 pnpm fixtures:refresh',
    }
  })
}

export function refreshRecordedFixtures(options: FixtureToolOptions & { write: boolean }): FixtureCheckEntry[] {
  const entries = checkRecordedFixtures(options)
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
