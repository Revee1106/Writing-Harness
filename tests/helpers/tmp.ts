import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures')
export const SEED_FIXTURES_DIR = join(FIXTURES_DIR, 'seeds')
export const GOLDEN_DIR = join(FIXTURES_DIR, 'golden')

export interface TempDir {
  readonly dir: string
  readonly cleanup: () => void
}

/** 测试专用临时目录；默认落在系统临时区，不污染仓库。 */
export function makeTempDir(prefix = 'harness-test-'): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
