import { cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'

/**
 * v0.1.2 补丁回归测试：锁定 `--provider auto` 的真实行为。
 *
 * 背景（v0.1.1 实测发现、v0.1.2 文档化）：`--provider` 不写时默认 `auto`，
 * 而 CLI 总会提供内置 recorded fixtures 目录，因此 **`auto` 恒等于 `recorded`**。
 * 即使设置了 `HARNESS_LLM_*` 环境变量，也不会走真实模型——这是**刻意的锁定**：
 * 如果将来把 `auto` 改成"有 env 就用 openai-compat"，本测试会失败，提醒同步更新文档。
 *
 * 测试用子进程跑真实 CLI，但不联网：
 * - 未加 `--provider`：必须回放 recorded（`provider=recorded`）；
 * - 加了 `--provider openai-compat`：必须真的尝试连模型（用未监听端口触发网络层失败）；
 * - 帮助文本必须写明 `auto` 的当前语义。
 */

function tempRoot(): TempDir {
  const dir = makeTempDir('harness-v012-')
  onTestFinished(() => {
    dir.cleanup()
  })
  return dir
}

function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): { readonly status: number; readonly output: string } {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'src', 'cli', 'index.ts'), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('v0.1.2：auto 行为锁定 + 帮助文本措辞', () => {
  it('设了 HARNESS_LLM_* 但不加 --provider → 仍然走 recorded；加了 --provider 才连模型；帮助文本已写明该语义', () => {
    // 准备一个可离线回放的项目（demo-01 的 develop 有 recorded fixture）
    const root = tempRoot()
    cpSync(join(REPO_ROOT, 'projects', 'demo-01'), join(root.dir, 'demo-01'), { recursive: true })

    // 环境变量全部设好（指向一个不存在的本地端口，确保"真的连了"会被看出来）
    const env = {
      HARNESS_LLM_BASE_URL: 'http://127.0.0.1:9/v1',
      HARNESS_LLM_MODEL: 'deepseek-flash',
      HARNESS_LLM_API_KEY: 'sk-test',
      HARNESS_LLM_TIMEOUT_MS: '5000',
    }

    // 阶段 1：不加 --provider（默认 auto）→ 必须仍然回放 recorded，不碰网络
    const withoutFlag = runCli(['develop', 'demo-01', '--plan', '--projects-root', root.dir], env)
    expect(withoutFlag.status).toBe(0)
    expect(withoutFlag.output).toContain('provider=recorded')
    expect(withoutFlag.output).not.toContain('fetch failed')
    expect(withoutFlag.output).not.toContain('LLM 请求失败')

    // 阶段 2：显式加 --provider openai-compat → 必须真的尝试调用模型（未监听端口 → 网络层失败）
    const withFlag = runCli(
      ['develop', 'demo-01', '--plan', '--provider', 'openai-compat', '--projects-root', root.dir],
      env,
    )
    expect(withFlag.status).not.toBe(0)
    expect(withFlag.output).not.toContain('provider=recorded')
    expect(
      withFlag.output.includes('fetch failed') || withFlag.output.includes('LLM 请求失败'),
      `期望出现网络层失败提示，实际输出：${withFlag.output.slice(0, 200)}`,
    ).toBe(true)

    // 阶段 3：帮助文本必须写明 auto 的当前语义（防止文档再次漂移）
    const help = runCli(['help'])
    expect(help.status).toBe(0)
    expect(help.output).toContain('auto')
    expect(help.output).toContain('恒等于 recorded')
    expect(help.output).toContain('--provider openai-compat')
  })
})
