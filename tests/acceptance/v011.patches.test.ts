import { cpSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { runGate2 } from '../../src/gate2/service.ts'
import { Gate2ConflictPendingError } from '../../src/gate2/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'

/**
 * v0.1.1 补丁回归测试（三项修复，各自独立断言）。
 *
 * 1. Gate 2 冲突提示必须用**冲突实际所属**的 `proposal_id`（原实现写死 `PROP_A`）；
 * 2. 无 Scene 时 `write` 必须报错并返回非 0（原实现输出"已写入 0 个 Draft"并返回 0）；
 * 3. 帮助文本的入口写法统一为 `pnpm harness <命令>`（原来是裸 `harness <命令>`）。
 *
 * 全部离线：Gate 2 用 recorded fixture，CLI 用子进程但只跑不触网的命令。
 */

function tempRoot(prefix: string): TempDir {
  const dir = makeTempDir(prefix)
  onTestFinished(() => {
    dir.cleanup()
  })
  return dir
}
/** 复制仓库里的 demo-01（Gate 2 可离线回放；其 PROP_B 带一条 pending 冲突）。 */
function cloneDemo01(): ReturnType<typeof projectPaths> {
  const root = tempRoot('harness-v011-')
  cpSync(join(REPO_ROOT, 'projects', 'demo-01'), join(root.dir, 'demo-01'), { recursive: true })
  return projectPaths(root.dir, 'demo-01')
}

/** 通过真实 CLI 入口跑一条命令，返回退出码与合并输出。 */
function runCli(
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): { readonly status: number; readonly output: string } {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'src', 'cli', 'index.ts'), ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

describe('修复 1：Gate 2 冲突提示的提案前缀', () => {
  it('冲突属于非首个提案（PROP_B）时，提示文本用 PROP_B 而不是 PROP_A', async () => {
    const paths = cloneDemo01()
    const provider = RecordedProvider.fromDirectory(join(REPO_ROOT, 'tests/fixtures/recorded/blueprint_builder'))

    // demo-01 的 PROP_B 带一条 pending 冲突（SEED_F003 的 ending）
    const error = await runGate2({ paths, provider, fromProposal: 'PROP_B' }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(Gate2ConflictPendingError)

    const detail = (error as Gate2ConflictPendingError).detail.join('\n')
    // 必须给出可执行的真键
    expect(detail).toContain('--resolve PROP_B:CONF_001=kept_user|changed_user|dropped')
    // 不能再出现猜出来的 PROP_A:CONF_001
    expect(detail).not.toContain('PROP_A:CONF_001')
    // 每条待裁决冲突都各自带自己的键（键与标签一致）
    for (const line of detail.split('\n')) {
      const label = line.match(/^(PROP_[A-Z0-9]+):(CONF_\d{3})/u)
      if (label === null) continue
      expect(line).toContain(`--resolve ${label[1]}:${label[2]}=`)
    }
  })

  it('CLI 层面同样给出正确的键（端到端，exit 非 0）', () => {
    const root = tempRoot('harness-v011-cli-')
    cpSync(join(REPO_ROOT, 'projects', 'demo-01'), join(root.dir, 'demo-01'), { recursive: true })
    const { status, output } = runCli(['gate2', 'demo-01', '--projects-root', root.dir, '--from', 'PROP_B'])
    expect(status).not.toBe(0)
    expect(output).toContain('--resolve PROP_B:CONF_001=')
    expect(output).not.toContain('PROP_A:CONF_001')
  })
})

describe('修复 2：无 Scene 时 write 的退出码与提示', () => {
  it('空 scenes 目录下跑 write：exit 非 0，且提示 No scenes found; run breakdown first', () => {
    const root = tempRoot('harness-v011-noscene-')
    // 造一个"只有 seed、没有 scenes"的项目（不动 plots/ 里的 demo）
    const init = runCli(['init', 'empty-story', '--projects-root', root.dir, '--seed', '一个很短的种子。'])
    expect(init.status).toBe(0)
    mkdirSync(join(root.dir, 'empty-story', 'scenes'), { recursive: true })

    const { status, output } = runCli(['write', 'empty-story', '--projects-root', root.dir])
    expect(status).not.toBe(0)
    expect(output).toContain('No scenes found; run breakdown first')
    // 不能再说"已写入 0 个 Draft"
    expect(output).not.toContain('已写入 0 个 Draft')
  })

  it('有 Scene 的项目不受影响（回归保护）：write --plan 正常返回 0', () => {
    const root = tempRoot('harness-v011-hasnnscene-')
    cpSync(join(REPO_ROOT, 'projects', 'demo-01'), join(root.dir, 'demo-01'), { recursive: true })
    const { status, output } = runCli(['write', 'demo-01', '--projects-root', root.dir, '--plan'])
    expect(status).toBe(0)
    expect(output).toContain('scene-001')
    expect(output).not.toContain('No scenes found')
  })

  it('--scene 指向单场时同样先检查 Scene 是否存在（不静默通过）', () => {
    const root = tempRoot('harness-v011-noscene2-')
    const init = runCli(['init', 'empty-story-2', '--projects-root', root.dir, '--seed', '又一个很短的种子。'])
    expect(init.status).toBe(0)
    const { status, output } = runCli([
      'write',
      'empty-story-2',
      '--projects-root',
      root.dir,
      '--scene',
      'scene-001',
    ])
    expect(status).not.toBe(0)
    expect(output).toContain('No scenes found; run breakdown first')
  })
})

describe('修复 3：帮助文本的入口写法', () => {
  it('帮助输出不含裸 harness 前缀，且明确给出 pnpm harness 入口', () => {
    const { status, output } = runCli(['help'])
    expect(status).toBe(0)
    expect(output).toContain('pnpm harness init')
    // 逐行检查：任何一行都不能以裸 `harness` 开头（大小写敏感）
    const offenders = output
      .split('\n')
      .filter((line) => /^\s*harness\s/u.test(line))
    expect(offenders).toEqual([])
    // 常见命令的入口都必须写成 pnpm harness
    for (const command of ['init', 'gate1', 'gate2', 'breakdown', 'write', 'lint', 'rewrite', 'gate3', 'help']) {
      expect(output).toContain(`pnpm harness ${command}`)
    }
  })

  it('`--help` 与 `help` 输出一致（同一份文本）', () => {
    const viaHelp = runCli(['help'])
    const viaFlag = runCli(['--help'])
    expect(viaFlag.status).toBe(0)
    expect(viaFlag.output).toBe(viaHelp.output)
  })
})
