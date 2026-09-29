import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（测试辅助；不依赖 import.meta.dirname 之外的行为）。 */
export const ROOT_WITH_PROMPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const RECORDED_FIXTURES_DIR = join(ROOT_WITH_PROMPTS, 'tests', 'fixtures', 'recorded', 'seed-interpreter')
export const SEEDS_DIR = join(ROOT_WITH_PROMPTS, 'tests', 'fixtures', 'seeds')
export const STORY2_SEEDS_DIR = join(SEEDS_DIR, 'story2')
export const PROMPTS_DIR = join(ROOT_WITH_PROMPTS, 'src', 'prompts')
