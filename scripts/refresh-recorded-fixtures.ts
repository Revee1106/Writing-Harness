#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkRecordedFixtures,
  refreshRecordedFixtures,
  type FixtureCheckEntry,
} from '../src/providers/recorded-fixtures-tools.ts'

/**
 * 用法：
 *   pnpm fixtures:check     只检查 fixture 与 Seed 文本是否一致
 *   pnpm fixtures:refresh   把重算出的 input_sha256 写回 fixture
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const recordedRoot = join(REPO_ROOT, 'tests', 'fixtures', 'recorded')
const seedsDir = join(REPO_ROOT, 'tests', 'fixtures', 'seeds')
const write = process.argv.includes('--write')

/** 扫描 tests/fixtures/recorded 下的每个契约子目录（seed-interpreter / story_developer / ...）。 */
const interpreterFixturesDir = join(recordedRoot, 'seed-interpreter')
const fixtureDirs = readdirSync(recordedRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(recordedRoot, entry.name))
  .sort()

const all: FixtureCheckEntry[] = []
for (const fixturesDir of fixtureDirs) {
  const entries = write
    ? await refreshRecordedFixtures({ fixturesDir, seedsDir, interpreterFixturesDir, write: true })
    : await checkRecordedFixtures({ fixturesDir, seedsDir, interpreterFixturesDir })
  process.stdout.write(`\n[${fixturesDir.slice(REPO_ROOT.length + 1)}]\n`)
  for (const entry of entries) {
    const status = entry.ok ? 'OK  ' : 'FAIL'
    process.stdout.write(`${status} ${entry.file}${entry.seedFile === undefined ? '' : `  <- ${entry.seedFile}`}\n`)
    if (entry.problem !== undefined) process.stdout.write(`     ${entry.problem}\n`)
    if (!entry.ok && entry.expectedSha256 !== undefined) {
      process.stdout.write(`     fixture: ${entry.actualSha256}\n     seed   : ${entry.expectedSha256}\n`)
    }
  }
  all.push(...entries)
}

const failures = all.filter((entry) => !entry.ok).length
process.stdout.write(`\n共 ${all.length} 个 fixture，${failures} 个需要处理${write ? '（已写入）' : ''}\n`)
process.exitCode = failures === 0 || write ? 0 : 1
