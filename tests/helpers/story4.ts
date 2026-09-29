import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RECORDED_FIXTURES_DIR as INTERPRETER_FIXTURES_DIR, SEEDS_DIR as SEEDS_ROOT } from './story2.ts'

/** recorded fixture 根目录（其下按契约分目录：seed-interpreter / story_developer / blueprint_builder）。 */
export const RECORDED_DIR = dirname(INTERPRETER_FIXTURES_DIR)
export const SEEDS_DIR = SEEDS_ROOT

export function readSeedText(relativePath: string): string {
  return readFileSync(join(SEEDS_DIR, relativePath), 'utf8')
}
