# Short-story-first Writing Harness v0.1 — 已裁决事项

> 本文件记录**用户显式裁决**的事项，以及 Story 实现中为落地文档条款而做的**已记录解读**。
> 裁决项具有约束力：后续 Story 不得单方面更改，如需变更须回到本文件并注明修订。

---

## 一、D1–D9 裁决（用户确认）

| 编号 | 事项 | 裁决 |
|---|---|---|
| **D1** | 技术栈 | **TypeScript + Node 24 + pnpm + zod + vitest**。zod 让 Schema 成为可执行事实；本环境 Python 无 pip、TS 无需额外引导；`source_refs` 结构化 / `known_by` map / `resolution_ref` tagged union / 状态机非法流转都是 zod 强项；Node 24 原生 `Intl.Segmenter` 满足中文统计；Provider 抽象 + `RecordedProvider` 保证单测离线可复现。Python stdlib 方案作为备选保留在 `docs/TECH-STACK.md`，**不采用**。 |
| **D2** | `source` 枚举 | 扩展为 `{user, user_gate1, interpreter, harness, blueprint, scene_breakdown, final_text}`。 |
| **D3** | `source_ref` 单复数 | 通用状态项保留**单数** `source_ref`（可为 `null`，若存在必须是可解析的 `{type, ref_id}` 结构或稳定 ID 字符串）；Blueprint 类项使用**复数** `source_refs[]`（结构化）。 |
| **D4** | `ambiguous` 项 | 不带 `status`，`source: interpreter`；ID 前缀 **`SEED_A###`**。 |
| **D5** | `gate1_status` 初值 | `pending`。 |
| **D6** | `project-config.yaml` 最小 schema | 采纳 Story 1 草案，三点微调：保留 `schema_version: "0.1"`；`project.target_length` 单位注释为「中文字数」；`linter.rules` 五条命名采纳（`template_actions` / `sentence_length_variance` / `paragraph_length_variance` / `dialogue_ratio` / `paragraph_ending_elevation`）。 |
| **D7** | 项目根目录 | `projects/<project_id>/`，内部文件树照抄需求规格 §29 / 架构 §32。 |
| **D8** | 状态机触发器命名 | `GATE2_CONFIRM / GATE3_CONFIRM / SCENE_BREAKDOWN_REFERENCE / WRITER_REFERENCE / DRAFT_CONTAINS / STATE_EXTRACTOR`；**G1（`PROPOSED → USER_GIVEN` 无条件禁止）纳入**。 |
| **D9** | 版本控制 | `git init`，提交信息格式 `[Story N] <简短描述>`。 |

## 二、OQ-01 定调

**Blueprint 顶层新增 `seed_fidelity`，字段结构与 Proposal 一致（preserved / altered / added / risk）。**
- Story 3：先在 Proposal 侧落地 `seed_fidelity`。
- Story 4：落地到 Blueprint，并在汇报时提醒回写《架构设计》§11.1。
- 该冲突已标注在 `docs/OPEN-QUESTIONS.md` OQ-01。

---

## 三、Story 1 实现解读（为落地文档条款而做的具体选择，均已记录，可回溯）

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-1 | `PROPOSED → CONFIRMED` 迁移后 `source` 写为 `blueprint`；`CONFIRMED → OCCURRED` 迁移后 `source` 写为 `final_text`。 | 需求规格 §7 的 source 枚举本身就包含 `blueprint` / `final_text` 两个值，语义正对应 Gate 2 确认与终稿事实。 | 不新增字段，只是为已定义枚举值指定赋值时机。 |
| I-2 | 状态迁移只允许通过 `transitionStatus()` 发生；`recordUsage()` 用于"被使用"，返回**同一引用**且状态不变。 | 需求规格 §6.3（被使用不升级）、§32 原则 1/原则 4 测试；架构 §7 禁止流转 F3/F4/F5。 | 解析后的对象一律 `deepFreeze`，误改会直接抛错。 |
| I-3 | `draft_context.max_chars` 硬校验为正整数；超出 §19.1 推荐区间 500–800 时产生 **warning 级提示**而非报错。 | §19.1 "推荐允许 500～800 范围配置"。 | 避免把"推荐"误实现为硬约束，同时保留可见性。 |
| I-4 | `project.target_length` 硬校验为正整数，单位 = **中文字数**（D6 裁决）；超出 §1/§30 支持区间 1,000–30,000 时产生 warning 级提示。 | 需求规格 §1、§30。 | 同上，推荐区间不设硬门槛。 |
| I-5 | `project.id` 采用 slug 格式 `^[a-z0-9][a-z0-9_-]{0,63}$`，并作为项目目录名。 | OQ-20 裁决（`projects/<project_id>/`）未定义 ID 形态。 | 若需中文/大写 ID，请在 Story 2 起始前裁决。 |
| I-6 | `project.created_at` 为 ISO-8601 字符串，可由 `--now` 注入以便 golden 快照可复现。 | OQ-20/D6 草案含 `created_at`。 | 测试与快照需要确定性时间。 |
| I-7 | 多行 `raw_input` 落盘使用 YAML block literal（`\|`/`\|-`）；仅当字符串包含换行且不以空白开头时使用。 | Story 1 验收"用户原话原样保留"。 | 其余情况交给 yaml 库自动选择安全的 quoting。 |
| I-8 | 写入前校验 `seed.yaml` 不变量，违反则**拒绝写入**（而非静默修正）：① `origin=raw_seed` 的 fixed 项必须已在 `raw_seed_anchor_ids` 中；② `origin=gate1_confirmation` 的项不得进入 `raw_seed_anchor_ids`；③ `gate1_status=pending` 时不得存在 `source=user_gate1` 的项。 | 需求规格 §8.2（冻结不重算）、§5.1（Gate 1 提升来源）、架构 §5。 | 这是"不存在自动状态升级/漂移"的结构性保证。 |
| I-9 | `raw_input` 在 `gate1_status !== 'pending'` 时默认拒绝直接覆盖（需显式 `allowAfterGate1`）。 | 保护 §8.2 已冻结的 anchor 集合。 | Gate 1 之后的 raw input 修正语义属于 Story 2，届时再定。 |
| I-10 | `harness init` 会在项目目录下创建 §29/§32 记录的空骨架目录（`history/ scenes/ drafts/ style/samples/ reports/ config/`），但不预建任何未定义的文件。 | 需求规格 §29；架构 §32；OQ-07。 | 只建目录，不发明文件。 |
| I-11 | ID 前缀集中登记在 `src/core/ids.ts`，登记项全部来自文档已出现的示例；Story 1 只用其中的 seed 类前缀。 | 需求规格 §7/§8.1/§9.3/§11.1/§18.1/§29。 | 防止后续 Story 各自发明前缀。 |
| I-12 | `source_refs` 的 `ref_id` 按 type 做形式校验：`seed` → `SEED_F/SEED_A/SEED_Q` 形态；`proposal` → `<proposal_id>.<field_path>`（§9.3）；`user_edit`/`blueprint_gate2` → 非空（深层可解析性受 OQ-10 阻塞）。 | 需求规格 §7.2、§9.3。 | 落实"不允许使用无法解析的自由字符串作为 source ref"。 |

---

## 四、Story 2 实现解读（I-13 … I-17）

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-13 | **ID 由 Harness 分配，不由模型输出**：Prompt Contract 只要求模型给出 `value` + `evidence`，Harness 按出现顺序分配 `SEED_F###` / `SEED_A###` / `SEED_Q###`。 | 需求规格 §8.1/§8.3 只规定 ID 形态与稳定性，未规定由谁产生；Harness 分配才能保证确定性与可复现验收。 | 使"10 个 Seed 离线可复现"成立的关键。 |
| I-14 | **原文证据（`evidence`）定位失败的条目不进入 `fixed_by_user`**，而是降级为 `ambiguous` 并产生 notice（`EVIDENCE_NOT_FOUND` / `EVIDENCE_MISSING`）。 | 需求规格 §4「fixed_by_user 必须来自用户原始输入；推断不能混入 fixed_by_user」＋ §3 原则 2。 | 不阻塞用户（不报错中断），但也不伪装成 USER_GIVEN。 |
| I-15 | **`gate1_status` 判定**：`accept_all` → `confirmed`；`skip` → `skipped`；存在删除/提升/降级/编辑 → `partial`。`skip` 与 `accept_all` 都必须单独使用。 | 需求规格 §8.1 的三值 + §5.1 的操作集合（判定条件文档未定义，见 OQ-28）。 | 见 `src/gate1/status.ts`。 |
| I-16 | **Gate 1 升降级时条目保留原 ID**：`ambiguous → fixed_by_user` 的条目仍是 `SEED_A###`，`fixed → ambiguous` 的条目仍是 `SEED_F###`。相应地把两个集合的 ID 约束放宽为"Seed item ID"（`SEED_[FAQ]###`）。 | 需求规格 §8.2 把升降级描述为同一项的移动；§5.1 要求支持提升，而 Story 1 的"fixed 只接受 `SEED_F###`"与之不可兼得。 | **这是 Story 2 对 Story 1 schema 的唯一一处放宽**，已在 OPEN-QUESTIONS OQ-29 记录，供复核。 |
| I-17 | **删除 Story 1 的 `GATE1_ITEM_IN_ANCHOR_SET` 不变量**，改成"Gate 1 从不写 anchor"的结构保证 + 运行时断言（`anchorsBefore === anchorsAfter`）。 | 原不变量无法静态判定，且会误伤合法流程（原始锚点被降级后再提升）。

**Story 2 加固项（承接 Story 1 追问）**
| # | 加固 | 说明 |
|---|---|---|
| H-1 | `recordUsage()` 现在返回前调用 `deepFreeze()` | 对已冻结项是零成本无操作；对手工构造项补上冻结，保证"使用过的项不可被改写"。已加测试。 |
| H-2 | 状态机新增显式优先级断言块（7 条） | 把 ①使用→F3/F4/F5 先于 ⑦F1、②A1 先于 ③NOOP 等优先级钉死。已加测试。 |
