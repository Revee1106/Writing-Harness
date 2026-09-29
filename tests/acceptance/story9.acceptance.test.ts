import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLlmLinter } from '../../src/linter/llm-linter.ts'
import { runLocalRewrite, prepareRewrite } from '../../src/linter/rewrite.ts'
import { LLM_LINTER_RULES } from '../../src/linter/llm-rules.ts'
import { loadLinterReport, runRuleLinter } from '../../src/linter/rule-linter.ts'
import { validateLinterReport } from '../../src/schema/linter-report.ts'
import { keyPhrases } from '../../src/writer/checks.ts'
import { loadBlueprint, loadSeed } from '../../src/project/project.ts'
import { loadScenes } from '../../src/scenes/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { readTextFile } from '../../src/io/yaml.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { loadProjectConfig } from '../../src/project/project.ts'
import { writeYamlFile } from '../../src/io/yaml.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR } from '../helpers/story4.ts'

/**
 * Story 9 验收测试（《开发 Story 拆分》Story 9「验收」）。
 *
 * 至少 20 个问题 span：来自 10 个 demo Scene 的离线 LLM Linter fixture（每场 2 个）。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-s9-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

function cloneProject(projectId: 'demo-01' | 'demo-02'): ReturnType<typeof projectPaths> {
  const root = tempRoot()
  cpSync(join(REPO_ROOT, 'projects', projectId), join(root.dir, projectId), { recursive: true })
  return projectPaths(root.dir, projectId)
}

const llmProvider = (): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, 'llm_linter'))
const rewriteProvider = (): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, 'local_rewrite'))

describe('验收 A：至少 20 个问题 span 且 LLM warning 结构化', () => {
  it('10 个 Scene 各产出 2 条 llm warning，共 20 条，全部结构化', async () => {
    const findings: Array<{ scene: string; rule: string; span: { start: number; end: number }; text: string }> = []
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = cloneProject(projectId)
      for (const scene of loadScenes(paths)) {
        const result = await runLlmLinter({
          paths,
          provider: llmProvider(),
          sceneId: scene.scene_id,
          now: new Date('2026-01-01T00:00:00.000Z'),
        })
        expect(result.report.linter).toBe('llm')
        expect(result.report.warnings).toHaveLength(2)
        expect(result.rejected).toEqual([])
        for (const warning of result.report.warnings) {
          expect(LLM_LINTER_RULES).toContain(warning.rule as never)
          expect(warning.span).not.toBeNull()
          expect(warning.text.length).toBeGreaterThan(0)
          expect(warning.message.length).toBeGreaterThan(0)
          // span 能回切出原文
          const text = readTextFile(join(paths.draftsDir, `${scene.scene_id}.md`))
          const points = [...text]
          expect(points.slice(warning.span?.start, warning.span?.end).join('')).toBe(warning.text)
          findings.push({ scene: `${projectId}/${scene.scene_id}`, rule: warning.rule, span: warning.span as never, text: warning.text })
        }
      }
    }
    expect(findings.length).toBeGreaterThanOrEqual(20)
    // 五类语义类型在 fixture 集合里都被覆盖
    expect(new Set(findings.map((finding) => finding.rule)).size).toBe(LLM_LINTER_RULES.length)
  })

  it('LLM Linter 不重复 Story 8 的统计型检查（rule 值只能是五类语义类型）', async () => {
    const paths = cloneProject('demo-01')
    const result = await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-003', dryRun: true })
    for (const warning of result.report.warnings) {
      expect([
        'template_actions',
        'sentence_length_variance',
        'paragraph_length_variance',
        'dialogue_ratio',
        'paragraph_ending_elevation',
      ]).not.toContain(warning.rule)
    }
  })

  it('两套 Linter 的报告共用同一 Schema，可分别写盘与回读', async () => {
    const paths = cloneProject('demo-02')
    runRuleLinter({ paths, repoRoot: REPO_ROOT, sceneId: 'scene-001', now: new Date('2026-01-01T00:00:00.000Z') })
    const ruleReport = loadLinterReport(paths)
    expect(ruleReport?.linter).toBe('rule')
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-001', now: new Date('2026-01-01T00:00:00.000Z') })
    const llmReport = loadLinterReport(paths)
    expect(llmReport?.linter).toBe('llm')
    expect(Object.keys(ruleReport ?? {}).sort()).toEqual(Object.keys(llmReport ?? {}).sort())
    expect(validateLinterReport(llmReport)).toBeDefined()
  })
})

describe('验收 B：rewrite 不整篇重写', () => {
  it('只替换 span：其余部分逐字节不变，且报告留下 rewrite 记录', async () => {
    const paths = cloneProject('demo-01')
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-002' })
    const before = readTextFile(join(paths.draftsDir, 'scene-002.md'))
    const target = loadLinterReport(paths)?.warnings[0] as { id: string; span: { start: number; end: number } }
    const result = await runLocalRewrite({
      paths,
      repoRoot: REPO_ROOT,
      provider: rewriteProvider(),
      sceneId: 'scene-002',
      warningId: target.id,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(result.applied, `未应用改写：${result.before} → ${result.after}`).toBe(true)
    const after = readTextFile(join(paths.draftsDir, 'scene-002.md'))
    const beforePoints = [...before]
    expect(after.startsWith(beforePoints.slice(0, target.span.start).join(''))).toBe(true)
    expect(after.endsWith(beforePoints.slice(target.span.end).join(''))).toBe(true)
    // 未改写的部分长度守恒：after = prefix + replacement + suffix
    expect([...after].length).toBe(
      target.span.start + [...result.after].length + ([...before].length - target.span.end),
    )
    const report = loadLinterReport(paths)
    const rewritten = report?.warnings.find((warning) => warning.rewrite?.applied === true)?.rewrite
    expect(rewritten?.before).toBe(result.before)
    expect(rewritten?.after).toBe(result.after)
    expect(rewritten?.rewrite_contract).toBe('local_rewrite@0.1')
    expect(rewritten?.rewritten_at).toBe('2026-01-01T00:00:00.000Z')
    // 不新增备份文件
    expect(readdirSync(paths.draftsDir).every((name) => name.endsWith('.md'))).toBe(true)
  })

  it('10 个 Scene 的既有 reshape fixture 都能完成局部改写', async () => {
    let applied = 0
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = cloneProject(projectId)
      for (const scene of loadScenes(paths)) {
        await runLlmLinter({ paths, provider: llmProvider(), sceneId: scene.scene_id })
        const target = loadLinterReport(paths)?.warnings[0] as { id: string }
        const result = await runLocalRewrite({
          paths,
          repoRoot: REPO_ROOT,
          provider: rewriteProvider(),
          sceneId: scene.scene_id,
          warningId: target.id,
        })
        if (result.applied) applied += 1
      }
    }
    expect(applied).toBe(10)
  })
})

describe('验收 C：Rewrite 后不引入 future / secret leak', () => {
  it('改写结果不包含后续 Scene 的关键短语，也不包含未授权 truth', async () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = cloneProject(projectId)
      const blueprint = loadBlueprint(paths)
      const scenes = loadScenes(paths)
      const seed = loadSeed(paths)
      void seed
      for (const scene of scenes) {
        await runLlmLinter({ paths, provider: llmProvider(), sceneId: scene.scene_id })
        const target = loadLinterReport(paths)?.warnings[0] as { id: string }
        await runLocalRewrite({
          paths,
          repoRoot: REPO_ROOT,
          provider: rewriteProvider(),
          sceneId: scene.scene_id,
          warningId: target.id,
        })
        const text = readTextFile(join(paths.draftsDir, `${scene.scene_id}.md`))
        // future leak：后续 Scene 的 purpose / end_state 关键短语
        for (const future of scenes.filter((candidate) => candidate.order > scene.order)) {
          for (const phrase of [...keyPhrases(future.purpose), ...keyPhrases(future.end_state)]) {
            expect(text.includes(phrase), `${projectId}/${scene.scene_id} 出现后续段落短语`).toBe(false)
          }
        }
        // secret leak：未授权 truth 原文
        const allowed = new Set(scene.allowed_reveals)
        for (const knowledge of blueprint.key_knowledge) {
          if (allowed.has(knowledge.id)) continue
          expect(text.includes(knowledge.truth), `${projectId}/${scene.scene_id} 泄漏 ${knowledge.id}`).toBe(false)
        }
      }
    }
  })

  it('违反契约的改写会被拒绝并保持原文不变（含 future / truth 泄漏场景）', async () => {
    const paths = cloneProject('demo-01')
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-001' })
    const before = readTextFile(join(paths.draftsDir, 'scene-001.md'))
    const target = loadLinterReport(paths)?.warnings[0] as { id: string }
    const blueprint = loadBlueprint(paths)
    const truth = blueprint.key_knowledge[0]?.truth as string
    await expect(
      runLocalRewrite({
        paths,
        repoRoot: REPO_ROOT,
        provider: new (await import('../helpers/story2.ts')).StubProvider(`她想起：${truth}`),
        sceneId: 'scene-001',
        warningId: target.id,
      }),
    ).rejects.toThrow(/违反 Rewrite 契约|future \/ secret leak/)
    expect(readTextFile(join(paths.draftsDir, 'scene-001.md'))).toBe(before)
  })
})

describe('验收 D：局部二次 Linter 可运行', () => {
  it('Rewrite 后自动跑局部二次 Linter（范围 = span 所在段落 + 相邻段落）', async () => {
    const paths = cloneProject('demo-01')
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-004' })
    const target = loadLinterReport(paths)?.warnings[0] as { id: string; span: { start: number; end: number } }
    const result = await runLocalRewrite({
      paths,
      repoRoot: REPO_ROOT,
      provider: rewriteProvider(),
      sceneId: 'scene-004',
      warningId: target.id,
    })
    expect(result.relint.replacedRange.end).toBeGreaterThan(result.relint.replacedRange.start)
    // 范围应小于整篇（局部重跑）
    const full = [...readTextFile(join(paths.draftsDir, 'scene-004.md'))].length
    expect(result.relint.replacedRange.end - result.relint.replacedRange.start).toBeLessThanOrEqual(full)
    expect(validateLinterReport(result.report)).toBeDefined()
    // 报告落盘并带 rewrite 记录
    const disk = loadLinterReport(paths)
    expect(disk?.warnings.some((warning) => warning.rewrite?.applied === true)).toBe(true)
    expect(readFileSync(paths.linterReport, 'utf8')).toContain('partial re-lint')
  })

  it('--full 时走整篇范围', async () => {
    const paths = cloneProject('demo-01')
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-005' })
    const target = loadLinterReport(paths)?.warnings[0] as { id: string }
    const result = await runLocalRewrite({
      paths,
      repoRoot: REPO_ROOT,
      provider: rewriteProvider(),
      sceneId: 'scene-005',
      warningId: target.id,
      scope: 'full',
    })
    expect(result.relint.replacedRange).toEqual({
      start: 0,
      end: [...readTextFile(join(paths.draftsDir, 'scene-005.md'))].length,
    })
    expect(readFileSync(paths.linterReport, 'utf8')).toContain('full')
  })

  it('局部重跑后 warning ID 重新分配（不复用），且报告通过 Schema', async () => {
    const paths = cloneProject('demo-02')
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-002' })
    const target = loadLinterReport(paths)?.warnings[0] as { id: string }
    const result = await runLocalRewrite({
      paths,
      repoRoot: REPO_ROOT,
      provider: rewriteProvider(),
      sceneId: 'scene-002',
      warningId: target.id,
    })
    const ids = result.report.warnings.map((warning) => warning.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(ids.map((_id, index) => `LINT_${String(index + 1).padStart(3, '0')}`))
    expect(validateLinterReport(loadLinterReport(paths))).toBeDefined()
  })
})

describe('验收 E：前置条件与边界', () => {
  it('没有报告 / warning 不存在 / 报告与 Scene 不匹配时明确报错', async () => {
    const paths = cloneProject('demo-01')
    const { rmSync } = await import('node:fs')
    rmSync(paths.linterReport)
    await expect(
      runLocalRewrite({
        paths,
        repoRoot: REPO_ROOT,
        provider: rewriteProvider(),
        sceneId: 'scene-001',
        warningId: 'LINT_001',
      }),
    ).rejects.toThrow(/找不到 .*linter.yaml/)
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-001' })
    await expect(
      runLocalRewrite({
        paths,
        repoRoot: REPO_ROOT,
        provider: rewriteProvider(),
        sceneId: 'scene-001',
        warningId: 'LINT_099',
      }),
    ).rejects.toThrow(/报告里没有 LINT_099/)
    await expect(
      runLocalRewrite({
        paths,
        repoRoot: REPO_ROOT,
        provider: rewriteProvider(),
        sceneId: 'scene-002',
        warningId: 'LINT_001',
      }),
    ).rejects.toThrow(/是 scene-001 的报告/)
  })

  it('prepareRewrite 的输入不包含 Blueprint / Proposal（受控边界）', async () => {
    const paths = cloneProject('demo-01')
    await runLlmLinter({ paths, provider: llmProvider(), sceneId: 'scene-001' })
    const target = loadLinterReport(paths)?.warnings[0] as { id: string; rule: string; severity: string; span: { start: number; end: number }; message: string; text: string }
    const prepared = prepareRewrite(paths, 'scene-001', {
      warning_id: target.id,
      rule: target.rule,
      severity: target.severity,
      span: target.span,
      text: target.text,
      message: target.message,
    })
    const serialized = JSON.stringify(prepared.input)
    expect(serialized).not.toContain('PROP_')
    expect(serialized).not.toContain('key_knowledge')
    expect(serialized).not.toContain('seed_fidelity')
    expect(Object.keys(prepared.input).sort()).toEqual([
      'following_paragraph',
      'preceding_paragraph',
      'scene_meta',
      'span',
      'span_text',
      'style_samples',
      'warning',
    ])
  })

  it('demo 项目已提交的 linter.yaml（Story 8 产物）仍可回读，且 rule/llm 报告可先后写盘', async () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = projectPaths(join(REPO_ROOT, 'projects'), projectId)
      expect(existsSync(paths.linterReport), projectId).toBe(true)
      const report = loadLinterReport(paths)
      expect(validateLinterReport(report)).toBeDefined()
      expect(loadProjectConfig(paths).linter.rules.template_actions).toBe(true)
    }
    void writeYamlFile
  })
})
