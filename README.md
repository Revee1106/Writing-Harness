# Short-story-first Writing Harness v0.1

短篇优先的 AI 写作辅助 Harness。用户只给一句模糊的故事大概（Story Seed），
系统负责：理解 Seed → 提出差异明显的 Proposal → 经 Author Gate 确认 Blueprint →
拆 Scene → 按 POV 编译受控上下文 → 生成正文 → 反 AI 感 Linter → 局部 Rewrite →
终稿确认 → 提取 OCCURRED 事实。

> **v0.1 不追求成为通用 AI 小说系统**，只证明一个命题：
> 一句话种子能否稳定变成可用蓝图，再变成低 AI 感短篇正文，同时不丢失用户真正想写的核心。

## 开发基线（冻结文档）

本仓库的唯一开发基线是用户提供的三份文档，实现层不得自行发明平行结构：

1. `Short-story-first_Writing_Harness_v0.1_需求规格.md`
2. `Short-story-first_Writing_Harness_v0.1_架构设计.md`
3. `Short-story-first_Writing_Harness_v0.1_开发Story拆分.md`

文档之间冲突以《架构设计》为准；无法由此消解的记入 `docs/OPEN-QUESTIONS.md`，不擅自选择。
已裁决事项记入 `docs/DECISIONS.md`。

## 四条底层原则

1. **LLM 无权修改现实**：模型输出默认只是候选内容，未经用户确认不得升级。
2. **可以提案，不能伪装**：Harness 补出的内容默认 `status=PROPOSED`，不得伪装为 `USER_GIVEN`。
3. **Context Compiler 必须可审计**：Writer 只能获得当前场景需要的信息，每次编译必须有 Manifest。
4. **推演不会产生事实**：只有用户确认、或用户确认过的正文实际发生，才能产生事实。

在代码层面，原则 1/2/4 由 `src/core/state-machine.ts` 的可执行状态机保证，
而不是靠提示词自律。

## 目录结构

```text
src/
  core/       状态枚举、通用状态项、source_ref、ID 前缀登记、状态机、确定性哈希
  schema/     seed.yaml / project-config.yaml（后续 Story 追加 blueprint / scene / story_state / manifest）
  io/         确定性 YAML 读写、项目路径
  project/    项目创建与读写（文件优先，无数据库）
  providers/  LLMProvider 接口 + RecordedProvider（离线回放）+ OpenAI 兼容 Provider
  interpreter/Seed Interpreter（Prompt Contract / 解析 / ID 分配 / 原文可追溯校验）
  gate1/      Author Gate 1（六种操作 / gate1_status 迁移 / 服务）
  gate2/      Author Gate 2（字段计划 / 合并与装配 / 版本与快照 / 服务）
  developer/  Story Developer（Proposal 生成 / ID 规范化 / seed_fidelity 与冲突检查）
  scenes/     Scene Breakdown / Structure Resolver / Story State / Coverage Check
  context/    Context Compiler（数据源白名单 / POV Filter / Manifest / Draft Context）
  writer/     Prose Writer（纯正文生成 / 硬软约束检查 / Draft 落盘）
  linter/     Rule Linter（五条规则）+ LLM Linter（五类语义）+ Local Rewrite 与局部二次检查
  eval/        评估资产（Story Development Test Set / Author Cost / Anti-AI A/B 对照）
  state/       Gate 3（final.md 组装 + State Extractor 校验与 OCCURRED 落库）
  prompts/    版本化 Prompt Contract（seed_interpreter / story_developer / blueprint_builder /
              scene_breakdown / prose_writer / llm_linter / local_rewrite / state_extractor，均 @0.1；
              plain_prompt@0.1 只用于 Anti-AI A/B 的 A 侧对照，不参与创作流程）
  cli/        CLI 入口
scripts/      fixture 哈希刷新工具
tests/
  unit/       单元测试（状态机表驱动、schema、raw input 保真）
  acceptance/ Story 级验收测试（含 golden 快照）
  fixtures/   seeds / golden / recorded（离线回放）/ evaluation（Story 10 评估资产）
projects/     项目数据（每个项目一个目录）
config/       仓库级默认配置（反 AI 词表，Story 8 填充）
docs/         未决问题清单、已裁决事项、技术选型
```

## 常用命令

```bash
pnpm install
pnpm test            # 全部测试
pnpm typecheck       # tsc --noEmit

pnpm harness help
pnpm harness init demo-01 --seed "一对情侣因为一件小事争吵，女方提出分手。"
pnpm harness init demo-02 --seed-file story.md --title "清单" --target-length 8000
pnpm harness seed show demo-02
pnpm harness config show demo-02

# Seed Interpreter + Author Gate 1（Story 2）
pnpm harness gate1 demo-02 --plan                 # 只读预览：分类结果 + 原文证据，不写盘
pnpm harness gate1 demo-02 --accept-all           # 接受全部（gate1_status=confirmed）
pnpm harness gate1 demo-02 --skip                 # 跳过 Gate 1（gate1_status=skipped）
pnpm harness gate1 demo-02 --op promote:SEED_A001 --op 'edit:SEED_F001=新表述'

# Story Developer → 2～3 个 Proposal（Story 3）
pnpm harness develop demo-02 --plan               # 只读预览：方案 + seed_fidelity + Rate，不写盘
pnpm harness develop demo-02                      # 写入 proposals.yaml
pnpm harness proposals show demo-02               # 方案摘要 + Seed Preservation Rate

# Author Gate 2：确认 / 合并 / 手改 → Blueprint（Story 4）
pnpm harness gate2 demo-02 --plan                    # 只读预览：字段来源 + 完整 Blueprint，不写盘
pnpm harness gate2 demo-02 --from PROP_A             # 单来源确认
pnpm harness gate2 demo-01 --field premise=PROP_A --field structure=PROP_B ...   # 逐字段合并
pnpm harness gate2 demo-01 --edit premise='用户手写的核心前提'                    # 用户手写字段
pnpm harness gate2 demo-01 --resolve PROP_B:CONF_001=kept_user                   # 裁决 USER_GIVEN 冲突
pnpm harness blueprint show demo-02                  # 当前 Blueprint 摘要

# Scene Breakdown → /scenes + story_state + reports/coverage（Story 5）
pnpm harness breakdown demo-02 --plan      # 只读预览：Scene 列表 + Coverage 警告，不写盘
pnpm harness breakdown demo-02             # 首次拆场
pnpm harness breakdown demo-02 --rerun     # 显式重跑（confirmed_scenes 不变）
pnpm harness scenes show demo-02
pnpm harness state show demo-02
pnpm harness coverage show demo-02

# Context Compiler + Manifest（Story 6）
pnpm harness context demo-02 --scene scene-003          # 编译单场受控上下文 + Manifest
pnpm harness context demo-02 --all                      # 逐场编译并打印摘要
pnpm harness context demo-02 --scene scene-001 --note '这一场不要出现回忆'   # 降级路径：用户 director note
pnpm harness style add demo-02 --text '……' --pov CH_HUSBAND --scene-type action --tone tension
pnpm harness style show demo-02

# Prose Writer（Story 7）
pnpm harness write demo-02                      # 按 order 逐场生成 drafts/scene-NNN.md
pnpm harness write demo-02 --scene scene-003    # 只写一场
pnpm harness write demo-02 --plan               # 只读预览
pnpm harness drafts show demo-02                # 正文长度与格式检查摘要

# Rule Anti-AI Linter（Story 8）
pnpm harness lint demo-02                    # 逐场确定性 / 统计型检查（不自动 Rewrite）
pnpm harness lint demo-02 --scene scene-003  # 只检查一场
pnpm harness lint show demo-02               # 显示 reports/linter.yaml
# 词表：config/anti-ai-template-actions.yaml（24 条）与 config/anti-ai-elevation-phrases.yaml（12 条）
# 项目级覆盖：projects/<id>/config/<同名文件>（OQ-07）

# LLM Linter + Local Rewrite（Story 9）
pnpm harness lint demo-02 --scene scene-003 --llm     # 语义型五类检查（span 用码点偏移）
pnpm harness rewrite demo-02 --scene scene-003 --warning LINT_001   # 局部改写 + 局部二次 Linter
pnpm harness rewrite demo-02 --scene scene-003 --warning LINT_001 --full  # 改写后跑完整 Linter

# Gate 3 + State Extractor（Story 10）
pnpm harness gate3 demo-02 --confirm        # 整篇一次性确认：写 drafts/final.md + confirmed_scenes
pnpm harness gate3 demo-02                  # 只预演（dry-run），不落盘
pnpm harness final show demo-02             # 显示 final.md 状态（长度 / 场景数 / occurred / 冲突）

# 评估资产（Story 10：测试集 + 作者成本 + A/B 对照，不自动评分）
pnpm harness eval story-development         # Story Development Test Set（≥10 Seed）→ results.csv
pnpm harness eval author-cost               # Author Cost（§31.3）→ author-cost.csv
pnpm harness eval ab-generate               # Anti-AI A/B 对照（10 Scene Intent）→ session-00N/ + ratings.csv
pnpm harness eval ab-report                 # A/B 归一化摘要：平均码点 + 每千码点 warning（不做质量判定）

# fixture 与 Seed 文本 / Gate 1 状态一致性（离线回放依赖）
pnpm fixtures:check
pnpm fixtures:refresh
```

模型调用通过 provider 抽象：`--provider recorded`（默认，离线 fixture 回放）或
`--provider openai-compat`（需要 `HARNESS_LLM_BASE_URL` / `HARNESS_LLM_API_KEY` / `HARNESS_LLM_MODEL`）。

Node 24 可直接执行 TypeScript，CLI 无需构建步骤。

## 演示项目（demo-01 / demo-02）

仓库里带两个**离线可复现**的演示项目（`projects/demo-01`、`projects/demo-02`），
用于端到端回归与评估资产：

> ⚠️ **demo 是压缩样本，不是产品级输出**：每场正文约 **110–200 码点**（两个 demo 的
> `drafts/final.md` 分别约 818 / 824 码点），目标是让整条链路在离线 fixture 下秒级复跑，
> 而不是展示成稿质量。真实使用时 `project.target_length` 与逐场 `scene.target_length`
> 决定篇幅，产品级短篇为 1,000–30,000 字符。

## 进度

| Story | 内容 | 状态 |
|---|---|---|
| Story 1 | Project Model + Story Seed | ✅ 完成 |
| Story 2 | Seed Interpreter + Gate 1 | ✅ 完成 |
| Story 3 | Story Developer + Proposal | ✅ 完成 |
| Story 4 | Blueprint Confirm / Merge / Edit（Gate 2） | ✅ 完成 |
| Story 5 | Scene Breakdown + Story State + Coverage Check | ✅ 完成 |
| Story 6 | Context Compiler + POV Filter + Manifest | ✅ 完成 |
| Story 7 | Prose Writer + Style Samples | ✅ 完成 |
| Story 8 | Rule Anti-AI Linter | ✅ 完成 |
| Story 9 | LLM Linter + Local Rewrite | ✅ 完成 |
| Story 10 | Gate 3 + State Extractor + 评估 | ✅ 完成（654 项测试全绿） |
| M1 | 最小端到端验证（Story 5 后强制） | ✅ **通过** |

交付物：
- 命令面：`init / seed / gate1 / develop / gate2 / breakdown / context / style / write / lint / rewrite / gate3 / final / state / coverage / eval`
- 评估资产：`tests/fixtures/evaluation/story-development/`（10 Seed 测试集，measured 7 = 2 项目型 +
  5 fixture 型（情感 / 悬疑 / 温情 / 现实 / 轻科幻），corpus_only 3 = 开放结局 / 单场景 / 强反转）
  与 `tests/fixtures/evaluation/anti-ai/session-001/`（10 组 A/B 对照 + 人工评分模板）
- A/B 归一化（封版证据）：A 86 码点/场、B 157 码点/场；每千码点 Rule warning **A 47.56 : B 2.55**
  （B/A = 0.054），见 `pnpm harness eval ab-report`。
  限定：本 A/B 为 v0.1 初版信号，样本量有限（10 组，A 侧合计 862 码点），结论方向明确但需要在
  v0.2 扩大样本验证
- 待回写三份冻结文档的条目：见 `docs/DECISIONS.md` 的**封版后文档维护清单**（30 条）
