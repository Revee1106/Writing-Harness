#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRecordedFixtures, refreshRecordedFixtures } from '../src/providers/recorded-fixtures-tools.ts'

/**
 * 用法：
 *   pnpm fixtures:check     只检查 fixture 与 Seed 文本是否一致
 *   pnpm fixtures:refresh   把重算出的 input_sha256 写回 fixture
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = join(REPO_ROOT, 'tests', 'fixtures', 'recorded', 'seed-interpreter')
const seedsDir = join(REPO_ROOT, 'tests', 'fixtures', 'seeds')
const write = process.argv.includes('--write')

const entries = write
  ? refreshRecordedFixtures({ fixturesDir, seedsDir, write: true })
  : checkRecordedFixtures({ fixturesDir, seedsDir })

let failures = 0
for (const entry of entries) {
  const status = entry.ok ? 'OK  ' : 'FAIL'
  if (!entry.ok) failures += 1
  process.stdout.write(`${status} ${entry.file}${entry.seedFile === undefined ? '' : `  <- ${entry.seedFile}`}\n`)
  if (entry.problem !== undefined) {
    process.stdout.write(`     ${entry.problem}\n`)
  }
  if (!entry.ok && entry.expectedSha256 !== undefined) {
    process.stdout.write(`     fixture: ${entry.actualSha256}\n     seed   : ${entry.expectedSha256}\n`)
  }
}

process.stdout.write(`\n共 ${entries.length} 个 fixture，${failures} 个需要处理${write ? '（已写入）' : ''}\n`)
process.exitCode = failures === 0 || write ? 0 : 1
