import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（src/eval → ../..）。仅用于 CLI 的默认路径解析。 */
export const REPO_ROOT_FALLBACK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
