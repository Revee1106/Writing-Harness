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

---

## 五、Story 3 实现解读（I-18 … I-21）与用户裁决落地

### 用户裁决（OQ-29 / I-17 / OQ-25–28 / Story 3 三项提议）

| 事项 | 裁决结果 | 落地 |
|---|---|---|
| OQ-29 保留原 ID | 接受，并补 5 条约束 | `fixed_by_user[].id ∈ SEED_F∪SEED_A`、`ambiguous[].id ∈ SEED_F∪SEED_A`、`open_questions[].id 严格 SEED_Q`、`raw_seed_anchor_ids 严格 SEED_F`、**新增不变量** `raw_seed_anchor_ids ⊆ (fixed_by_user ∪ ambiguous).id`（`ANCHOR_WITHOUT_ITEM`） |
| I-17 | 同意删除 `GATE1_ITEM_IN_ANCHOR_SET` | 已删除；§8.2 保证改由结构路径 + 服务断言 + 测试承担 |
| OQ-25 / 26 / 27 / 28 | 全部接受当前方案 | 无需改动 |
| 差异度判定 | 采纳 5 维度 + 2/3 规则 | `checkProposalDistinctness()`，warning 不阻塞 |
| SPR 边界 | 采纳 | `computeSeedPreservationRate()` |
| 字段路径白名单 | 采纳并冻结 | `src/core/proposal-field-paths.ts` |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-18 | **`delete` 原始锚点时同步移出 `raw_seed_anchor_ids`**；`demote` 不动锚点（§8.2）。服务层断言"anchors 只能因被删除而收缩，永不新增"。 | OQ-29 第 5 条不变量；§8.2 只约束升降级。 | 唯一允许的 anchor 变化；见 OQ-30。 |
| I-19 | **Proposal 的 ID 由 Harness 规范化**：`PROP_A/B/C` 按方案顺序，`ADD_###`/`RISK_###`/`CONF_###` 按各自数组顺序重编号；`risk.related_addition_refs` 通过"模型原 ID → 规范 ID"映射重写，无法解析则报错而不是猜。 | §9.1 的 ID 形态 + I-13 的一致性。 | 模型写错编号不会破坏可追溯性。 |
| I-20 | **`proposal_id` 不由模型输出**，由 Harness 按顺序分配 `PROP_A/B/C`。 | §9.3 的引用形态需要稳定的 proposal_id。 | 与 I-13 同一原则。 |
| I-21 | **`pov` 元素必须是 `CH_*` 角色 ID，长度 ∈ {1,2}**；`target_length` 为正整数（单位：中文字数）。 | §11.3 的 POV 规则按 §11「Blueprint 是 Scene Breakdown 的唯一故事规划来源」同样约束 Proposal；D6 已裁决 target_length 单位为中文字数。 | 文档未在 §9.1 重复说明，属于一致性约束。 |
| I-22 | **`altered` 必须与 `conflicts` 成对出现**（Prompt Contract 明文要求）；Schema 层不做强制（因为 `resolution` 可由用户在 Gate 2 直接改写），但开发者服务会对 `resolution=pending` 的冲突发出 `CONFLICT_PENDING` 提醒。 | §9.2「conflicts[] 必须能回答…Gate 2 最终处理结果」+ §9.1 的 altered 语义。 | Story 4 在 Gate 2 收口 resolution。 |
| I-23 | **Story Developer 的离线 fixture 采用 `gate1_status=skipped` 作为规范状态**（除一个 `partial`+promote 变体），因为 `skip` 是唯一"不修改 Interpreter 结果"的 Gate 1 出口。 | §5.1 skip 语义；离线可复现要求。 | fixture 元数据 `gate1_ops` 记录该状态，供 `fixtures:check` 复核。 |

---

## 六、Story 4 用户裁决落地与实现解读

### 用户裁决

| 事项 | 裁决 | 落地 |
|---|---|---|
| OQ-30 | 保持当前实现，并明确语义（delete 永久移出分母且不可经 Gate 2 恢复；demote 只改归属；edit 不改分母） | 已写入 OQ-30 表格 |
| OQ-31/32/33/34 | 全部接受 | 无改动 |
| OQ-10 | 新增 `projects/<id>/blueprint-history/<NNN>.meta.yaml`，与 `blueprint-<NNN>.yaml` 一一对应；含 `gate2_action_id: GATE2_<NNN>` 与 `user_edits[].id: EDIT_<NNN>`；不改 `blueprint.yaml` | `src/schema/gate2-meta.ts` + `src/io/paths.ts`（见解读 I-31） |
| OQ-18 | `truth_status` v0.1 只允许 `CONFIRMED` | `TRUTH_STATUSES = ['CONFIRMED']` |
| 合并粒度 | 逐字段指定来源 + 可手改；每条三条约束 | `resolveFieldPlan()` + `assembleBlueprint()`（见 I-32） |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-24 | `key_knowledge.known_by` 除"key 必须是 character id"外，**必须包含 meta.pov 的每一个角色**（值可为 false）。 | §13「POV Filter 根据当前 scene.pov 查询 known_by[current_pov]」：缺键会让 POV Filter 无法回答"开场是否已知"。 | 与 OQ-08（允许非 POV 角色存在）不冲突：那是下限，这是完整性要求。 |
| I-25 | `inner_state_pov_visible` 的取值必须是 `meta.pov` 的子集。 | §11.3 的字段语义是"哪些 POV 能看到这个角色的内心"，POV 维度之外的取值没有意义。 | 已在 Schema 校验。 |
| I-26 | Blueprint 内容项的 `status` 只允许 `CONFIRMED`；例外是 `seed_fidelity.added[].status = PROPOSED`（结构与 Proposal 一致，OQ-01 要求）。 | §6.4（CONFIRMED = Gate 2 接受）+ Story 10 F / 架构设计 §34 的 P2 测试要求"Harness 新增内容必须保持 source=harness、status=PROPOSED"。 | 由 `scanBlueprint()` 递归强制执行，例外范围被精确限定在 `seed_fidelity` 子树。 |
| I-27 | OBH / REL 的 ID 由 Harness 依角色 ID 生成：`OBH_<角色后缀>_<NN>`、`REL_<来源后缀>_<目标后缀>`（重复时追加 `_2`）。 | §11.1 示例 `OBH_LINYU_01` / `REL_LINYU_CHENMO` 只给了形态。 | 与 I-13/I-19 同一原则：ID 由 Harness 确定性分配。 |
| I-28 | **参与本次 Gate 2 的提案若存在 `resolution=pending` 的冲突，则拒绝确认**，并逐条给出 `--resolve` 命令。 | §6.2「conflict 不自动覆盖、不自动合并，在 Gate 2 由用户处理」+ §9.2「resolution 记录 Gate 2 最终处理结果」+ Story 4 验收 7。 | 裁决只写入 meta，不回写 proposals.yaml（用户裁决）。 |
| I-29 | `GATE2_<NNN>` 与 `blueprint_version` 一一对应；`EDIT_<NNN>` **跨版本全局递增**（扫描既有 meta 取最大值 + 1）。 | OQ-10 给出的 ID 形态 + `source_refs.type=user_edit` 必须可解析（§7.2）。 | 见 OQ-38。 |
| I-30 | Blueprint Builder 的 `derived_from` 只允许三种：`<参与提案>.<字段>` / `user_edit:<字段>` / `harness`。 | 用户裁决"每个字段必须带 source_refs，指向 Proposal 字段路径或标记 user_edit"。 | `harness` 映射为 `{type: blueprint_gate2, ref_id: GATE2_<NNN>}`。 |
| I-31 | **快照保持在 §29 冻结的 `history/blueprint-<NNN>.yaml`；新增的元数据写在 `blueprint-history/<NNN>.meta.yaml`；两者按同一 NNN 一一对应。** | OQ-10 要求新增 `blueprint-history/<NNN>.meta.yaml`，而 §29/§32 已冻结快照位置。 | 见 OQ-35；若改为同目录只需改 `src/io/paths.ts`。 |
| I-32 | 合并时**每个字段的 `derived_from` 必须是该字段字段计划里指定的那个提案**（或 `harness` / 对应的 `user_edit`）；引用其它提案报错，不静默换源。 | 用户裁决三条之二（"字段在两 Proposal 都有且用户未指定 → 报错，不自动取 A"）的延伸：既然来源由用户逐字段指定，输出就不能偏离计划。 | 报错信息会点明"字段计划来源是 X，但输出声明 Y"。 |
| I-33 | **manual 模式（全部字段用户手写）的 `seed_fidelity.preserved` 由 Seed 现存的 `raw_seed_anchor_ids` 直接构造**（id + 原文 value），`altered/added/risk` 为空。 | OQ-01 要求 Blueprint 顶层必须有 seed_fidelity；manual 模式没有参与提案可继承。 | 未新增字段；内容全部来自 Seed 本身，不虚构。 |
| I-34 | **单 POV 的 `inner_state_pov_visible` 默认规则**：POV 角色自身为 `[self]`，非 POV 角色为 `[]`（空数组合法）；双 POV 必须显式。 | §11.3 只说"单 POV 时可由 Builder 默认填入 `[meta.pov[0]]`"，但若所有角色都填 `[meta.pov[0]]`，会与架构设计 §21 / Story 5 的"非当前 POV 角色的 desire/fear/contradiction 不得进入 Writer 输入"直接冲突。 | 这是对 §11.3 的**收窄解读**，请复核（见 OQ-39）。 |
| I-35 | `blueprint_builder@0.1` 的结构化输入包含 `field_plan` / 参与提案 / `user_edits` / `conflict_resolutions`，**不含** `GATE2_<NNN>`；动作 ID 在装配阶段注入 `source_refs`。 | 让 recorded fixture 不随版本号变化，同时保证 `source_refs` 里的 Gate 2 动作可解析。 | fixture 可跨版本复用。 |

---

## 七、Story 5 用户裁决落地与实现解读

### 用户裁决

| 事项 | 裁决 | 落地 |
|---|---|---|
| OQ-39 | 接受收窄解读；**回写《架构设计》§11.3**（加入回写清单） | `src/gate2/assemble.ts`；回写清单见下 |
| OQ-35 | 接受当前布局，并明确 `blueprint-history/` 是 v0.1 对 §29/§32 的扩展 | `docs/OPEN-QUESTIONS.md` OQ-35；回写清单加入《架构设计》§32、《需求规格》§29 |
| OQ-40 | 不做内容一致性校验；只加 `meta.pov` 与 field_sources 中 pov 来源提案一致性的 **warning** | `src/gate2/service.ts` + 详见 I-39 |
| OQ-36 | `scene_type` 严格 4 种；OBH 接受 scene_type ∪ tone 联合白名单 | `src/core/scene-types.ts`（tone 标签集见 OQ-41） |
| OQ-11 | `{id: DIR_<source>_NNN, instruction, source}`，blueprint 来源带 blueprint_ref | `src/schema/scene.ts` |
| OQ-13 | 采纳并加 `resolution_note: string | null` | `src/schema/story-state.ts` |
| OQ-14 | proposed_additions 不回写、永久 PROPOSED、Compiler 全排除 | `src/schema/scene.ts`（Schema 级锁定 status/source） |
| OQ-15 | length ±30%；ending 用 `narrative_role_ref=BP_STR_END`；arc 细节由 dsh 提议 | `src/scenes/coverage.ts` |
| OQ-17 | 重跑需显式触发、覆盖 `/scenes/*.yaml`、`confirmed_scenes` 不变、消失 scene → ORPHANED | `runSceneBreakdown({rerun})` |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-36 | Scene 的 `proposed_additions[].id` 采用 **每个 Scene 内独立编号** `ADD_###`。 | §14 未定义该条目的结构；§9.1 已有 `ADD_###` 形态。 | 与 Story 3 的"每份 Proposal 内独立编号"一致，不新增前缀。 |
| I-37 | `narrative_role_ref` 允许 `BP_STR_*` 与 `BP_ARC_*`。 | §14 示例是 structure 位置；§16 的 Coverage 同时检查 structure 与 arc。 | 见 OQ-42。 |
| I-38 | **arc 覆盖判定**：该 arc 位置被 Scene 直接引用，或其映射的 structure 位置已被覆盖（START→BEG、SHIFT→TURN、END→END）。 | Story 5 起始会"arc 由 dsh 提议细节"。 | 见 OQ-42；arc 值为空时跳过判定。 |
| I-39 | **OQ-40 落地**：Gate 2 输出后比较 `meta.pov` 与该字段计划来源提案的 `pov`；不一致时产生 warning（不阻塞），在 CLI 打印、并写入 Gate 2 meta 的 `warnings`。 | OQ-40 裁决。 | 只提示，不做内容一致性校验。 |
| I-40 | `director_notes[].id` 的 `DIR_<source>_NNN` **在整个项目内唯一**（跨 Scene 递增），而不是每个 Scene 内从 001 开始。 | OQ-11 要求 Manifest 的 `overrides.director_surface_ref` 与 `director_surface.id` 一对一引用；重复 ID 会破坏可解析性。 | `DIR_SCENE_*` 与 `DIR_USER_*` 各自独立递增。 |
| I-41 | **Coverage 的 reveal_alignment 检查面向"Scene 中已声明的 `allowed_reveals`"**（每个 K 恰好被一个 Scene 覆盖），而不是重新推导一遍 Resolver 结果。 | §16 原文："对应 K ID 是否恰好出现在一个 Scene.allowed_reveals"。 | 这样即使有人手改 Scene，Coverage 依然能发现问题。 |
| I-42 | Story State 的 `occurred` 排序：按 `scene_id → Scene.order`，同一 Scene 内按 ID 字典序；重放时同一 Scene 内按**原数组物理顺序**（§17.3）。 | §17.3 明文要求"同一 Scene 内按 occurred 数组物理顺序"。 | upsert 用 ID 去重，不产生重复记录。 |
| I-43 | `referenced_blueprint_items` 与 `director_notes[].blueprint_ref` 接受 Blueprint 项 ID 的并集形态（`BP_*` / `K###` / `CH_*` / `OBH_*` / `REL_*`），"是否真实存在"由 Coverage 对照 Blueprint 校验。 | §16 的完整性检查是"Scene 是否引用不存在的 Blueprint ID"；Blueprint 项不止 `BP_*`。 | 新增 `ID_PATTERNS.blueprintItemRef`。 |

### 回写清单（累计）

| 目标文档 | 需要回写的内容 |
|---|---|
| 《架构设计》§11.1 | Blueprint 顶层新增 `seed_fidelity`（OQ-01） |
| 《架构设计》§11.3 | 单 POV 的 `inner_state_pov_visible` 默认规则收窄为"POV 角色 `[self]`、非 POV 角色 `[]`"（OQ-39 / I-34） |
| 《架构设计》§32、《需求规格》§29 | 新增 `blueprint-history/` 目录（Gate 2 元数据；OQ-10 / OQ-35） |
| 《需求规格》§25.1 / 《架构设计》§26 | `anti-ai-template-actions.yaml` 明确为项目级 + 仓库级 fallback（OQ-07） |
| 《需求规格》§11.3 | OBH 的 `applicable_scene_types` 明确为 scene_type ∪ tone 联合白名单（OQ-36 / OQ-41） |

---

## 八、Story 6 用户裁决落地与实现解读

### 用户裁决

| 事项 | 裁决 | 落地 |
|---|---|---|
| OQ-16 | 计数口径 = Unicode 码点、含所有非空白字符、不含空白/换行/制表符；在 project-config 的 max_chars 描述注明 | `src/core/text.ts`；`DRAFT_CONTEXT_MAX_CHARS_UNIT`；`config show` 打印口径 |
| OQ-12 | style/profile.yaml Schema 采纳 dsh 提议 + 四条补充（SAMPLE_<NNN> 不复用 / text 原样 / de_entity 与 sanitized_text 互斥 / tags 三必填）；linter.yaml 留到 Story 8 | `src/schema/style-profile.ts` |
| Manifest director_surface 组装规则 | Scene notes 原 id 原 source；style_direction 固定 `DIR_BLUEPRINT_001`；用户 note `DIR_USER_NNN` + user_override + overrides 一对一；禁止把 truth / proposed_additions 拆进去；只有 user_override 进 overrides | `src/context/compiler.ts` |
| excluded_sensitive.reason | 六类枚举锁定 | `EXCLUSION_REASONS` in `src/schema/context-manifest.ts` |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-44 | **`writer_context` 不落盘**：§29/§32 的文件结构里只有 `reports/context-manifest.yaml`，没有 writer_context 文件；Compiler 返回 writer_context（CLI 打印 / `--json`），只把 Manifest 写入磁盘。 | §29 / §32 文件结构 + "不新增文件结构"约定。 | 见 OQ-48。 |
| I-45 | **Manifest 落盘为 `reports/context-manifest.yaml`（当前编译的 Scene）**；`--all` 时逐场编译并打印摘要，磁盘上保留最后一场的 Manifest。 | §21 的 Schema 是"单个 Scene 一份 Manifest"，而 §29 只给了一个文件路径。 | 见 OQ-49；若需要每场一份，需先裁决新增目录。 |
| I-46 | **用户在 Compiler 降级路径补充的 note 同时满足两处语义**：写进 Manifest 的 `director_surface`（`source: user_override`）+ `overrides`；`--note` 传参形式不修改 Scene 文件，`breakdown --note` 才会把 note 持久化到 Scene 的 `director_notes`（`source: user`）。 | §22（用户可对 Scene 加 director_note，且进入 Manifest）+ OQ-11 的 source 联合。 | 避免在编译期静默改写已确认的 Scene。 |
| I-47 | **Scene 的 tone 判定**（OQ-47）：§14 的 Scene 没有 tone 字段，因此把"Scene 自身文本（purpose / conflict / turn / start_state / end_state / location / director notes）中出现的 tone 标签词"视为该场景的 tone；匹配集合 = `{scene_type} ∪ tone`。 | OQ-36（OBH 白名单是 scene_type ∪ tone）+ §23.1（Style Sample 也按 tone 匹配）。 | 若要让 tone 成为一等字段，需要裁决给 Scene 增字段。 |
| I-48 | `included_sensitive` 只记录**敏感**包含项（角色内心、allowed reveal、用户 override）；普通事实不逐条写入 Manifest。 | §21「普通非敏感 included facts 不逐条写入」。 | 角色内心以"当前 POV 可见"作为敏感项记录。 |
| I-49 | 非 POV 角色的 `type` 记 `future_content`、reason 记 `non_pov_inner_state`。 | §21 的 `excluded_sensitive.type` 枚举里没有"角色内心"这一类，而 reason 六类里有 `non_pov_inner_state`。 | type 取枚举内最贴近的一项，reason 精确表达原因。 |
| I-50 | 已确认（Gate 3 之后）的知识若在本场无 reveal 权限，排除 reason 记为 `user_override`；未揭示的记 `not_revealed_yet`。 | §15.5/§15.6（allowed_reveals 只决定本场权限）+ 六类 reason 枚举。 | 两类原因严格区分"用户已在正文里写过"与"计划尚未揭示"。 |

### 回写清单（累计，新增）

| 目标文档 | 需要回写的内容 |
|---|---|
| 《需求规格》§19.1 | `draft_context.max_chars` 的计数口径（Unicode 码点、含非空白、不含空白）（OQ-16） |
| 《需求规格》§23 / 《架构设计》§24 | `style/profile.yaml` 的 Schema（含 `de_entity` / `sanitized_text` 规则；OQ-12） |
| 《需求规格》§21 | `excluded_sensitive.reason` 六类枚举（OQ-44/Story 6 裁决） |

---

## 九、Story 7 用户裁决落地与实现解读

### 用户裁决

| 事项 | 裁决 | 落地 |
|---|---|---|
| OQ-47 | Scene 新增**必填** `tone: [tone_value, ...]`（≥1，取自八值枚举），由 `scene_breakdown@0.1` 输出，不从文本推断；OBH 匹配 = `scene_type ∪ tone` ∩ `applicable_scene_types` 非空即加载 | `src/schema/scene.ts` + `src/scenes/service.ts`（raw schema 与装配）+ `src/context/compiler.ts`（`sceneMatchTags`）；5 个 scene fixture 的 25 个 Scene 全部补 `tone`；demo 项目已重跑 |
| OQ-48 / OQ-49 | 保持现状：writer_context 不落盘、Manifest 单文件末次覆盖；Manifest 顶部加 `# Last compiled scene: scene-XXX` 注释 | `writeYamlFile(..., {headerComments})`；CLI `context` 写入时带头部注释 |
| OQ-50 | `excluded_sensitive.type` 扩为 6 类（新增 `character_inner_state`）；`included_sensitive.type` 不加新类；reason 词表不变 | `src/schema/context-manifest.ts` + 编译器改用新 type |
| Story 7 起始会 | 纯正文输出 / `drafts/scene-NNN.md` 无伴生文件 / 四条硬检查 + 三条软检查 / de_entity 硬软分流 | 见下方解读与 `src/writer/` |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-51 | **"实体原值"的判定方式**：对 `de_entity=true` 的样本，用码点级 LCS 求 `text` 与 `sanitized_text` 的差异片段，把"只在 text 中出现"的连续片段（长度 ≥2、非纯标点）视为被去实体化的实体原值；正文包含其中任一即硬失败。 | Story 7 裁决"de_entity=true：硬断言 Writer 输出不含 text 中对应实体原值"。 | 纯文本 diff，可测、可解释；不需要新增字段声明实体。 |
| I-52 | **硬检查使用"关键短语"**（按标点切分后长度 ≥4 码点的片段）做字面匹配。 | Story 7 裁决的四条硬检查需要可执行判定；语义判定属 Story 9。 | 保守（几乎不误报），代价是覆盖面窄；在汇报中已注明。 |
| I-53 | `UNCONFIRMED_CONTENT_MENTION` 是**软**检查：正文提到本场 `proposed_additions`（永久 PROPOSED）时提示，不失败。 | OQ-14（不回写、永久 PROPOSED）+ Story 7"不做语义判断"。 | 既不禁止写作，也不把未确认内容当事实。 |
| I-54 | Writer 的输入里**保留** `scene.target_length`（它属于受控上下文的一部分），但 Contract 明文声明其只是参考信息、由外部校验；Prompt 不把它写成硬性字数要求。 | 用户裁决"target_length 由外部校验，不放入 Prompt 作为硬约束"。 | 外部校验实现为 `LENGTH_DEVIATION` 软检查（<50% 或 >180% 提示）。 |
| I-55 | `prose_writer` fixture 的输入依赖项目状态（受控上下文 + Draft Context 链），因此这类 fixture **不使用 `seed:` 元数据**，改为声明 `source_project` + `scene`，由 `fixtures:check` 读取仓库内项目目录重建输入。 | 保证"fixture 不漂移"的既有承诺；Draft Context 的顺序依赖使 seed→…的链条无法唯一决定输入。 | 生成时必须**按 Scene 顺序**（先算哈希 → 写 fixture → 写 draft）。 |
| I-56 | Writer 运行前后自动做**项目状态快照比对**（seed / config / proposals / blueprint / story_state / coverage / manifest / style / scenes / history），一旦有差异直接报错。 | Story 7 裁决第 3 条（硬：不修改任何状态文件）。 | 与测试里的快照比对互为双重保险。 |

---

## 十、Story 8 用户裁决落地与实现解读

### 用户裁决

| 事项 | 裁决 | 落地 |
|---|---|---|
| OQ-51 | 接受；`fixtures:check` 在 prose_writer fixture 输入不匹配时必须**明确报错并列出差异**，不得静默跳过 | 工具对未注册构造器/重建失败的条目一律 `ok: false` + `problem` 文案，并以非 0 退出码结束（`scripts/refresh-recorded-fixtures.ts`） |
| I-52 | 保持保守，Story 7 阶段不提高硬检查强度 | 未改动 |
| 模板动作词表 | `{schema_version, version, actions:[{id: TA_NNN, pattern, severity, note?}]}`；字面匹配；变体独立成条；项目级覆盖仓库级；版本写入 `reports/linter.yaml` | `config/anti-ai-template-actions.yaml`（**24 条**，含 §25.1 点名 5 条）+ `src/schema/anti-ai-vocab.ts` |
| 五条规则阈值 | 见裁决（CV 0.30 / 0.35、对话 0.85 / 0.10、模板 ≥3 升级、升华连续 ≥3 段、三条最小长度门槛）；集中 `src/linter/thresholds.ts` 且可被 `project-config.yaml` 覆盖 | `src/linter/thresholds.ts` + `project-config.linter.thresholds` |
| 切分口径 | 句子 `。！？!?` + 换行；段落可配；对话 = `「」` / `""` / `''` 包裹 | `splitSentences` / `splitParagraphs(paragraphSplit)` / `collectDialogueSpans` |
| 升华词典 | 独立文件 `config/anti-ai-elevation-phrases.yaml` + 独立 version | **12 条**，`version: 2026.01` |
| `reports/linter.yaml` Schema | span 用 Unicode 码点偏移；顶部记录 `template_actions_version` / `elevation_phrases_version` / `disabled_rules`；evidence 按规则固定；Span 稳定性契约 | `src/schema/linter-report.ts`（OQ-53 记录 evidence 结构） |
| Severity 与噪声 | high 展开 / medium 折叠 / low 日志；词频类只进 `low_severity_log`；每条规则可单关，关闭项不产出但写入 `disabled_rules` | Schema 层强制（`low` 不得进 `warnings[]`；`word_frequency` 不得进 `warnings[]`；关闭的规则不得出现在 `warnings[]`） |
| 三条证明测试 | A 字节级稳定（`generated_at` 可注入）、B 语义文本零语义 warning、C rule/llm 同一 Schema | 全部落地并有独立用例 |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-57 | **`project-config.yaml` 新增 `linter.thresholds`（可选覆盖层）**：阈值默认值集中在代码常量，项目配置只放被覆盖的项；覆盖项的键集合与常量键集合一一对应（有测试锁定）。 | 用户裁决"五条规则阈值可被 project-config.yaml 覆盖，常量集中 src/linter/thresholds.ts"。 | 这是 Story 8 对 `project-config.yaml` 的唯一扩展。 |
| I-58 | **默认 severity**：五条规则的 warning 默认 `medium`；模板动作按词表条目自带的 `severity`（首版给"仿佛整个世界 / 时间仿佛静止"两条 high）；同一 action 命中 ≥3 次升级为 `high`。 | §25.3（high 展开 / medium 折叠 / low 日志）+ 用户裁决的升级规则。 | `low` 一律走 `low_severity_log`。 |
| I-59 | **词频类诊断**用 4-gram 词频（中文无分词依赖），阈值 `thresholds.wordFrequencyMinOccurrences`（默认 3，0 = 关闭），**只进 `low_severity_log`**。 | §25.1（词频类只 low、不默认弹给用户）+ Story 8 裁决。 | 未新增配置键，复用 thresholds。 |
| I-60 | **"段尾"的定义**：段落最后 **16 个非空白码点**内出现升华词典条目即视为该段"以升华句收尾"。 | 用户裁决"连续段尾升华模式"未给窗口口径。 | 见 OQ-54；窗口是常量，后续可调。 |
| I-61 | **`reports/linter.yaml` 采用"单文件、末次覆盖"**，并在文件顶部写 `# Last linted scene: ...` 与词表版本注释。 | 与 Manifest（I-45 / OQ-49）保持同一约定。 | 若需要"每场一份"，与 OQ-49 一并裁决。 |
| I-62 | `linter:` 字段值域 `rule | llm` 共用一个 Schema；`rule` 报告强制两个词表版本非空，`llm` 报告允许为 `null`。 | 用户裁决测试 C。 | Story 9 直接复用，不建平行结构。 |
| I-63 | 词表加载失败（两处都不存在或词表非法）时**明确报错**，不静默降级成"没有词表"。 | 需求规格 §25.1 / §26 要求冻结词表；静默降级会让 Linter 形同虚设。 | `AntiAiVocabError`。 |

---

## 十一、Story 9 用户裁决落地与实现解读

### 三个追问的答复（Story 8 汇报补充）

| 追问 | 答复 |
|---|---|
| 测试 B 断言写死 | 已改为硬编码：**唯一允许命中的规则是 `paragraph_ending_elevation`**，其余四条（`template_actions` / `sentence_length_variance` / `paragraph_length_variance` / `dialogue_ratio`）**必须零命中**；用例说明也写清了"为什么这段语义文本只会命中它"（见 `tests/acceptance/story8.acceptance.test.ts` 验收 D） |
| "仿佛整个世界 / 时间仿佛静止"在哪个词表 | 在 **模板动作词表** `config/anti-ai-template-actions.yaml` 里，分别是 `TA_016` / `TA_017`，`severity: high`（命中 1 次即 high，不走"≥3 次升级"）。**升华词典是另一个文件**：`config/anti-ai-elevation-phrases.yaml`（`EL_NNN`，12 条），其条目**同样带 `severity`**（OQ-52 采纳）。两个词表各自独立 `version`，分别写入报告的 `template_actions_version` / `elevation_phrases_version` |
| `linter: llm` 报告里两个版本键的写法 | **保留键、值为 `null`**（Story 9 起始会裁决 3）：这样 rule / llm 共用同一 Schema、顶层键集合完全一致，工具与测试不需要分支判断（`validateLinterReport` 对 `rule` 报告强制非空、对 `llm` 报告允许 null） |

### 用户裁决（Story 9 起始会五项）

| 事项 | 裁决 | 落地 |
|---|---|---|
| LLM Linter Contract | 只给 Scene 正文 + scene_id/pov/purpose + 五类语义类型 + 判定准则；输出严格 YAML 且**只有 `findings[]`**；每项 `{type, span:{start,end}, reason}`；span 用码点；reason 必填 ≤200 非空白码点；不允许输出"建议改写文本"；无法判定输出 `findings: []` | `src/prompts/llm_linter@0.1.md` + `src/linter/llm-linter.ts`（`rawLlmOutputSchema` 是 strictObject，多余键直接报错） |
| span 稳定性与合法性 | `0 ≤ start < end ≤ 码点总数`、回切非空、同一 finding 集合内不得完全重叠；不合法 → 丢弃 + `low_severity_log: [{code: "llm_span_invalid"}]`；不 fail 整个 Linter；**不做 golden 稳定性测试**，用 fixture 回放保证稳定 | `validateFindings()`；LLM 报告确认不承诺字节级稳定（测试只做 fixture 回放） |
| Local Rewrite 契约 | 输入 span + 切片 + warning + 前后一段 + Scene 元信息 + Style Samples；输出纯文本（无引号 / 前缀 / Markdown）；长度 ≤ 原 span 的 3 倍；无法改写输出原文本；不得引入 Scene 外实体 / 未授权 truth / 改变 end_state 语义；**拼接后除 span 外字节级一致** | `src/prompts/local_rewrite@0.1.md` + `src/linter/rewrite.ts`（`validateRewrite()` + 拼接守恒断言） |
| Rewrite 落回 | 原地改写 `drafts/scene-NNN.md`；对应 warning 加 `rewrite: {applied, before, after, rewrite_contract, rewritten_at}`；不新增备份文件；不实现自动回滚 | 已落地；有"drafts 目录只含 `.md`"的断言 |
| 二次检查范围 | Rule Linter 重跑 span 所在段落 + 相邻段落；LLM Linter 检查 span ± 前后一段；范围**独立定义**；局部结果替换范围内旧 warning，范围外不变；ID 重新分配不复用；终稿前/用户请求时跑完整 Linter（`--full`） | `src/linter/relint.ts`（`ruleRelintRange` / `llmRelintRange` 两个独立函数）+ `--full` |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-64 | **`linter: llm` 报告保留两个词表版本键、值为 `null`。** | 裁决 3 的落地选择。 | 与 "rule/llm 同一 Schema" 一致。 |
| I-65 | **`low_severity_log[]` 增加可选 `code` 字段**（`llm_span_invalid` 等）；Story 8 的 `kind` 保留不动。 | 裁决 2 要求 `low_severity_log: [{code: "llm_span_invalid", ...}]`，而 Story 8 已冻结 `kind`。 | 两者同时写入，避免破坏既有产物。 |
| I-66 | **五类语义类型默认 severity**：`author_summary` / `subtext_exposed` = **high**；`emotion_repeated` / `voice_blur` / `over_explanation` = medium。 | §25.3 的展示策略 + Story 9 未规定。 | 见 OQ-56（待复核）。 |
| I-67 | **`reports/linter.yaml` 仍是"单文件、末次覆盖"**；一次 `lint --llm` 写 llm 报告，一次 `rewrite` 写"局部重跑报告"，因此报告可能同时包含 llm 与 rule 的 warning（各自 `linter` 字段标识）。 | OQ-55 / I-61 的同一约定 + 裁决 5 的"局部替换"。 | 报告级 `linter` 表示"最后一次完整运行的 Linter"，warning 级 `linter` 表示该条来源；见 OQ-57。 |
| I-68 | **"不得改变 end_state 语义"的可执行代理**：改写前正文中已存在的 `end_state` 关键短语，改写后必须仍然存在（不存在则拒绝）。 | 裁决 3 的语义要求需要可执行判定；深度语义留给人工与后续版本。 | 保守：不新增 end_state 要求。 |
| I-69 | **被改写的目标 warning 在局部重跑中保留**（携带 `rewrite` 审计记录），其余范围内旧 warning 被替换；若重跑结果与目标 span 完全一致则不重复记录。 | 裁决 4（rewrite 记录留在 warning 上）与裁决 5（局部替换）的组合语义。 | 否则 `rewrite` 记录会被局部重跑清掉。 |
| I-71 | **替换文本不得与紧邻上下文形成"重叠重复"**：替换文本与紧邻前文的最长重叠片段、或与紧邻后文的最长重叠片段，达到 **4 码点**即拒绝（上限检查 12 码点）。 | Story 9 裁决 3 的"不得引入新事实"与"拼接自然"需要一道防线；实际演示中曾出现"手机亮了一次，手机亮了一次，又暗下去。"这类重复粘贴。 | 阈值常量在 `validateRewrite()` 内；4 码点以下不判，避免误伤正常衔接。 |
| I-70 | LLM Linter 与 Local Rewrite 的 fixture 都不使用 `seed:` 元数据，改为 `source_project` + `scene`（`local_rewrite` 另有 `rewrite_target` 元数据），工具链通过 `prepareRewrite()` / `buildLlmLinterInput()` 重建与运行时逐字段一致的输入。 | 输入依赖项目状态（正文 + Scene + Style Samples）。 | 与 I-55 同一思路。 |

---

## Story 10 起始会裁决（Gate 3 + State Extractor + 评估）

| 事项 | 裁决 | 落地 |
|---|---|---|
| `final.md` 的形态 | 由 `drafts/scene-NNN.md` **按 Scene `order` 拼接**，场景之间空行分隔；**不含标题、不含任何元数据、不含分隔符**；写入时末尾补一个换行 | `src/state/gate3.ts` 的 `assembleFinalDraft()` / `assembleFinalFromProject()` |
| 缺稿处理 | 任一 Scene 缺 Draft（或 Draft 为空白）时**抛错**，不静默跳过、不生成"少一场"的 final.md | `assembleFinalDraft()` 抛 `Gate3Error`；`runGate3()` 前置检查 `missingSceneIds` |
| Gate 3 的粒度 | **整篇一次性确认**（`--confirm`）；逐场确认属于 Story 9 的 Rewrite 范畴，不在这里做 | `runGate3()`：`confirm!==true` 直接报错；无 `--confirm` 时只做 dry-run |
| `confirmed_scenes` 的写入 | Gate 3 一次性写入**全部** Scene（按 order），不做增量 | `runGate3()` 组装 `confirmedScenes` 后一次校验写入 |
| Scene Draft 的保留 | Gate 3 **不删稿、不合并文件**，`drafts/scene-NNN.md` 全部保留，另生成 `drafts/final.md` | 断言见 Story 10 验收 A |
| `payload.revealed_to` 的比对 | 由 **Harness** 比对（不是让 LLM 自证）：`==` 计划 → 正常；**真子集** → 正常 + `low_severity_log: [{code: "revealed_to_narrower_than_plan"}]`；**真超集** → `OCCURRED_CONFLICT`；**无交集** → `OCCURRED_CONFLICT` | `compareExtraction()`，集合语义、与元素顺序无关 |
| `relationship_change.from_state` | 从 `story_state.relationship_state` 读取当前值；候选给出的 `from_state` 不一致 → `OCCURRED_CONFLICT`（不写状态） | `compareExtraction()`；断言见 Story 10 验收 B |
| 冲突的落点 | 冲突写入 `story_state.state_rebuild_conflicts`（`type: OCCURRED_CONFLICT`）；**冲突不产生事实**（不写 occurred、不动投影、不回写 Blueprint） | `applyOccurredToState()` |
| 测试集位置 | Story Development Test Set 与 Anti-AI A/B Test Set 都放在 `tests/fixtures/evaluation/`，**不进 `projects/`**，不修改 §29/§32 的文件树 | `src/eval/evaluation.ts` 的 `EVALUATION_ROOT` |
| Anti-AI A/B 的范围 | v0.1 只准备**可运行的 A/B 对照 + 人工填写模板**：**不做盲测、不自动评分** | `eval ab-generate` → `session-00N/{group-GNN.a.txt, group-GNN.b.txt, ratings.csv, session.yaml}` |
| A/B 评分列 | `group_id, text_a_file, text_b_file, rater_id, more_humanlike, more_natural, dialogue_more_natural, characters_more_alive, lower_ai_feel, want_to_continue, notes` | `ANTI_AI_CSV_COLUMNS`（只冻结列，不冻结取值） |
| Story 10 不新增 Schema | Gate 3 / State Extractor / 评估资产一律复用既有 8 份 Schema；**不新增** `story_state.final_ref` 之类字段 | Story 10 验收 G 断言 `src/schema/` 文件清单不变 |

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-72 | `assembleFinalDraft()` 在"Scene 缺少 Draft / Draft 为空白"时**抛错**；纯函数与项目级组装（`assembleFinalFromProject()`）行为一致。 | P1/P4 的可执行要求：静默跳过会让 `final.md` 少一场而 Gate 3 仍认为"整篇已确认"。 | 原先纯函数只过滤空白文本，Story 10 起始收紧。 |
| I-73 | `state_extractor@0.1` 的 fixture **不使用 `seed:` 元数据**，改用 `source_project`（+ `scene`），工具链通过 `buildStateExtractorInput()` 重建与运行时逐字段一致的输入。 | 与 I-55 / I-70 同一思路：输入依赖项目状态（Scene 正文 + 投影）。 | `pnpm fixtures:check` 可复核。 |
| I-74 | `plain_prompt@0.1` 是**评估专用契约**：输入只有 Scene Intent（无 POV 过滤、无 Style Samples），A 侧 fixture 不带 `seed:` 元数据，由 `buildPlainPromptInput()` 重建输入。 | Story 10 D 节要"可运行的 A/B 对照"；A 侧必须能离线复现，否则对照不可重复。 | 该契约不参与创作流程；`eval ab-generate` 与 fixture 复核共用同一个构造函数。 |
| I-75 | 低危日志（如 `revealed_to_narrower_than_plan`）v0.1 **只在 Gate 3 结果对象 / CLI 输出中可见，不落盘**。 | `story_state` 没有承载它的字段，而 Story 10 的硬边界是"不新增 Schema"。 | 见 OQ-59（待裁决是否需要单独的报告文件）。 |
| I-76 | `low_severity_log[].code` 的取值随 Story 10 扩展出 `revealed_to_narrower_than_plan`（沿用 I-65 的 `code` 字段，不新增字段）。 | 裁决 2 的"低危日志"需要可机读的代码。 | 与 `llm_span_invalid` 同一字段。 |
| I-77 | `story_state.state_rebuild_conflicts[].type` 扩为 `['ORPHANED', 'OCCURRED_CONFLICT']`（枚举扩展，**不新增 Schema**）。 | Gate 3 后的冲突（§8"不覆盖、不自动合并，由用户裁决"）需要与重建期 `ORPHANED` 区分。 | 沿用 OQ-50 的"扩枚举"先例；`SRC_NNN` 编号复用（Story 10 用 `conflictOffset` 避免与既有冲突撞号）。 |

### 回写清单（累计，新增）

| 目标文档 | 需要回写的内容 |
|---|---|
| 《需求规格》§17 / 《架构设计》§17 | `low_severity_log[].code` 字段与 `revealed_to_narrower_than_plan` 取值；低危日志在 v0.1 不落盘（OQ-59 / I-75 / I-76） |
| 《需求规格》§31.1 | Story Development Test Set 的存放位置（`tests/fixtures/evaluation/story-development/`）与"哪些 Seed 有 fixture 覆盖"的口径（OQ-60） |
| 《需求规格》§31.2 | Anti-AI A/B Test Set 的 11 个人工评分列；明确 "v0.1 不执行盲测、不自动评分" |
| 《需求规格》§31.3 | Author Cost 的列定义（`AUTHOR_COST_CSV_COLUMNS`），由项目状态可复算 |
| 《开发 Story 拆分》Story 10 | **v0.1 的 8 点自检条款原文**（仓库中缺失，见 OQ-61，需要原文回填） |
| 《架构设计》§29 / §32 | **无改动**：Story 10 的产物（`drafts/final.md`）落在既有 `drafts/` 下，评估资产在 `tests/`，文件树未新增条目 |

---

## 十二、Story 10 封版裁决（v0.1 收尾）

### 用户裁决

| 事项 | 裁决 | 落地 |
|---|---|---|
| OQ-61（8 点自检原文） | v0.1 的 8 点自检**原文在《开发 Story 拆分》Story 10 G 节**：① 一句话 Seed 可以形成可用 Blueprint ② Gate 顺序低摩擦 ③ Blueprint 可稳定拆 Scene ④ Proposal 不会渗透 Writer ⑤ POV / secret / future 不明显泄漏 ⑥ Seed Preservation Rate 可测 ⑦ Harness 正文在 AI 感维度出现明确改善趋势 ⑧ 用户不承担高频审批。**重建版在第 1、7、8 条偏离原文，必须替换**（第 1 条泛化成"链路"丢了 Blueprint；第 7 条把"改善趋势"降级为"可运行"；第 8 条跑偏成技术指标，原文是产品指标）。 | `tests/acceptance/story10.acceptance.test.ts` 的"验收 F"已按原文逐条替换，每条给出可执行证据（见下表） |
| OQ-59（低危日志） | **不新增 `reports/state-extraction.yaml`**；低危日志保持 CLI 输出可见，需要留档用 **stdout 重定向**。 | `runGate3()` 返回 `lowSeverity`，`harness gate3 --confirm` 打印 `low_severity_log`；`--json` 同样可见；不落盘 |
| OQ-60（测试集覆盖） | **补齐 5 个 fixture：情感 / 悬疑 / 温情 / 现实 / 轻科幻**；**接受 3 个 `corpus_only`：开放结局 / 单场景 / 强反转**；**补齐后 `measured` 达到 7 个**。 | `seeds.yaml`：measured = SD_001/SD_002（项目型）+ SD_003…SD_007（fixture 型，离线回放）；corpus_only = SD_008…SD_010 |
| A/B 归一化验证 | 报告 A 侧 / B 侧**平均码点数**与**每千码点 warning 数**；长度接近（±20%）时 41:4 直接可信，否则以归一化结果为准；该归一化结果**进自检第 7 条证据**。 | `summarizeAbSession()` + `harness eval ab-report`；结果见下 |
| demo 说明 | 在 README 注明"demo 为离线可复现的压缩样本（110–200 码点/场），非产品级输出"，避免误读为产品能力。 | `README.md` 的"演示项目"小节 |

### 8 点自检（原文版）与可执行证据

| # | 原文 | 可执行证据（`tests/acceptance/story10.acceptance.test.ts` 验收 F） |
|---|---|---|
| ① | 一句话 Seed 可以形成可用 Blueprint | 两个 demo 的 Blueprint 通过 Schema，且 structure / characters / key_knowledge / style_direction 齐全；Seed 锚点被 preserved ∪ altered 全覆盖（无静默丢弃） |
| ② | Gate 顺序低摩擦 | `explicit_gates === 3`（Gate 1 + Gate 2 + Gate 3），`blueprint_versions === 1`，拆场不产生额外审批 |
| ③ | Blueprint 可稳定拆 Scene | Coverage：`structure_covered === scenes.length`、`warnings === []`；重跑拆场后 Scene 文件**逐字节一致** |
| ④ | Proposal 不会渗透 Writer | 每场编译上下文（context + manifest）序列化后不含 `PROP_` / `proposal_id`，且不含 proposals.yaml 的任何原文行 |
| ⑤ | POV / secret / future 不明显泄漏 | 每场 `future_content_exposed === false`、`unconfirmed_proposal_exposed === false`；内心状态只允许 POV 自己（非 POV 只能进 `excluded_sensitive`，`reason: non_pov_inner_state`）；Key Knowledge 的 truth 在揭示场景之前不出现在正文 |
| ⑥ | Seed Preservation Rate 可测 | 7 个 measured Seed 全部给出百分比，`unaccounted_anchors === 0`，且既有 100% 也有 <100%（有区分度） |
| ⑦ | Harness 正文在 AI 感维度出现明确改善趋势 | 归一化后 A 47.56/千码点 : B 2.55/千码点（B/A = 0.054，单位长度 AI 味信号下降 ≥75%）。**限定：v0.1 初版信号，样本量有限（10 组 / A 侧 862 码点），方向明确但需 v0.2 扩大样本验证** |
| ⑧ | 用户不承担高频审批 | 每项目 3 次显式 Gate、`explicit_gates / scenes < 1`、rewrite ≤1 次（按需）；gate3 只有整篇 `--confirm`，无逐场确认 |

### A/B 归一化结果（封版证据）

| 口径 | A 侧（普通 Prompt） | B 侧（Writing Harness） | B/A |
|---|---|---|---|
| 分组数 | 10 | 10 | — |
| 平均码点 / 场 | 86 | 157 | 1.817（B 长 82%） |
| 合计非空白码点 | 862 | 1566 | — |
| Rule Linter warning 合计 | 41 | 4 | 0.098 |
| **每千码点 warning** | **47.56** | **2.55** | **0.054** |
| 判定 | 长度差 82% > 20% → **以归一化结果为准** | | |

命令：`pnpm harness eval ab-report`（只做长度归一化，不做质量判定）。

> **限定**：本 A/B 为 v0.1 初版信号，样本量有限（10 组，A 侧合计 862 码点），
> 结论方向明确但**需要在 v0.2 扩大样本验证**。

### 实现解读

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-78 | **fixture 型 measured Seed 走产品同一条代码路径量测**：`runSeedInterpreter` → `applyGate1Operations` → `runStoryDeveloper`（provider = recorded），指标由 `buildStoryDevelopmentRows()` 现算。 | OQ-60 裁决要求 measured 达到 7 个，而评估资产不得写进 `projects/`（Story 10 起始会裁决）。 | `eval story-development` 与 `tests/` 共用此函数；不允许硬编码指标。 |
| I-79 | 测试集条目的 `text` **直接读 Seed 文件**（`seed_file`），并在加载时校验与内联 `text` 一致；文件缺失即报错。 | 测试集里的文本必须与真正喂给模型的那份逐字一致。 | 见 `loadStoryDevelopmentSeedSet()`。 |
| I-80 | A/B 归一化阈值 `AB_LENGTH_TOLERANCE = 0.2`：`|B/A − 1| ≤ 0.2` 时原始计数可信，否则以每千码点为准。 | 封版裁决"4"要求给出归一化口径。 | 判定与两个口径都打印，不隐藏。 |

---

## 十三、封版后文档维护清单（v0.1 → 三份冻结文档的统一回写）

本清单是**唯一入口**：v0.1 实现过程中所有"与三份冻结文档不一致 / 文档未定义而由实现补齐"的事项，
按"目标文档 + 章节 + 变更性质"逐条列出，供后续统一回写。
**回写进度**：批次 1（状态模型核心）✅ 已完成 —— 条目 1 / 2 / 3 / 4 / 5 / 6 / 7 / 9 / 32（+ I-81/I-82/I-83 澄清与代码收紧）；
批次 2（POV / 隔离 / 报告 / Style）✅ 已完成 —— 条目 12 / 13 / 14 / 15 / 16 / 17 / 18 / 19 / 20；
批次 3（文件结构 / 评估）—— 条目 21 / 22 / 23 / 24 / 25 / 26 / 27 / 28；
批次 4（状态与冲突模型补漏）—— 条目 8 / 10 / 11 / 29 / 30 / 31（+ 架构 §17 镜像）。
章节级进度见 §十五。

（章节号以 v0.1 冻结版文档为准；`性质` 取值：**新增** / **扩展枚举** / **补充定义** / **收窄解读** / **位置明确** / **无改动（仅备案）**。）

| # | 目标文档 | 章节 | 变更性质 | 需要回写的内容 | 来源 |
|---|---|---|---|---|---|
| 1 | 《架构设计》 | §11.1 | 新增 | Blueprint 顶层新增 `seed_fidelity`（`preserved / altered / added / risk`，结构与 Proposal 一致），Seed Preservation Rate 以它为准 | OQ-01 / I-26 |
| 2 | 《架构设计》 | §11.1 | 补充定义 | OBH / REL 的 ID 由 Harness 依角色 ID 生成：`OBH_<角色后缀>_<NN>`、`REL_<来源后缀>_<目标后缀>`（重名追加 `_2`） | I-27 |
| 3 | 《架构设计》 | §11.3 | 收窄解读 | 单 POV 的 `inner_state_pov_visible` 默认规则：POV 角色 `[self]`、非 POV 角色 `[]`（避免非 POV 内心进入 Writer 输入） | OQ-39 / I-34 |
| 4 | 《架构设计》 | §11.3 | 补充定义 | OBH 的 `applicable_scene_types` = **scene_type ∪ tone 的联合白名单**（交集非空即加载） | OQ-36 / OQ-41 |
| 5 | 《架构设计》 | §14 | 新增字段 | Scene 新增**必填** `tone: [tone_value, ...]`（≥1，八值枚举：conflict / tension / tenderness / restraint / absurdity / suspense / warmth / grief），由 `scene_breakdown@0.1` 输出，不从正文推断；**`narrative_role_ref` 保持 structure 位置（`BP_STR_*`），不挂 arc 位置**（arc 覆盖由 §16 判定） | OQ-47 / OQ-42（复议） |
| 6 | 《需求规格》 | §9.4 / §10.2 | 补充定义 | Seed Preservation Rate 的计算对象与公式：分母 = `raw_seed_anchor_ids`，分子按 preserved + 部分计权 altered，未记账锚点必须为 0 | OQ-01 / I-26 |
| 7 | 《需求规格》 | §14 | 新增字段 | 同第 5 条（Scene 的 `tone`）；`narrative_role_ref` **以 `BP_STR_*` 为准**，arc 覆盖判定按 §16（映射 START→BEG / SHIFT→TURN / END→END） | OQ-42（复议）/ OQ-47 |
| 8 | 《需求规格》 | §16 | 补充定义 | Coverage 各类型 severity：structure / ending / reveal_alignment / blueprint_reference_integrity = high，length / arc = medium；warning 一律不阻塞 | OQ-44 |
| 9 | 《需求规格》 / 《架构设计》 | §17 | 扩展枚举 | `low_severity_log[].code` 字段与取值（`llm_span_invalid`、`revealed_to_narrower_than_plan`）；并注明低危日志在 v0.1 **不落盘**，需要留档用 CLI stdout 重定向 | OQ-59 / I-65 / I-75 / I-76 |
| 10 | 《需求规格》 | §18.1 | 补充定义 | OCCURRED 的 payload 命名：knowledge 用 `payload.knowledge_ref`、relationship 用 `payload.relationship_ref`；`story_state.*_state[].blueprint_ref` 保持不变，代码保证二者指向同一 ID | OQ-06 |
| 11 | 《需求规格》 | §19.1 | 补充定义 | `draft_context.max_chars` 的计数口径：Unicode **码点**，含非空白字符、不含空白与换行 | OQ-16 |
| 12 | 《需求规格》 | §21 | 扩展枚举 | `excluded_sensitive.type` 扩为 6 类（新增 `character_inner_state`）；`reason` 六类枚举（含 `non_pov_inner_state`） | OQ-44 / OQ-50 |
| 13 | 《需求规格》 | §21 | 位置明确 | Manifest 为**单文件、末次覆盖**（`reports/context-manifest.yaml`），顶部加 `# Last compiled scene: scene-XXX`；`writer_context` 不落盘 | OQ-48 / OQ-49 / I-44 |
| 14 | 《需求规格》 | §22 | 补充定义 | `director_note` 的两条路径：`breakdown --note` 持久化到 Scene（`source: user`）；`context --note` 只进 Manifest 的 `director_surface` + `overrides`（`source: user_override`），不改 Scene 文件 | I-46 |
| 15 | 《需求规格》 / 《架构设计》 | §23 / §24 | 补充定义 | `style/profile.yaml` 的 Schema（含 `de_entity` / `sanitized_text` 规则）；Style Sample 匹配降级顺序 `pov+scene_type+tone → pov+scene_type → pov → none` | OQ-12 / OQ-36 |
| 16 | 《需求规格》 | §25.1 | 位置明确 | `anti-ai-template-actions.yaml` 为**项目级**配置 + 仓库级默认词表 fallback；升华词典 `anti-ai-elevation-phrases.yaml` 同构（独立 `version`） | OQ-07 / OQ-52 |
| 17 | 《需求规格》 | §25.2 | 补充定义 | `reports/linter.yaml` 为**单文件、末次覆盖**（顶部 `# Last linted scene:`），rule 与 llm 报告共用同一 Schema（各自 `linter` 字段标识） | OQ-55 / OQ-57 / I-61 / I-64 / I-67 |
| 18 | 《需求规格》 | §25.2 / §25.3 | 补充定义 | `evidence` 按规则的固定结构（template_actions / sentence_length_variance / paragraph_length_variance / dialogue_ratio / paragraph_ending_elevation）；"段尾"窗口 = 段落最后 16 个非空白码点；五类语义类型默认 severity（author_summary / subtext_exposed = high，其余 medium） | OQ-53 / OQ-54 / OQ-56 / I-60 / I-66 |
| 19 | 《需求规格》 | §27 | 补充定义 | Local Rewrite 契约与落回规则：输出纯文本、长度 ≤ 原 span 的 3 倍、拼接后除 span 外字节级一致、原地改 `drafts/scene-NNN.md`、warning 上留 `rewrite` 审计、不备份不回滚；重叠重复 ≥4 码点拒绝（I-71） | Story 9 裁决 / I-68 / I-71 |
| 20 | 《需求规格》 | §27 | 补充定义 | 局部二次 Linter 范围：Rule = span 所在段落 ±1；LLM = span ±1 段落；范围独立定义、ID 重新分配、`--full` 跑全篇 | Story 9 裁决 / I-69 |
| 21 | 《需求规格》 | §29 | 新增目录 | `projects/<id>/` 下新增 `blueprint-history/<NNN>.meta.yaml`（Gate 2 元数据），与 `history/blueprint-<NNN>.yaml` 按同一 NNN 一一对应 | OQ-10 / OQ-35 / I-31 |
| 22 | 《架构设计》 | §32 | 新增目录 | 同上（架构侧文件树同步新增 `blueprint-history/<NNN>.meta.yaml`） | OQ-10 / OQ-35 / I-31 |
| 23 | 《需求规格》 | §29 | 无改动（仅备案） | 未新增其它条目：`drafts/final.md` 落在既有 `drafts/` 下；评估资产在 `tests/fixtures/evaluation/`（不在 `projects/`） | Story 10 起始会裁决 |
| 24 | 《架构设计》 | §32 | 无改动（仅备案） | 同上（架构侧文件树未新增其它条目） | Story 10 起始会裁决 |
| 25 | 《需求规格》 | §31.1 | 位置明确 | Story Development Test Set 存放于 `tests/fixtures/evaluation/story-development/`；10 个 Seed，measured 7（2 项目型 + 5 fixture 型：情感 / 悬疑 / 温情 / 现实 / 轻科幻），corpus_only 3（开放结局 / 单场景 / 强反转） | OQ-60 / I-78 / I-79 |
| 26 | 《需求规格》 | §31.2 | 补充定义 | Anti-AI A/B Test Set 的 11 个人工评分列；**v0.1 不执行盲测、不自动评分**；长度归一化口径（±20% 阈值 + 每千码点 warning） | Story 10 裁决 4 / I-80 |
| 27 | 《需求规格》 | §31.3 | 补充定义 | Author Cost 的列定义（`AUTHOR_COST_CSV_COLUMNS`），可由项目状态复算 | Story 10 E |
| 28 | 《开发 Story 拆分》 | Story 10 G | 补充定义 | v0.1 的 **8 点自检原文**（本文件 §十二 已收录）与逐条可执行证据；建议在文档中给出证据位置 | OQ-61 |
| 29 | 《架构设计》 | §8 | 补充定义 | `story_state.state_rebuild_conflicts[].type` 扩为 `['ORPHANED', 'OCCURRED_CONFLICT']`（枚举扩展，不新增 Schema） | I-77 |
| 30 | 《架构设计》 | §34 | 补充定义 | P2 原则的可执行判定补充：Blueprint 内容项 `status` 只允许 `CONFIRMED`，唯一例外是 `seed_fidelity.added[].status = PROPOSED` | I-26 |
| 31 | 《需求规格》 | §6.2 / §9.2 | 补充定义 | 参与本次 Gate 2 的提案若存在 `resolution=pending` 的冲突则**拒绝确认**；裁决只写 meta，不回写 `proposals.yaml` | I-28 / I-29 |
| 32 | 《需求规格》 | §7.2 | 补充定义 | Gate 2 的 `source_refs` 三形态：`<参与提案>.<字段>` / `user_edit:<字段>` / `harness`（→ `blueprint_gate2` + `GATE2_<NNN>`）；**用户手改的两级区分**：记录级 `EDIT_<NNN>`（meta.`user_edits[].id`，最终写进 Blueprint）与字段级装配输入 `user_edit:<字段路径>`（按 `field` 解析为 `EDIT_<NNN>`，查不到即报错）；合并时字段来源必须与字段计划一致，不静默换源 | I-30 / I-32 / I-29 / I-81 |

---

## 十四、回写期裁决（批次 1 审核 → 批次 2 起始会）

| 事项 | 裁决 | 落地 |
|---|---|---|
| **追问 1：`narrative_role_ref` 允许 `BP_ARC_*` 是需求还是推导？** | **推导补充，不予采纳。** 依据：I-37 与 OQ-42 的状态是 **"已落地（dsh 提议）"**，是 dsh 为实现 §16 的 arc 检查提出的读数，**不是用户裁决的真实需求**；Story 5 I-38 已给出"直接引用**或**映射 structure"的路径。裁决：**文档不得写"Scene 允许挂 `BP_ARC_*`"**，v0.1 走 I-38 的映射路径，Scene 的 `narrative_role_ref` 以 structure 位置为准。 | 已从《需求规格》§14 与《架构设计》§14 删除该声明，改为"arc 覆盖由 §16 按映射判定"；维护清单条目 5 / 7 同步修正。**I-37 标注为"经复议不采纳"** |
| **I-37 复议后与实现的分歧** | 初次记录时实现 `src/schema/scene.ts` 仍接受 `BP_ARC_*`（比文档宽松）。**用户随后授权同批修代码**：已收紧为只接受 `BP_STR_*`，代码与文档一致。 | 见 **I-83**；OQ-62 状态改为 **"已处理（同批收紧）"** |
| **追问 2：`user_edit:<字段路径>` 与 `EDIT_<NNN>` 冲突？** | **不是笔误，是两级不同对象。** 依据：I-29（`EDIT_<NNN>` 跨版本全局递增，是 `blueprint-history/<NNN>.meta.yaml` 的 `user_edits[].id` 记录级 ID）+ I-30（`derived_from` 允许 `user_edit:<字段>`，是**装配输入**的字段级形态）+ 实现（`src/gate2/assemble.ts`：`user_edit:<field>` → 按 `field` 匹配 → `{type: user_edit, ref_id: EDIT_<NNN>}`；查不到手改记录即报错；`from: user` 无记录时回落 `blueprint_gate2`/`GATE2_<NNN>`）。 | 需求规格 §7.2 已写明两级与解析规则；新增解读 **I-81**；维护清单条目 32 同步更新 |
| **跨批镜像规则** | 接受跨文档/跨批镜像，但**后续批次的章节清单不得重复列出已在本批处理的章节**；每批起始给"全局章节处理进度表"。 | 本文件 §十三 的"回写进度"行按批更新 |
| **批次划分（最终）** | 批次 1 状态模型核心（✅ 已完成）；**批次 2** POV / 隔离 / 报告 / Style（《架构设计》§21 / §22 + 《需求规格》§21 / §22 / §23 / §24 / §25 / §27）；**批次 3** 文件结构 / 评估（《需求规格》§29 / §31 + 《架构设计》§32 + 《开发 Story 拆分》Story 10 G）；**批次 4** 状态与冲突模型补漏（《需求规格》§6.2 / §9.2 / §16 / §18.1 / §19.1 + 《架构设计》§8 / §17 / §34）。 | 见 §十五 的全局章节处理进度表 |

### 实现解读（回写期）

| # | 解读 | 依据 | 备注 |
|---|---|---|---|
| I-81 | **Gate 2 用户手改的两级区分**：记录级 `EDIT_<NNN>`（`user_edits[].id`，跨版本全局递增，最终写进 Blueprint 的 `source_refs[].ref_id`）与字段级装配输入 `user_edit:<字段路径>`（`derived_from`）。解析规则：按 `field` 在本版本 `user_edits[]` 中匹配；同一字段多次手改取最后一条；查不到即报错；`from: user` 但无手改记录 → 回落 `blueprint_gate2`（`GATE2_<NNN>`）。 | I-29 / I-30 + `src/gate2/assemble.ts` | 两者不是同层对象，不可互相替换。 |
| I-82 | **I-37 经复议不采纳**：`narrative_role_ref` 的文档形态为 structure 位置；arc 覆盖按 I-38 判定。 | 回写期批次 1 审核裁决 | 初版仅记录分歧，随后按 I-83 同批收紧代码。 |
| I-83 | **代码收紧与文档一致（OQ-62 落地）**：`narrative_role_ref` 只接受 `BP_STR_*`（正则 + `STRUCTURE_IDS` 白名单双重约束），`BP_ARC_*` 一律拒绝；arc 覆盖仍由 `runCoverageCheck` 的"直接引用 **或** 映射 structure 已被覆盖"判定（映射链未被移除）。 | 用户裁决"授权同批修代码" | 残留核查：**demo 的 10 个 Scene 与 5 份 `scene_breakdown` fixture 的 `narrative_role_ref` 全部已是 `BP_STR_*`，无需改写**；`referenced_blueprint_items` 中的 `BP_ARC_*` 属合法 Blueprint 项引用（I-43），不受影响。测试：`scene.test.ts` 显式正/反向用例 + Story 5 两处正则断言收紧为 `^BP_STR_`。 |

---

## 十五、全局章节处理进度表（三份文档 × 全部章节）

状态：✅ 已处理（批次 1，含镜像）｜**B2 / B3 / B4** = 待对应批次｜`—` = 核对后无需变更（无清单条目且与实现一致，见备注）。
每批只列**未处理**章节（跨批镜像规则，见 §十四）。

### 《需求规格》

| 章节 | 状态 | 备注 |
|---|---|---|
| §1 文档状态 | B3 | 批次 3 末更新为"v0.1 最终基线" |
| §2 产品定义 | — | |
| §3 四条底层原则 | — | P1–P4 已在 Story 10 F 落地 |
| §4 核心用户流程 | — | |
| §5 Author Gate | — | §5.2 的 pending 冲突处理在 B4 经 §6.2 / §9.2 补 |
| §6 状态模型 | B4 | §6.2（USER_GIVEN / pending 冲突拒绝确认） |
| §7 状态数据必须保留来源 | ✅ | §7.2 已完成（含 I-81 两级 `user_edit`） |
| §8 Story Seed | — | |
| §9 Story Proposal | B4 | §9.2 冲突处理（§9.4 已于批次 1 完成） |
| §10 Seed Preservation Rate | ✅ | §10.2 可执行口径 |
| §11 Story Blueprint | ✅ | §11.1 / §11.3（镜像） |
| §12 Blueprint 版本快照 | — | |
| §13 Key Knowledge | — | |
| §14 Scene Breakdown | ✅ | `tone` 必填；`narrative_role_ref` 保持 `BP_STR_*` |
| §15 allowed_reveals 与结构位置解析 | — | |
| §16 Blueprint Coverage Check | B4 | severity 定义 + arc 覆盖判定措辞（I-38） |
| §17 Story State Schema | ✅ | `type` 扩枚举 + 低危日志不落盘 |
| §18 OCCURRED 生成机制 | B4 | §18.1 payload 命名 + 低危日志字段与取值 |
| §19 Draft Context | B4 | §19.1 `max_chars` 码点口径 |
| §20 Context Compiler | ✅ | 核对一致，**无变更**（数据源白名单 / Writer 可获得 / 默认不能获得与实现一致；§20 归属裁决 = (a) 已隐含在镜像检查中） |
| §21 Context Manifest Schema | ✅ | 6 类 `type` + 六类 `reason` 枚举；Manifest 单文件末次覆盖 + `# Last compiled scene:`；`writer_context` 不落盘 |
| §22 Context Compiler 失败降级 | ✅ | `breakdown --note`（Scene 持久化 / `source: user`）vs `context --note`（仅 Manifest / `user_override`） |
| §23 Style Samples | ✅ | `style/profile.yaml` Schema（`SAMPLE_<NNN>` / tags / `de_entity`→`sanitized_text` 必填）+ 降级顺序与 `matched_on` 记录 |
| §24 Prose Writer | ✅ | 与 §23 / §27 引用一致性核对；Writer 只吃受控上下文（§20 白名单） |
| §25 Anti-AI Linter | ✅ | §25.1 项目级词表 + 仓库级 fallback + 升华词典同构；§25.2 报告位置/共用 Schema/`evidence` 结构/默认阈值；§25.3 五类语义默认 severity + span 合法性 |
| §26 Linter 降级与配置 | ✅ | 随 §25 核对：单条规则开关 + `linter.thresholds` 覆盖层 |
| §27 Local Rewrite | ✅ | Rewrite 契约（纯文本 / ≤3× span / 拼接守恒 / ≥4 码点重叠拒绝 / 原地改写 / `rewrite` 审计）+ 二次检查范围（Rule 段落±1；LLM span±1 段落；ID 重分配） |
| §28 Proposal 失败降级 | — | |
| §29 项目文件结构 | B3 | `blueprint-history/` + 无改动备案 |
| §30 MVP 范围 | — | |
| §31 评估指标 | B3 | §31.1 / §31.2 / §31.3 |
| §32 四条原则必须落入测试 | — | |
| §33 冻结结论 | B3 | 随最终冻结声明更新 |

### 《架构设计》

| 章节 | 状态 | 备注 |
|---|---|---|
| §1 文档状态 | B3 | 同上 |
| §2 架构目标 | — | |
| §3 总体架构 | — | |
| §4 Seed Interpreter | — | |
| §5 Author Gate 1 | — | |
| §6 Story Developer | — | |
| §7 状态机 | ✅ | 核对一致，**无变更**；G1（`PROPOSED → USER_GIVEN`）是否入文档待裁决 |
| §8 冲突模型 | B4 | `state_rebuild_conflicts.type` 扩枚举（模型侧） |
| §9 Proposal Schema | — | |
| §10 Blueprint Builder | — | 字段来源纪律已在需求 §7.2（I-81） |
| §11 Blueprint Schema | ✅ | §11.1 / §11.3 |
| §12 Blueprint Versioning | — | |
| §13 Key Knowledge Schema | — | |
| §14 Scene Schema | ✅ | `tone`（镜像；`BP_ARC_*` 声明已撤销） |
| §15 allowed_reveals 契约 | — | |
| §16 Blueprint Coverage Check | B4 | 镜像 §16 |
| §17 Story State Schema | B4 | 镜像 §17 |
| §18 OCCURRED 路径 | B4 | 镜像 §18 |
| §19 Draft Context | B4 | 镜像 §19 |
| §20 Context Compiler 数据源 | ✅ | 核对一致，**无变更**（与需求 §20 同口径） |
| §21 Context Compiler 输出 | ✅ | `writer_context` 不落盘；输出与 §22 Manifest 的对应关系已写明 |
| §22 Context Manifest Schema | ✅ | 6 类 `type` + 六类 `reason`（镜像）；位置与覆盖约定（镜像） |
| §23 Context Compiler 降级路径 | ✅ | 两条路径（镜像 §22） |
| §24 Style Sample Selector | ✅ | `style/profile.yaml` Schema + `matched_on`（镜像 §23） |
| §25 Prose Writer | ✅ | 与 §20 白名单 / §29 改写范围一致（核对） |
| §26 Rule Linter | ✅ | 词表位置 + `low` 只进 `low_severity_log` + 默认阈值 + 段尾 16 码点（镜像） |
| §27 LLM Linter | ✅ | span 合法性与 `llm_span_invalid`（镜像 §25.2 / §25.3） |
| §28 Linter 配置与降级 | ✅ | 报告位置与共用 Schema + 五类语义默认 severity（镜像） |
| §29 Local Rewrite | ✅ | 契约与落回 + 二次检查范围（镜像 §27） |
| §30 失败降级策略 | — | |
| §31 Seed Preservation Rate | — | 需求 §10 已写，架构侧仅引用 |
| §32 文件结构 | B3 | |
| §33 技术实现原则 | — | |
| §34 四条原则的架构测试要求 | B4 | P2 的 `status` 例外 |
| §35 架构冻结结论 | B3 | 随最终冻结声明更新 |

### 《开发 Story 拆分》

| 章节 | 状态 | 备注 |
|---|---|---|
| §1 文档状态 | B3 | 同上 |
| §2 开发原则 | — | |
| Story 1–4 | — | 回写内容落在前两份文档 |
| Story 5（Scene Schema / Coverage Check / 关键规则） | B4 | `tone`、arc 覆盖判定（I-38）、severity 的镜像检查 |
| Milestone M1 | — | |
| Story 6 | ✅ | Manifest 位置 + 6 类 + 两条降级路径 + `scene_type ∪ tone`（镜像） |
| Story 7（Style Sample 标签 / 匹配降级 / Draft Context） | ✅ | 标签取值 + `matched_on` + profile Schema + `sanitized_text` 必填（镜像） |
| Story 8（词频类 / 配置） | ✅ | 报告位置 / 词表回落 / `evidence` / 段尾窗口 / 阈值（镜像） |
| Story 9（Local Rewrite / 二次检查范围） | ✅ | 默认 severity + span 合法性 + Rewrite 契约 + 范围语义（镜像） |
| **Story 10 G（v0.1 通过标准）** | **B3** | 8 点自检原文入库 |
| Story 10 A–F | — | A–F 无清单条目 |

> 说明：《开发 Story 拆分》以 Story 为章节单位，其内容是对前两份文档的验收化表达；
> 本表把 B2 / B3 / B4 涉及的 Story 段落逐条标出，避免"只改前两份、Story 拆分不同步"。

