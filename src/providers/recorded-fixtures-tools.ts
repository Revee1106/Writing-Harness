import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashContractInput } from '../core/hash.ts'
import { parseRecordedInteraction, RecordedProvider, type RecordedInteraction } from './recorded.ts'

/**
 * recorded fixture 的哈希复核工具（Story 2 / Story 3）。
 *
 * 每个 fixture 都声明它对应的 Seed 文件（`seed: story2/01-emotion.txt`），
 * 并按契约重建"运行时会发给 Provider 的结构化输入"，据此重算 `input_sha256`，
 * 保证 **fixture 与 Seed 文本 / Gate 1 状态不会静默漂移**。
 *
 * 契约的输入构造是显式注册的（不靠猜）：
 * - `seed_interpreter`  → `{ raw_input }`
 * - `story_developer`   → 用 recorded interpreter fixture 复现 Gate 1 之后的 seed 状态，
 *   再走 `buildDeveloperInput()`；因此 fixture 需要额外声明 `gate1_ops`（fixture 元数据）。
 * - `blueprint_builder` → 在上一链条基础上再跑 Story Developer（recorded）得到 proposals，
 *   然后按 fixture 元数据 `gate2_plan` 解析字段计划并构造输入。
 * - `scene_breakdown`   → 在 blueprint_builder 链条上再装配出 Blueprint（走 Gate 2 装配路径），
 *   然后构造 Scene Breakdown 的输入。
 * - `llm_linter`        → 输入 = Scene 元信息 + 正文（读取 `source_project` 的 Draft）。
 * - `local_rewrite`     → 输入 = Scene 元信息 + warning（fixture 元数据 `rewrite_target`）+ span 切片
 *   与前后段落 + Style Samples（与运行时共用 `prepareRewrite()`）。
 * - `prose_writer`      → 输入是 Context Compiler 的产物，因此直接读取 fixture 声明的
 *   `source_project`（仓库内的项目目录，含 scenes / style / drafts），编译该 Scene 的上下文后构造输入。
 *   这类 fixture **不需要** `seed` 字段。
 */

export interface FixtureCheckEntry {
  readonly file: string
  readonly contract: string
  readonly seedFile: string | undefined
  readonly expectedSha256: string | undefined
  readonly actualSha256: string | undefined
  readonly ok: boolean
  readonly problem?: string | undefined
}

export interface FixtureToolOptions {
  readonly fixturesDir: string
  readonly seedsDir: string
  /** seed-interpreter fixture 目录：story_developer 复核需要用它复现 Gate 1 状态。 */
  readonly interpreterFixturesDir: string
  /** 仓库根目录：prose_writer 复核需要用它定位 `source_project`。 */
  readonly repoRoot: string
}

type InputBuilder = (context: {
  interaction: RecordedInteraction
  rawInput: string
  interpreterFixturesDir: string
  repoRoot: string
}) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>

const INPUT_BUILDERS: Record<string, InputBuilder> = {
  seed_interpreter: ({ rawInput }) => ({ raw_input: rawInput }),
  story_developer: async ({ interaction, rawInput, interpreterFixturesDir }) => {
    const { buildDeveloperInput } = await import('../developer/developer.ts')
    const { applyGate1Operations, gate1OperationSchema, seedFromInterpreterResult } = await import('../gate1/operations.ts')
    const { runSeedInterpreter } = await import('../interpreter/interpreter.ts')
    const provider = RecordedProvider.fromDirectory(interpreterFixturesDir)
    const interpreter = await runSeedInterpreter({ provider, rawInput })
    const candidate = seedFromInterpreterResult(rawInput, interpreter)
    // fixture 元数据解析为正式的 Gate 1 操作（非法元数据直接报错，而不是被忽略）
    const operations = (interaction.gate1_ops ?? []).map((operation) => gate1OperationSchema.parse(operation))
    const applied = applyGate1Operations(candidate, operations)
    return buildDeveloperInput(applied.seed, interaction.style_preference)
  },
}

const INPUT_BUILDERS_EXTRA: Record<string, InputBuilder> = {
  blueprint_builder: async ({ interaction, rawInput, interpreterFixturesDir }) => {
    const { applyGate1Operations, seedFromInterpreterResult } = await import('../gate1/operations.ts')
    const { runSeedInterpreter } = await import('../interpreter/interpreter.ts')
    const { runStoryDeveloper } = await import('../developer/developer.ts')
    const { buildBlueprintBuilderInput, resolveFieldPlan } = await import('../gate2/builder.ts')

    const interpreterProvider = RecordedProvider.fromDirectory(interpreterFixturesDir)
    const interpreter = await runSeedInterpreter({ provider: interpreterProvider, rawInput })
    const candidate = seedFromInterpreterResult(rawInput, interpreter)
    const seed = applyGate1Operations(candidate, (interaction.gate1_ops ?? []).map((op) => op as never)).seed

    const developerDir = interpreterFixturesDir.replace(/seed-interpreter$/, 'story_developer')
    const developer = await runStoryDeveloper({
      provider: RecordedProvider.fromDirectory(developerDir),
      seed,
      stylePreference: interaction.style_preference,
    })

    const plan = resolveFieldPlan({
      fromProposal: interaction.gate2_plan?.from,
      fields: interaction.gate2_plan?.fields,
      proposals: developer.file,
    })
    const edits = interaction.gate2_plan?.edits ?? {}
    const userEdits = plan.userFields.map((field, index) => ({
      id: `EDIT_${String(index + 1).padStart(3, '0')}`,
      field,
      value: edits[field] ?? '',
    }))
    const conflictResolutions = Object.entries(interaction.gate2_plan?.resolutions ?? {}).map(([key, resolution]) => {
      const [proposalId, conflictId] = key.split(':') as [string, string]
      const proposal = developer.file.proposals.find((candidateProposal) => candidateProposal.proposal_id === proposalId)
      const conflict = proposal?.conflicts.find((candidateConflict) => candidateConflict.id === conflictId)
      if (conflict === undefined) {
        throw new Error(
          `fixture 元数据 gate2_plan.resolutions 指向不存在的冲突 ${key}（该提案只有 ${proposal?.conflicts.map((item) => item.id).join(', ') ?? '无'}）`,
        )
      }
      return { id: conflictId, proposal_id: proposalId, seed_ref: conflict.seed_ref, resolution }
    })
    return buildBlueprintBuilderInput(developer.file, {
      plan,
      userEdits,
      conflictResolutions,
      gate2ActionId: 'GATE2_001',
    })
  },
}

const INPUT_BUILDERS_EXTRA2: Record<string, InputBuilder> = {
  scene_breakdown: async ({ interaction, rawInput, interpreterFixturesDir }) => {
    const { applyGate1Operations, gate1OperationSchema, seedFromInterpreterResult } = await import('../gate1/operations.ts')
    const { runSeedInterpreter } = await import('../interpreter/interpreter.ts')
    const { runStoryDeveloper } = await import('../developer/developer.ts')
    const { buildSceneBreakdownInput } = await import('../scenes/service.ts')
    const { projectPaths } = await import('../io/paths.ts')
    const { createProject, saveProposals, saveSeed } = await import('../project/project.ts')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const recordedRoot = interpreterFixturesDir.replace(/seed-interpreter$/, '')
    const runChain = async (): Promise<Record<string, unknown>> => {
      const root = mkdtempSync(join(tmpdir(), 'fixture-scene-'))
      try {
        createProject({ projectsRoot: root, projectId: 'fixture', rawInput })
        const paths = projectPaths(root, 'fixture')
        const interpretation = await runSeedInterpreter({
          provider: RecordedProvider.fromDirectory(interpreterFixturesDir),
          rawInput,
        })
        const candidate = seedFromInterpreterResult(rawInput, interpretation)
        const seed = applyGate1Operations(
          candidate,
          (interaction.gate1_ops ?? []).map((op) => gate1OperationSchema.parse(op)),
        ).seed
        saveSeed(paths, seed)
        const developer = await runStoryDeveloper({
          provider: RecordedProvider.fromDirectory(join(recordedRoot, 'story_developer')),
          seed,
        })
        saveProposals(paths, developer.file)
        const { runGate2 } = await import('../gate2/service.ts')
        const blueprint = await runGate2({
          paths,
          provider: RecordedProvider.fromDirectory(join(recordedRoot, 'blueprint_builder')),
          fromProposal: interaction.gate2_plan?.from,
          fields: interaction.gate2_plan?.fields,
          edits: interaction.gate2_plan?.edits,
          resolutions: interaction.gate2_plan?.resolutions,
          dryRun: true,
        })
        return buildSceneBreakdownInput(blueprint.blueprint)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
    return runChain()
  },
}

const INPUT_BUILDERS_EXTRA3: Record<string, InputBuilder> = {
  prose_writer: async ({ interaction, repoRoot }) => {
    const { buildProseWriterInput } = await import('../writer/writer.ts')
    const { compileContext } = await import('../context/compiler.ts')
    const { projectPaths } = await import('../io/paths.ts')
    if (interaction.source_project === undefined || interaction.scene === undefined) {
      throw new Error('prose_writer fixture 必须声明 source_project 与 scene')
    }
    const projectDir = join(repoRoot as string, interaction.source_project)
    // 项目目录布局：<projectsRoot>/<projectId>
    const projectId = projectDir.split('/').pop() as string
    const paths = projectPaths(join(repoRoot as string, 'projects'), projectId)
    const context = compileContext({ paths, sceneId: interaction.scene })
    return buildProseWriterInput(context)
  },
}

const INPUT_BUILDERS_EXTRA4: Record<string, InputBuilder> = {
  llm_linter: async ({ interaction, repoRoot }) => {
    const { buildLlmLinterInput } = await import('../linter/llm-linter.ts')
    const { loadScenes } = await import('../scenes/service.ts')
    const { projectPaths } = await import('../io/paths.ts')
    const { readTextFile } = await import('../io/yaml.ts')
    const { resolveProjectDir } = projectDirResolver()
    const paths = projectPaths(join(repoRoot, 'projects'), resolveProjectDir(interaction.source_project as string))
    const scenes = loadScenes(paths)
    const scene = scenes.find((candidate) => candidate.scene_id === interaction.scene)
    if (scene === undefined) throw new Error(`找不到 ${String(interaction.scene)}`)
    const text = readTextFile(join(paths.draftsDir, `${scene.scene_id}.md`))
    return buildLlmLinterInput(scene, text)
  },
  local_rewrite: async ({ interaction, repoRoot }) => {
    const { prepareRewrite } = await import('../linter/rewrite.ts')
    const { projectPaths } = await import('../io/paths.ts')
    const { resolveProjectDir } = projectDirResolver()
    const paths = projectPaths(join(repoRoot, 'projects'), resolveProjectDir(interaction.source_project as string))
    const target = interaction.rewrite_target
    if (target === undefined) throw new Error('local_rewrite fixture 必须声明 rewrite_target')
    const prepared = prepareRewrite(paths, interaction.scene as string, target as never)
    return prepared.input
  },
}

function projectDirResolver(): { resolveProjectDir: (value: string) => string } {
  return { resolveProjectDir: (value: string) => value.split('/').pop() as string }
}

function listFixtureFiles(fixturesDir: string): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
}

export async function checkRecordedFixtures(options: FixtureToolOptions): Promise<FixtureCheckEntry[]> {
  const entries: FixtureCheckEntry[] = []
  for (const file of listFixtureFiles(options.fixturesDir)) {
    const filePath = join(options.fixturesDir, file)
    const interaction = parseRecordedInteraction(readFileSync(filePath, 'utf8'), filePath)
    const base = {
      file,
      contract: interaction.contract,
      actualSha256: interaction.input_sha256,
    }

    const builder: InputBuilder | undefined =
      INPUT_BUILDERS[interaction.contract] ??
      INPUT_BUILDERS_EXTRA[interaction.contract] ??
      INPUT_BUILDERS_EXTRA2[interaction.contract] ??
      INPUT_BUILDERS_EXTRA3[interaction.contract] ??
      INPUT_BUILDERS_EXTRA4[interaction.contract]

    // prose_writer 这类 fixture 的输入来自项目状态，不需要 seed 字段
    if (interaction.seed === undefined) {
      if (builder === undefined) {
        entries.push({
          ...base,
          seedFile: undefined,
          expectedSha256: undefined,
          ok: false,
          problem: '缺少 seed 字段，且该契约没有注册不依赖 Seed 的输入构造函数',
        })
        continue
      }
      try {
        const input = await builder({
          interaction,
          rawInput: '',
          interpreterFixturesDir: options.interpreterFixturesDir,
          repoRoot: options.repoRoot,
        })
        const expected = hashContractInput(interaction.contract, interaction.contract_version, input)
        entries.push({
          ...base,
          seedFile: interaction.source_project,
          expectedSha256: expected,
          ok: expected === interaction.input_sha256,
          problem:
            expected === interaction.input_sha256
              ? undefined
              : 'input_sha256 与当前项目状态不一致，请运行 pnpm fixtures:refresh',
        })
      } catch (error) {
        entries.push({
          ...base,
          seedFile: interaction.source_project,
          expectedSha256: undefined,
          ok: false,
          problem: `重建输入失败：${(error as Error).message}`,
        })
      }
      continue
    }
    if (builder === undefined) {
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: undefined,
        ok: false,
        problem: `契约 ${interaction.contract} 没有注册输入构造函数，无法复核哈希`,
      })
      continue
    }

    let rawInput: string
    try {
      rawInput = readFileSync(join(options.seedsDir, interaction.seed), 'utf8')
    } catch (error) {
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: undefined,
        ok: false,
        problem: `读取 Seed 文件失败：${(error as Error).message}`,
      })
      continue
    }

    try {
      const input = await builder({
        interaction,
        rawInput,
        interpreterFixturesDir: options.interpreterFixturesDir,
        repoRoot: options.repoRoot,
      })
      const expected = hashContractInput(interaction.contract, interaction.contract_version, input)
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: expected,
        ok: expected === interaction.input_sha256,
        problem:
          expected === interaction.input_sha256
            ? undefined
            : 'input_sha256 与当前 Seed 文本 / Gate 1 状态不一致，请运行 pnpm fixtures:refresh',
      })
    } catch (error) {
      entries.push({
        ...base,
        seedFile: interaction.seed,
        expectedSha256: undefined,
        ok: false,
        problem: `重建输入失败：${(error as Error).message}`,
      })
    }
  }
  return entries
}

export async function refreshRecordedFixtures(
  options: FixtureToolOptions & { write: boolean },
): Promise<FixtureCheckEntry[]> {
  const entries = await checkRecordedFixtures(options)
  if (!options.write) return entries

  for (const entry of entries) {
    if (entry.ok || entry.expectedSha256 === undefined) continue
    const filePath = join(options.fixturesDir, entry.file)
    const text = readFileSync(filePath, 'utf8')
    const replaced = text.replace(/^input_sha256:.*$/m, `input_sha256: "${entry.expectedSha256}"`)
    if (replaced === text) {
      throw new Error(`无法在 ${filePath} 中定位 input_sha256 行`)
    }
    writeFileSync(filePath, replaced, 'utf8')
  }
  return checkRecordedFixtures(options)
}
