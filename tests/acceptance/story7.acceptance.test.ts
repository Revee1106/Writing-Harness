import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkProseFormat,
  diffProjectState,
  runProseWriter,
  runProseWriterAll,
  snapshotProjectState,
} from '../../src/writer/writer.ts'
import { INNER_STATE_VERBS } from '../../src/writer/checks.ts'
import { compileContext } from '../../src/context/compiler.ts'
import { loadScenes } from '../../src/scenes/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { loadBlueprint, loadSeed } from '../../src/project/project.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { makeTempDir, REPO_ROOT, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR } from '../helpers/story4.ts'

/**
 * Story 7 验收测试（《开发 Story 拆分》Story 7「验收」）。
 *
 * 10 个 Scene（demo-01 与 demo-02 各 5 场）全部离线生成：
 * - Style Sample 不搬运实体；
 * - POV 不越界；
 * - 无 future leak；
 * - 无 state mutation；
 * - Scene End State 基本符合计划（软检查，语义深度留给 Story 9）。
 */

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-story7-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

function cloneProject(projectId: 'demo-01' | 'demo-02'): ReturnType<typeof projectPaths> {
  const root = tempRoot()
  cpSync(join(REPO_ROOT, 'projects', projectId), join(root.dir, projectId), { recursive: true })
  const paths = projectPaths(root.dir, projectId)
  rmSync(paths.draftsDir, { recursive: true, force: true })
  return paths
}

const proseProvider = (): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, 'prose_writer'))

describe('验收 A：至少 10 个 Scene 按序生成', () => {
  it('demo-01 与 demo-02 各 5 场，全部写出 drafts/scene-NNN.md', async () => {
    const written: Array<{ project: string; sceneId: string; codePoints: number }> = []
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = cloneProject(projectId)
      const all = await runProseWriterAll({ paths, provider: proseProvider() })
      expect(all.failures, projectId).toEqual([])
      expect(all.results).toHaveLength(5)
      for (const result of all.results) {
        expect(existsSync(result.draftPath), result.draftPath).toBe(true)
        written.push({ project: projectId, sceneId: result.sceneId, codePoints: result.countedCodePoints })
      }
      // drafts 目录只包含正文文件（不新增伴生文件）
      expect(readdirSync(paths.draftsDir).sort()).toEqual([
        'scene-001.md',
        'scene-002.md',
        'scene-003.md',
        'scene-004.md',
        'scene-005.md',
      ])
    }
    expect(written).toHaveLength(10)
    for (const entry of written) expect(entry.codePoints).toBeGreaterThan(50)
  })
})

describe('验收 B：无 future leak（硬）', () => {
  it('每场正文都不包含后续 Scene 的 purpose / end_state 关键短语', async () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = cloneProject(projectId)
      const all = await runProseWriterAll({ paths, provider: proseProvider() })
      for (const result of all.results) {
        expect(
          result.checks.hardFailures.filter((finding) => finding.code === 'FUTURE_LEAK'),
          `${projectId}/${result.sceneId}`,
        ).toEqual([])
      }
    }
  })
})

describe('验收 C：无未授权真相（硬）', () => {
  it('非 reveal 场不出现 truth 原文；reveal 场允许出现', async () => {
    const paths = cloneProject('demo-01')
    const blueprint = loadBlueprint(paths)
    const scenes = loadScenes(paths)
    const run = await runProseWriterAll({ paths, provider: proseProvider() })
    const revealSceneIds = scenes.filter((scene) => scene.allowed_reveals.length > 0).map((scene) => scene.scene_id)
    expect(revealSceneIds).toContain('scene-003')

    for (const result of run.results) {
      const text = readFileSync(result.draftPath, 'utf8')
      for (const knowledge of blueprint.key_knowledge) {
        if (result.sceneId === 'scene-003') continue
        expect(text.includes(knowledge.truth), `${result.sceneId} 不应含 ${knowledge.id} 原文`).toBe(false)
      }
      expect(result.checks.hardFailures.filter((finding) => finding.code === 'UNAUTHORIZED_TRUTH')).toEqual([])
    }
    // reveal 场确实用到了该真相的片段
    const revealDraft = readFileSync(join(paths.draftsDir, 'scene-003.md'), 'utf8')
    expect(revealDraft).toContain('没发出去')
  })
})

describe('验收 D：无 state mutation（硬）', () => {
  it('写作全程不修改 seed / config / proposals / blueprint / scenes / story_state / coverage', async () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = cloneProject(projectId)
      const before = snapshotProjectState(paths)
      await runProseWriterAll({ paths, provider: proseProvider() })
      const after = snapshotProjectState(paths)
      expect(diffProjectState(before, after), projectId).toEqual([])
    }
  })

  it('Writer 不修改 Blueprint / Scene 的字节内容', async () => {
    const paths = cloneProject('demo-01')
    const blueprintBefore = readFileSync(paths.blueprint, 'utf8')
    const sceneBefore = readFileSync(join(paths.scenesDir, 'scene-003.yaml'), 'utf8')
    await runProseWriterAll({ paths, provider: proseProvider() })
    expect(readFileSync(paths.blueprint, 'utf8')).toBe(blueprintBefore)
    expect(readFileSync(join(paths.scenesDir, 'scene-003.yaml'), 'utf8')).toBe(sceneBefore)
  })

  it('Story State 保持 occurred 为空、confirmed_scenes 为空（Writer 不产生事实）', async () => {
    const paths = cloneProject('demo-01')
    await runProseWriterAll({ paths, provider: proseProvider() })
    const state = JSON.parse(JSON.stringify(await import('../../src/scenes/service.ts').then((module) => module.loadStoryState(paths))))
    expect(state.occurred).toEqual([])
    expect(state.confirmed_scenes).toEqual([])
  })
})

describe('验收 E：POV 不越界（软检测 + 硬事实）', () => {
  it('正文不写非 POV 角色的内心（软检查只提示，不 fail）', async () => {
    for (const projectId of ['demo-01', 'demo-02'] as const) {
      const paths = cloneProject(projectId)
      const blueprint = loadBlueprint(paths)
      const run = await runProseWriterAll({ paths, provider: proseProvider() })
      for (const result of run.results) {
        const scene = loadScenes(paths).find((candidate) => candidate.scene_id === result.sceneId) as { pov: string }
        const text = readFileSync(result.draftPath, 'utf8')
        // 硬事实：非 POV 角色 name 与内心动词在同一 40 字窗口内共现的次数
        const findings = result.checks.warnings.filter((finding) => finding.code === 'POV_HEAD_HOPPING')
        for (const finding of findings) {
          expect(finding.severity).toBe('warning')
        }
        // 若软检查无发现，则确认正文没有把非 POV 角色的内心写成事实
        if (findings.length === 0) {
          for (const character of blueprint.characters) {
            if (character.id === scene.pov) continue
            const index = text.indexOf(character.name)
            if (index < 0) continue
            const window = text.slice(Math.max(0, index - 40), index + character.name.length + 40)
            for (const verb of INNER_STATE_VERBS) {
              if (window.includes(verb)) {
                throw new Error(`${result.sceneId}: ${character.name} 附近出现 ${verb} 但未被软检查捕获`)
              }
            }
          }
        }
      }
    }
  })

  it('核心上下文已物理排除非 POV 角色内心（Story 6 的硬过滤在 Writer 侧继续生效）', async () => {
    const paths = cloneProject('demo-01')
    const context = compileContext({ paths, sceneId: 'scene-001' })
    const man = context.writerContext.characters.find((character) => character.id === 'CH_MAN')
    expect(man?.inner_state).toBeUndefined()
    expect(context.manifest.excluded_sensitive.some((entry) => entry.reason === 'non_pov_inner_state')).toBe(true)
  })
})

describe('验收 F：Style Sample 不搬运实体', () => {
  it('de_entity=true 的样本：硬断言正文不含被去实体化的实体原值', async () => {
    const paths = cloneProject('demo-01')
    const run = await runProseWriterAll({ paths, provider: proseProvider() })
    let checkedSamples = 0
    for (const result of run.results) {
      const deEntitySamples = result.context.writerContext.style_samples.filter((sample) => sample.de_entity)
      checkedSamples += deEntitySamples.length
      expect(result.checks.hardFailures.filter((finding) => finding.code === 'DE_ENTITY_ENTITY_LEAK')).toEqual([])
    }
    expect(checkedSamples).toBeGreaterThan(0)
  })

  it('de_entity=false 的样本：不硬测，但产生"需人工复核"提示', async () => {
    const paths = cloneProject('demo-01')
    const run = await runProseWriterAll({ paths, provider: proseProvider() })
    const withReminder = run.results.filter((result) =>
      result.context.manifest.style_samples.some((sample) => sample.entity_reminder !== undefined),
    )
    expect(withReminder.length).toBeGreaterThan(0)
    for (const result of withReminder) {
      for (const sample of result.context.manifest.style_samples) {
        if (sample.entity_reminder !== undefined) {
          expect(sample.entity_reminder).toContain('人工复核')
        }
      }
    }
  })
})

describe('验收 G：Scene End State 基本符合计划（软） + 篇幅外部校验', () => {
  it('软检查已执行：End State 与篇幅都有结构化结论（不 fail）', async () => {
    const paths = cloneProject('demo-01')
    const run = await runProseWriterAll({ paths, provider: proseProvider() })
    for (const result of run.results) {
      expect(result.checks.hardFailures).toEqual([])
      expect(result.checks.lengthDeviationRatio).not.toBeNull()
      for (const finding of result.checks.warnings) {
        expect(finding.severity).toBe('warning')
        expect(['POV_HEAD_HOPPING', 'LENGTH_DEVIATION', 'END_STATE_MISSING', 'UNCONFIRMED_CONTENT_MENTION']).toContain(
          finding.code,
        )
      }
    }
    // 结构化的软结论：至少有一场因篇幅偏离给出 LENGTH_DEVIATION（fixture 正文刻意压缩）
    expect(run.results.some((result) => result.checks.warnings.some((finding) => finding.code === 'LENGTH_DEVIATION'))).toBe(true)
  })

  it('end_state 命中时不再报 END_STATE_MISSING（软检查是真实判定而非恒定输出）', async () => {
    const paths = cloneProject('demo-01')
    const scenes = loadScenes(paths)
    const scene = scenes[0] as { end_state: string }
    const context = compileContext({ paths, sceneId: 'scene-001' })
    const { checkProseConstraints } = await import('../../src/writer/checks.ts')
    const report = checkProseConstraints({
      text: `${scene.end_state}。`,
      scene: scenes[0] as never,
      blueprint: loadBlueprint(paths),
      context,
      scenes,
      seed: loadSeed(paths),
    })
    expect(report.warnings.some((finding) => finding.code === 'END_STATE_MISSING')).toBe(false)
  })
})

describe('验收 H：Draft Context 复用 Story 6 的选择器 + 输出纯正文', () => {
  it('第二场起都带 Draft Context，且正文通过纯正文格式校验', async () => {
    const paths = cloneProject('demo-02')
    const run = await runProseWriterAll({ paths, provider: proseProvider() })
    expect(run.results[0]?.context.writerContext.draft_context).toBeNull()
    for (const result of run.results.slice(1)) {
      expect(result.context.writerContext.draft_context?.scene_id).toBeTruthy()
      expect(result.context.writerContext.draft_context?.counted_code_points).toBeGreaterThan(0)
      expect(result.context.writerContext.draft_context?.counted_code_points).toBeLessThanOrEqual(600)
    }
    for (const result of run.results) {
      const text = readFileSync(result.draftPath, 'utf8')
      expect(checkProseFormat(text), result.sceneId).toEqual([])
      expect(text).not.toMatch(/^(#|---|text:|prose:)/m)
      expect(text).not.toContain('scene_id')
    }
  })

  it('单场写作与逐场写作结果一致（同一输入 → 同一正文）', async () => {
    const paths = cloneProject('demo-02')
    await runProseWriter({ paths, provider: proseProvider(), sceneId: 'scene-001' })
    const single = readFileSync(join(paths.draftsDir, 'scene-001.md'), 'utf8')
    rmSync(paths.draftsDir, { recursive: true, force: true })
    await runProseWriterAll({ paths, provider: proseProvider() })
    expect(readFileSync(join(paths.draftsDir, 'scene-001.md'), 'utf8')).toBe(single)
  })
})
