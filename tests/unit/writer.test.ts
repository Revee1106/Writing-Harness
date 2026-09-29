import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProseWriterInput,
  checkProseFormat,
  diffProjectState,
  ProseWriterError,
  runProseWriter,
  runProseWriterAll,
  snapshotProjectState,
} from '../../src/writer/writer.ts'
import {
  checkProseConstraints,
  extractDeEntityRedactions,
  keyPhrases,
} from '../../src/writer/checks.ts'
import { compileContext } from '../../src/context/compiler.ts'
import { loadScenes } from '../../src/scenes/service.ts'
import { projectPaths } from '../../src/io/paths.ts'
import { loadBlueprint, loadSeed } from '../../src/project/project.ts'
import { RecordedProvider } from '../../src/providers/recorded.ts'
import { StubProvider } from '../helpers/story2.ts'
import { makeTempDir, type TempDir } from '../helpers/tmp.ts'
import { RECORDED_DIR } from '../helpers/story4.ts'
import { REPO_ROOT } from '../helpers/tmp.ts'

const tempDirs: TempDir[] = []
function tempRoot(): TempDir {
  const dir = makeTempDir('harness-writer-')
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) tempDirs.pop()?.cleanup()
})

/** 把已提交的 demo 项目复制到临时目录（测试不修改仓库）。 */
function cloneDemoProject(projectId: 'demo-01' | 'demo-02'): ReturnType<typeof projectPaths> {
  const root = tempRoot()
  cpSync(join(REPO_ROOT, 'projects', projectId), join(root.dir, projectId), { recursive: true })
  return projectPaths(root.dir, projectId)
}

const proseProvider = (): RecordedProvider => RecordedProvider.fromDirectory(join(RECORDED_DIR, 'prose_writer'))

describe('Prose Writer 输出格式（纯正文）', () => {
  it('正常正文不产生格式问题', () => {
    expect(checkProseFormat('她把碗推到他面前。\n\n他没有动。')).toEqual([])
  })

  it('YAML 包裹 / 标题 / 分隔符 / 元数据都会被抓出', () => {
    expect(checkProseFormat('text: 正文').map((violation) => violation.code)).toContain('YAML_WRAPPER')
    expect(checkProseFormat('```\n正文\n```').map((violation) => violation.code)).toContain('YAML_WRAPPER')
    expect(checkProseFormat('# 第一场\n正文').map((violation) => violation.code)).toContain('TITLE_LINE')
    expect(checkProseFormat('正文\n\n---\n\n更多').map((violation) => violation.code)).toContain('SEPARATOR_LINE')
    expect(checkProseFormat('scene_id: scene-001\n正文').map((violation) => violation.code)).toContain('METADATA_LINE')
  })

  it('违约输出会被 Writer 拒绝（不落盘）', async () => {
    const paths = cloneDemoProject('demo-01')
    rmSync(paths.draftsDir, { recursive: true, force: true })
    await expect(
      runProseWriter({ paths, provider: new StubProvider('text: 这是 YAML 包裹的正文'), sceneId: 'scene-001' }),
    ).rejects.toBeInstanceOf(ProseWriterError)
    expect(existsSync(join(paths.draftsDir, 'scene-001.md'))).toBe(false)
  })
})

describe('去实体化实体泄漏检测（Story 7 裁决）', () => {
  it('从 text → sanitized_text 的差异里提取实体原值', () => {
    const redactions = extractDeEntityRedactions(
      '"那就分吧。"她说完就低头喝汤，汤已经不烫了。',
      '[CHAR_A]说完了就低头喝汤，汤已经不烫了。',
    )
    expect(redactions.length).toBeGreaterThan(0)
    expect(redactions.join('')).toContain('就分吧')
  })

  it('完全相同的文本不产生被删片段', () => {
    expect(extractDeEntityRedactions('同一段文字。', '同一段文字。')).toEqual([])
  })

  it('de_entity=true 的样本实体出现在正文中 → 硬失败；de_entity=false 不硬测', async () => {
    const paths = cloneDemoProject('demo-01')
    const scene = loadScenes(paths).find((candidate) => candidate.scene_id === 'scene-001') as never
    const blueprint = loadBlueprint(paths)
    const seed = loadSeed(paths)
    const context = compileContext({ paths, sceneId: 'scene-001' })
    const base = { scene, blueprint, context, scenes: loadScenes(paths), seed }

    // SAMPLE_002 是 de_entity=true 的样本，其被删片段不得出现在正文中
    const leaked = checkProseConstraints({
      ...base,
      text: '"那就分吧。"她说完就低头喝汤。',
      originalSamples: [
        {
          sample_id: 'SAMPLE_002',
          tags: { pov: 'CH_WOMAN', scene_type: 'dialogue', tone: 'conflict' },
          text: '"那就分吧。"她说完就低头喝汤，汤已经不烫了。',
          de_entity: true,
          sanitized_text: '[CHAR_A]说完了就低头喝汤，汤已经不烫了。',
        },
      ],
    })
    expect(leaked.hardFailures.some((finding) => finding.code === 'DE_ENTITY_ENTITY_LEAK')).toBe(true)

    // de_entity=false 的样本不参与实体硬测
    const notDeEntity = checkProseConstraints({
      ...base,
      text: '她把手机翻了个面，屏幕朝下。',
      originalSamples: [
        {
          sample_id: 'SAMPLE_001',
          tags: { pov: 'CH_WOMAN', scene_type: 'interior', tone: 'restraint' },
          text: '她把手机翻了个面，屏幕朝下。',
          de_entity: false,
        },
      ],
    })
    expect(notDeEntity.hardFailures).toEqual([])
  })
})

describe('Writer 约束检查（硬 / 软）', () => {
  async function contextFor(sceneId: string): Promise<{
    paths: ReturnType<typeof projectPaths>
    input: Parameters<typeof checkProseConstraints>[0]
  }> {
    const paths = cloneDemoProject('demo-01')
    const scenes = loadScenes(paths)
    const scene = scenes.find((candidate) => candidate.scene_id === sceneId) as never
    const context = compileContext({ paths, sceneId })
    return {
      paths,
      input: { text: '', scene, blueprint: loadBlueprint(paths), context, scenes, seed: loadSeed(paths) },
    }
  }

  it('硬：写入后续 Scene 的关键短语 → FUTURE_LEAK', async () => {
    const { input } = await contextFor('scene-001')
    const future = [...(input.scenes as readonly { order: number; end_state: string }[])].find((scene) => scene.order === 5)
    const report = checkProseConstraints({ ...input, text: `她走了。${future?.end_state as string}` })
    expect(report.hardFailures.some((finding) => finding.code === 'FUTURE_LEAK')).toBe(true)
  })

  it('硬：写入未授权真相原文 → UNAUTHORIZED_TRUTH；reveal 场则放行', async () => {
    const { paths, input } = await contextFor('scene-001')
    const truth = loadBlueprint(paths).key_knowledge[0]?.truth as string
    const report = checkProseConstraints({ ...input, text: `他想起：${truth}` })
    expect(report.hardFailures.some((finding) => finding.code === 'UNAUTHORIZED_TRUTH')).toBe(true)

    const revealInput = (await contextFor('scene-003')).input
    const revealReport = checkProseConstraints({ ...revealInput, text: `她读到了那句话：${truth}` })
    expect(revealReport.hardFailures.filter((finding) => finding.code === 'UNAUTHORIZED_TRUTH')).toEqual([])
  })

  it('软：非 POV 角色 name 与内心动词共现 → POV_HEAD_HOPPING（不 fail）', async () => {
    const { paths, input } = await contextFor('scene-001')
    const other = loadBlueprint(paths).characters.find(
      (character) => character.id !== (input.scene as { pov: string }).pov,
    )
    const report = checkProseConstraints({ ...input, text: `${other?.name as string}心里想着，这件事不值得吵。` })
    expect(report.hardFailures).toEqual([])
    expect(report.warnings.some((finding) => finding.code === 'POV_HEAD_HOPPING')).toBe(true)
  })

  it('软：篇幅偏离与 end_state 缺失都是 warning', async () => {
    const { input } = await contextFor('scene-001')
    const report = checkProseConstraints({ ...input, text: '很短。' })
    const codes = report.warnings.map((finding) => finding.code)
    expect(codes).toContain('LENGTH_DEVIATION')
    expect(codes).toContain('END_STATE_MISSING')
    expect(report.hardFailures).toEqual([])
    expect(report.lengthDeviationRatio).toBeLessThan(0.5)
  })

  it('keyPhrases 只取足够长的片段（避免误报）', () => {
    // 默认阈值 4 个码点：短语过短会被丢弃（保守，避免误报）
    expect(keyPhrases('她走了，没有回头。')).toEqual(['没有回头'])
    expect(keyPhrases('她拖着箱子，没有回头。')).toEqual(['她拖着箱子', '没有回头'])
    expect(keyPhrases('好。')).toEqual([])
  })
})

describe('Writer 服务：落盘、状态不变、按序写作', () => {
  it('写出 drafts/scene-NNN.md，内容与 fixture 一致，且不新增伴生文件', async () => {
    const paths = cloneDemoProject('demo-01')
    rmSync(paths.draftsDir, { recursive: true, force: true })
    const result = await runProseWriter({ paths, provider: proseProvider(), sceneId: 'scene-001' })
    expect(result.written).toBe(true)
    expect(result.draftPath).toBe(join(paths.draftsDir, 'scene-001.md'))
    expect(readFileSync(result.draftPath, 'utf8')).toBe(`${result.text}\n`)
    expect(result.checks.hardFailures).toEqual([])
    const files = readFileSync(result.draftPath, 'utf8')
    expect(files).not.toMatch(/^(#|---|text:)/m)
    // drafts 目录只有正文文件
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(paths.draftsDir)).toEqual(['scene-001.md'])
  })

  it('Writer 不修改任何状态文件 / Blueprint / Scene（快照比对）', async () => {
    const paths = cloneDemoProject('demo-01')
    rmSync(paths.draftsDir, { recursive: true, force: true })
    const before = snapshotProjectState(paths)
    await runProseWriter({ paths, provider: proseProvider(), sceneId: 'scene-001' })
    const after = snapshotProjectState(paths)
    expect(diffProjectState(before, after)).toEqual([])
  })

  it('删除 proposals.yaml 后仍可写作（Writer 不读 Proposal）', async () => {
    const paths = cloneDemoProject('demo-01')
    rmSync(paths.draftsDir, { recursive: true, force: true })
    rmSync(paths.proposals)
    // scene-002 的 Draft Context 依赖 scene-001，因此按序写入后校验
    await runProseWriter({ paths, provider: proseProvider(), sceneId: 'scene-001' })
    const result = await runProseWriter({ paths, provider: proseProvider(), sceneId: 'scene-002' })
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.checks.hardFailures).toEqual([])
  })

  it('--plan 只读：不写 Draft', async () => {
    const paths = cloneDemoProject('demo-01')
    rmSync(paths.draftsDir, { recursive: true, force: true })
    const result = await runProseWriter({ paths, provider: proseProvider(), sceneId: 'scene-001', dryRun: true })
    expect(result.written).toBe(false)
    expect(existsSync(join(paths.draftsDir, 'scene-001.md'))).toBe(false)
  })

  it('按 order 逐场写作：每场都能拿到前一场同 POV 的 Draft Context', async () => {
    const paths = cloneDemoProject('demo-01')
    rmSync(paths.draftsDir, { recursive: true, force: true })
    const all = await runProseWriterAll({ paths, provider: proseProvider() })
    expect(all.failures).toEqual([])
    expect(all.results.map((result) => result.sceneId)).toEqual([
      'scene-001',
      'scene-002',
      'scene-003',
      'scene-004',
      'scene-005',
    ])
    expect(all.results[0]?.context.writerContext.draft_context).toBeNull()
    for (const result of all.results.slice(1)) {
      expect(result.context.writerContext.draft_context?.scene_id).toBeTruthy()
    }
    for (const result of all.results) {
      expect(result.checks.hardFailures, result.sceneId).toEqual([])
      expect(result.formatViolations).toEqual([])
    }
  })

  it('Writer 输入只来自受控上下文（含 role 说明与 style 样本；无 Proposal 痕迹）', async () => {
    const paths = cloneDemoProject('demo-01')
    const context = compileContext({ paths, sceneId: 'scene-001' })
    const input = buildProseWriterInput(context)
    expect(Object.keys(input).sort()).toEqual([
      'allowed_reveals',
      'blueprint_version',
      'characters',
      'core_conflict',
      'director_surface',
      'draft_context',
      'known_knowledge_ids',
      'pov',
      'premise',
      'scene',
      'scene_id',
      'style_direction',
      'style_samples',
      'theme',
    ])
    expect(JSON.stringify(input)).not.toContain('PROP_')
  })

  it('用户 director note 通过受控上下文进入 Prompt（降级路径）', async () => {
    const paths = cloneDemoProject('demo-01')
    const result = await runProseWriter({
      paths,
      provider: proseProvider(),
      sceneId: 'scene-001',
      userNotes: [],
      dryRun: true,
    })
    expect(result.prompt).toContain('DIR_BLUEPRINT_001')
    expect(result.prompt).toContain('纯文本')
  })
})
