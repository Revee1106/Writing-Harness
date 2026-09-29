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
