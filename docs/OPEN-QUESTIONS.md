# Short-story-first Writing Harness v0.1 — 未决问题清单

> 本文档记录三份冻结基线文档（《需求规格》《架构设计》《开发 Story 拆分》）之间不一致、
> 或三份文档共同未定义的条目。按项目约定：**文档冲突以《架构设计》为准；无法用该规则消解的，
> 一律记录在此清单，不得自行发明平行结构。**
>
> 状态取值：`已裁决`（用户已明确）/ `待收`（按 Story 起始会收口）/ `已落地`（Story 1 已实现，附实现位置）。

---

## A 类：三份文档之间不一致

| ID | 冲突内容 | 出处 | 裁决 | 状态 |
|---|---|---|---|---|
| **OQ-01** | 《唯一 Blueprint Schema》没有 `seed_fidelity`，但 Story 4 要求"实现结构化 seed_fidelity，使 preserved/altered 能回指 Seed Anchor ID"，且需求规格 §9.4/§10.2 规定它是 Seed Preservation Rate 的唯一计算来源。《架构设计》§11.1 同样缺失，无法用"以架构为准"消解。 | 需求规格 §11.1 ↔ §9.4/§10.2；Story 4；架构 §11.1 | **在 Blueprint 顶层新增 `seed_fidelity`，字段结构与 Proposal 一致（preserved/altered/added/risk）。** 理由：用户 merge 多个 Proposal 后，Rate 的评估对象必须是最终 Blueprint。Story 3 先在 Proposal 侧落地；Story 4 落地到 Blueprint，并在汇报时提醒回写架构 §11.1。 | 已裁决 |
| **OQ-02** | `source` 枚举写为 `{user, user_gate1, harness, blueprint, final_text}`，但文档自身使用了枚举外的值：`source: interpreter`（seed open_questions）、`source=scene_breakdown`（Story 5 Scene 新增内容）。 | 需求规格 §7 / 架构 §7 ↔ 需求规格 §8.1；Story 5 | **扩展为 `{user, user_gate1, interpreter, harness, blueprint, scene_breakdown, final_text}`。** | 已落地（`src/core/status.ts`） |
| **OQ-03** | 通用状态项给的是单数 `source_ref`（标量、未定义结构），而 §7.2/§9.3/§11 要求 `source_refs` 为结构化 `{type, ref_id}` 且"不允许无法解析的自由字符串"；§18.1 的 OCCURRED 又用单数 `source_ref`。 | 需求规格 §7 ↔ §7.2 ↔ §18.1；架构 §7 | **通用状态项保留单数 `source_ref`**（可为 `null`；若存在必须是可解析的 `{type, ref_id}` 结构或稳定 ID 字符串）；**Blueprint 类项使用复数 `source_refs[]`**（`{type, ref_id}` 结构化）。不统一成复数。 | 已落地（`src/core/source-ref.ts` / `src/core/item.ts`） |
| **OQ-04** | Story 2 要求 Gate 1 支持 `fixed → ambiguous` 降级，但四状态枚举没有 `ambiguous`，而 §7 要求"所有关键状态项至少包含 status"。 | Story 2 ↔ 需求规格 §6.1/§7/§33；架构 §7 | **`ambiguous` 是 Interpreter 的中间态，不属于四状态模型**：用 `source: interpreter` 标注，**不设 `status`**。 | 已落地（`src/schema/seed.ts`） |
| **OQ-05** | `gate1_status` 注释只有 `confirmed \| skipped \| partial`，全是 Gate 1 之后的结果值；但 Story 1 必须在 Gate 1 存在之前落盘 `seed.yaml`。 | 需求规格 §8.1；Story 1 | **初值 `pending`**；Gate 1 后写入 `confirmed \| skipped \| partial`。 | 已落地（`src/schema/seed.ts`） |
| **OQ-06** | OCCURRED payload 命名不一致：Story 10 用 `payload.knowledge_ref` / `payload.relationship_ref`，story_state 用 `blueprint_ref`。 | Story 10 B ↔ 需求规格 §17 / 架构 §17 | **OCCURRED payload 统一用 `knowledge_ref` / `relationship_ref`**（描述"发生了什么变化"）；**`story_state.knowledge_state[].blueprint_ref` / `relationship_state[].blueprint_ref` 保持不变**（描述"投影自哪个 Blueprint 项"）。代码保证 `payload.knowledge_ref === knowledge_state[].blueprint_ref`，不要求字段名字面一致。 | 已裁决（Story 10 落地） |
| **OQ-07** | `/config/anti-ai-template-actions.yaml` 与 `/project/**` 文件树并列出现，未说明是仓库级还是项目级。 | 需求规格 §25.1 ↔ §29；架构 §26 ↔ §32 | **项目级** `projects/<project_id>/config/anti-ai-template-actions.yaml`；**允许 fallback 到仓库级默认词表**（不同题材项目可覆盖，Story 10 测试集可独立管理）。 | 已落地（`src/io/paths.ts`，Story 8 填内容） |
| **OQ-08** | 单 POV 的 `known_by`："单 POV 只需要一个 character key"，但两个文档的示例都是单 POV 却给了两个 key。 | 需求规格 §13 ↔ §11.1；架构 §13 ↔ §11.1 | **允许非 POV 角色存在**，`只需要` 读作下限而非上限。 | 已裁决（Story 4/5 落地） |
| **OQ-09** | `seed.yaml` / `proposals.yaml` 示例没有 `schema_version`，而 blueprint/scene/story_state/manifest 都有；`proposals.yaml` 顶层结构未定义。 | 需求规格 §8.1/§9.1 ↔ §11/§14/§17/§21 | `seed.yaml` **加 `schema_version: "0.1"`**；`proposals.yaml` **加 `schema_version` + 顶层 wrapper `proposals: [...]`**（列表，元素为 Proposal Schema）。 | seed 部分已落地（Story 3 落地 proposals） |

---

## B 类：三份文档共同未定义

| ID | 缺口 | 影响 Story | 状态 |
|---|---|---|---|
| **OQ-10** | Gate 2 的 `user_edit` / `blueprint_gate2` 引用**指向哪个文件里的哪条记录**未定义（§7.2 要求 ref 可解析）。 | Story 4 | 待收（Story 4 起始会） |
| **OQ-11** | Scene `director_notes` 条目 Schema 与 ID 约定未定义，但 Manifest 需要 `DIR_USER_001` 被 `overrides.director_surface_ref` 一对一引用。 | Story 5/6 | 待收（**Story 5 起始会必须闭环**） |
| **OQ-12** | `/reports/coverage.yaml`、`/reports/linter.yaml`、`/style/profile.yaml` 的 Schema 完全未定义。 | Story 5/7/8/9 | 待收（Story 5 起始会至少收 coverage） |
| **OQ-13** | `story_state.state_rebuild_conflicts[]` 条目 Schema（ORPHANED 引用字段）未定义。 | Story 5 | 待收（**Story 5 起始会必须闭环**） |
| **OQ-14** | Scene `proposed_additions` 经 Gate 2 确认后如何处理（是否回写 Scene status，还是事实只进 Blueprint）未定义。 | Story 5/6 | 待收（**Story 5 起始会必须闭环**） |
| **OQ-15** | Coverage 的 `length` / `ending` 覆盖判定标准（容差、判定式）未定义。 | Story 5 | 待收（**Story 5 起始会必须闭环**） |
| **OQ-16** | "600 个中文字符"的计数口径（是否只计 CJK、是否计标点/空白）未定义。 | Story 6/7 | 待收（Story 6 起始会） |
| **OQ-17** | Scene Breakdown 重跑与已确认 `confirmed_scenes` 的关系未定义。 | Story 5 | 待收（**Story 5 起始会必须闭环**） |
| **OQ-18** | `truth_status` 的允许值集合未定义（示例只有 `CONFIRMED`）。 | Story 4 | 待收（Story 4 起始会） |
| **OQ-19** | `project-config.yaml` 完全没有 Schema——三份文档只给了文件名与碎片用途（§19.1 draft_context、§26/§28 规则开关）。 | Story 1 | **已裁决**：由 Story 1 提最小 schema（见 D6）。 | 
| **OQ-20** | 项目实体本身（project id / created_at / title / target_length）与"新项目落盘位置"未定义。 | Story 1 | **已裁决**：项目根 `projects/<project_id>/`，内部文件树照抄 §29/§32；`project.*` 字段采纳 Story 1 草案（D6/D7）。 |
| **OQ-21** | 状态机触发器无命名（"Scene 使用""Writer 使用""Draft 出现"是描述，不是可执行标识符）。 | Story 1 | **已裁决**：`GATE2_CONFIRM / GATE3_CONFIRM / SCENE_BREAKDOWN_REFERENCE / WRITER_REFERENCE / DRAFT_CONTAINS / STATE_EXTRACTOR`（D8）。 |

---

## C 类：Story 1 实现中发现的补充条目（已在 Story 1 落地，供复核）

| ID | 内容 | 性质 | 状态 |
|---|---|---|---|
| **OQ-22** | **G1：`PROPOSED → USER_GIVEN` 无条件禁止。** 三份文档的 6 条禁止流转未明文列出该项，它是原则 2（可以提案，不能伪装）的直接推论。 | **从 P2 推导，非文档明文，已在 Story 1 落地。** | 已落地（`src/core/state-machine.ts` F 表之外的第 7 条守卫） |
| **OQ-23** | **U1：文档未定义的迁移默认拒绝。** §7「合法流转」是一个封闭集（USER_GIVEN 保持自身 / PROPOSED→CONFIRMED@Gate2 / CONFIRMED→OCCURRED@Gate3）。对此外的迁移（如 `USER_GIVEN → PROPOSED`、`CONFIRMED → PROPOSED`、`OCCURRED → PROPOSED`、`CONFIRMED → OCCURRED` 缺少 Gate 3 证据），Story 1 一律拒绝，代码 `U1`。依据：架构 §33.5 Author Control + 需求规格 §33「四状态冻结」。 | 严格解读，非文档明文，已在 Story 1 落地；如需放宽请裁决。 | 已落地 | **【Story 2 起始复核：用户裁决 —— 保持严格，并在此加注释：U1 为一律拒绝、不设例外；若后续 Story 遇到必须放行的迁移，须回到本清单新增条目，不得在代码内私开放行分支。】**
| **OQ-24** | **USER_GIVEN 的 `source ⇔ origin` 严格配对。** §7.1 只写明 `source=user → origin=raw_seed` 与 `source=user_gate1 → origin=gate1_confirmation` 两例，未明文规定"USER_GIVEN 必须携带 origin"。Story 1 按严格解读实现：USER_GIVEN 必须提供 origin 且必须与 source 配对；非 USER_GIVEN 携带 origin 一律拒绝。 | 严格解读，非文档明文，已在 Story 1 落地；如需放宽请裁决。 | 已落地（`src/core/item.ts`） |

---

## D 类：记录格式约定

- 新增条目一律追加编号（OQ-25 起），不得复用旧编号。
- 每条必须写清：冲突/缺口内容 → 出处（含章节号）→ 影响 Story → 处理方式。
- Story 完成汇报中的「未决问题」一栏，只允许引用本清单编号，不得在汇报里临时发明新约定。

---

## E 类：Story 2 新增条目

| ID | 内容 | 影响 | 处理方式 | 状态 |
|---|---|---|---|---|
| **OQ-25** | **Gate 1 的交互载体与 Interpreter 输出持久化未定义。** 三份文档规定了 `seed.yaml` 与 `/reports/*`，但没有定义"Interpreter 原始输出 + Gate 1 预览/编辑"落在哪里；§7.2 的 `source_ref.type=user_edit` 只指向 Gate 2 编辑记录，Gate 1 没有对应的 ref 类型。 | Story 2 | **已落地（最小方案）**：不新增持久化文件；Interpreter 输出只在 Gate 1 会话内存在，`--plan` 为只读预览；Gate 1 结果只写 `seed.yaml`。若要支持"审阅-编辑-再提交"的跨会话流程，需要先裁决新增文件（会涉及 §29/§32 文件结构）。 | 已落地（待裁决是否需跨会话） |
| **OQ-26** | **Interpreter 的"原文证据"是否持久化未定义。** Story 2 要求"fixed 必须能追溯用户原文"，但 `seed.yaml` 的固定字段里没有"原文片段"位置：`source_ref` 只接受 `{type,ref_id}` 或稳定 ID 字符串，`origin=raw_seed` 只表达"来自原始输入"。 | Story 2 | **已落地（不发明字段）**：`evidence` 只在 Interpreter 输出/Gate 1 预览中存在（transient）；持久化的可追溯性由 `source=user` + `origin=raw_seed` 表达。若需要按句级证据长期留存，须裁决新增字段。 | 已落地（待裁决是否需句级证据） |
| **OQ-27** | **Gate 1 是否允许重跑未定义。** §5.1 把 Gate 1 描述为流程中的一次操作，但未说明 `gate1_status` 非 `pending` 后能否再次执行。 | Story 2 | **已落地（严格解读）**：`gate1_status` 非 `pending` 时再次执行 Gate 1 一律拒绝（`Gate1AlreadyClosedError`），以保证 §8.2 的 anchor 集合与来源不被二次改写。 | 已落地 |
| **OQ-28** | **`gate1_status=confirmed` 的判定条件未定义。** §8.1 只给出 `confirmed | skipped | partial` 三个值，未说明各自触发条件。 | Story 2 | **已落地（解读 I-15）**：全部接受（无任何修改）→ `confirmed`；跳过 → `skipped`；存在删除/提升/降级/编辑任一操作 → `partial`。 | 已落地 |
| **OQ-29** | **Gate 1 升降级是否保留原 ID 未定义。** §5.1 要求支持 `ambiguous → fixed_by_user`，§8.1 的示例只展示了 `fixed_by_user` 使用 `SEED_F###`；两者不能同时无条件成立。 | Story 2 | **已落地（解读 I-16）**：条目在集合之间移动时**保留原 ID**，两个集合的 ID 约束放宽为 `SEED_[FAQ]###`（`raw_seed_anchor_ids` 仍只接受 `SEED_F###`）。备选方案：移动时分配新 ID 并用 `source_ref` 回指源 ID（不动 Story 1 的 schema，但 ID 会随 Gate 1 操作变化）。**需复核**。 | 已落地（待复核） |
| **OQ-30** | **`delete` 与 raw_seed_anchor_ids 的关系未定义。** §5.1 允许"删除错误分类"，§8.2 只规定"fixed → ambiguous 不删除历史 anchor"，没有规定"整条删除原始锚点"时锚点怎么办；而 OQ-29 第 5 条（anchors ⊆ 现存条目）要求二者一致。 | Story 3 | **已落地（解读 I-18）**：用户显式 `delete` 原始锚点时，该 ID 同步移出 `raw_seed_anchor_ids`（唯一允许的 anchor 变化）；`demote` 仍保留历史锚点（§8.2）。服务层断言"anchors 只能按被删除项收缩，永不新增"。 **【Story 4 起始复核：用户裁决 —— 保持当前实现，并明确语义：`delete` 原始锚点 = 该锚点永久退出 Seed Preservation Rate 分母，且不可通过 Gate 2 恢复；`demote` 只改集合归属、不改分母；`edit` 既不改分母也不改集合归属。三者互不替代。】** | 已落地（语义已明确） |
| **OQ-31** | **`source_refs.type=proposal` 的字段路径白名单未定义。** §9.3 只规定形态 `<proposal_id>.<field_path>`，未枚举合法路径。 | Story 3 | **已落地（用户裁决第 3 项）**：白名单冻结在 `src/core/proposal-field-paths.ts`，覆盖 core_premise / core_conflict / truth_or_turn / character_arc / ending / seed_fidelity.added[N].value / seed_fidelity.risk[N].value 等；下标 `[N]` 在比较时归一化。白名单只增不改。 | 已落地 |
| **OQ-32** | **Proposal 差异度的可执行判定未定义。** §9/§31.1 只要求"差异明显""差异度"可评估。 | Story 3 | **已落地（用户裁决第 2 项）**：5 个结构维度（core_conflict / truth_or_turn / ending / character_arc / core_premise），判定 = 核心三维中 ≥2 不同 **且** 总维度 ≥3 不同；标题/tone 等表达性字段不参与。失败只产生 warning（§28 允许用户重做，不阻塞）。 | 已落地 |
| **OQ-33** | **Seed Preservation Rate 的边界口径未定义。** §10.2 只给公式，未说明未出现锚点、越界引用、分母为 0 的处理。 | Story 3 | **已落地（用户裁决第 1 项）**：preserved 计分子，altered / conflicts 不计；三处都未出现的锚点 → `UNACCOUNTED_ANCHOR` warning 且不计分子；引用 Gate 1 提升项 → `SEED_REF_NOT_ANCHOR`（不参与分子分母，§10.2）；分母为 0 → `rate = null` + `EMPTY_DENOMINATOR`；同一锚点重复只计一次。 | 已落地 |
| **OQ-34** | **fixture 哈希复核对"依赖前置状态的契约"如何工作未定义。** `story_developer` 的输入依赖 Gate 1 之后的 seed 状态，无法只从 Seed 文本推导。 | Story 3 | **已落地**：recorded fixture 增加工具链元数据 `gate1_ops`（仅用于重建输入，不参与运行时契约），`pnpm fixtures:check` 按契约注册的输入构造函数复核哈希，杜绝 fixture 与状态静默漂移。 | 已落地 |
| **OQ-35** | **`blueprint-history/` 与 §29/§32 的 `history/` 关系未定。** OQ-10 要求新增 `projects/<id>/blueprint-history/<NNN>.meta.yaml` 并与 `blueprint-<NNN>.yaml` 一一对应；但 §29/§32 已冻结快照位置为 `history/blueprint-NNN.yaml`。 | Story 4 | **已落地（解读 I-31）**：快照保持在 §29 冻结的 `history/blueprint-<NNN>.yaml`，新增的元数据文件放在 `blueprint-history/<NNN>.meta.yaml`，两者按同一 `<NNN>` 一一对应。这样文档结构与 OQ-10 同时成立。**【Story 5 起始会裁决：接受当前布局，并明确 `blueprint-history/` 是 v0.1 对需求规格 §29 / 架构设计 §32 的扩展（Gate 2 元数据目录）；回写清单中加入"回写《架构设计》§32 与《需求规格》§29"。】** | 已裁决 |
| **OQ-36** | **`scene_type` / `applicable_scene_types` 的取值集合未定义。** §11.1 示例用 `[conflict, dialogue]`，§14 的 Scene Schema 未枚举。 | Story 4/5 | **Story 4 处理**：Blueprint 只要求 `applicable_scene_types` 为非空字符串数组，不发明枚举。**Story 5 起始会必须先冻结枚举**，否则 observable hint 的"按 Scene type 匹配加载"无法执行。 | 待收（Story 5 起始会） |
| **OQ-37** | **Gate 2 的"合并"粒度与字段级合并规则未定义。** §5.2 只说"可以合并多个 Proposal"。 | Story 4 | **已落地（用户裁决）**：逐字段指定来源（`--field <字段>=<来源>`）+ 可手改（`--edit <字段>=<内容>`）；两 Proposal 都有该字段而用户未指定 → **报错**，不自动取 A；合并产物每个字段都带 `source_refs`；**不修改 proposals.yaml**（冲突裁决只写 meta）。 | 已落地 |
| **OQ-38** | **`EDIT_*` / `GATE2_*` 的编号空间未定义。** OQ-10 给出 `EDIT_<NNN>` / `GATE2_<NNN>` 形态，但未说明编号是否跨版本唯一。 | Story 4 | **已落地（解读 I-29）**：`GATE2_<NNN>` 与 `blueprint_version` 一一对应；`EDIT_<NNN>` 为**跨版本全局递增**（扫描既有 meta 文件取最大值 + 1），以保证 `source_refs.type=user_edit` 的 ref_id 在项目内始终可解析。 | 已落地 |
| **OQ-39** | **§11.3 的单 POV 默认规则与内心隔离存在冲突。** 若按字面把**每个**角色都默认填入 `[meta.pov[0]]`，则单 POV 故事里所有角色的 desire/fear/contradiction 都对 POV 可见，直接违反架构设计 §21 / Story 5 的"非当前 POV 角色的内心不得进入 Writer 输入"。 | Story 4/6 | **已裁决（Story 5 起始会：接受收窄解读）**：单 POV 时 POV 角色自身为 `[self]`、非 POV 角色为 `[]`；双 POV 必须显式。**需复核**：若你希望字面执行 §11.3，请明确它与架构设计 §21 的优先关系。 | 已裁决 |
| **OQ-40** | **Gate 2 的 POV 字段来源与内容可以不一致。** `meta.pov` 没有 `derived_from`（模型直接输出），因此字段计划指定 `pov ← PROP_A` 时，模型仍可能输出双 POV；当前实现只按计划记录溯源，不校验内容是否与来源提案一致。 | Story 4 | **【Story 5 起始会裁决：不做内容一致性校验**（避免把"模型润色"误判为违规）；改为在 Gate 2 结果中增加 **warning 级检查**：`meta.pov` 是否与 `field_sources` 里 `pov` 的来源提案的 `pov` 一致，不一致只提示不阻塞。**】** | 已落地 |
| **OQ-41** | **OBH 的 `applicable_scene_types` 允许的 tone 标签集合未定义。** §11.1 示例用 `[conflict, dialogue]`，其中 `dialogue` 是 scene_type、`conflict` 是 tone；文档未枚举 tone。 | Story 5 | **已裁决（Story 5 起始会）**：`scene_type` 严格为 `dialogue / action / interior / transition`；`applicable_scene_types` 接受 **scene_type ∪ tone 的联合白名单**，tone 侧由 dsh 提议最小标签集（`conflict / tension / tenderness / restraint / absurdity / suspense / warmth / grief`）。不改 §23.1、不改字段名。 | 已落地 |
| **OQ-42** | **`narrative_role_ref` 是否允许引用 arc 位置未定义。** §14 示例是 `BP_STR_TURN`；§16 的 Coverage 同时检查 structure 与 arc。 | Story 5 | **已落地（dsh 提议）**：`narrative_role_ref` 允许 `BP_STR_*` 与 `BP_ARC_*`；arc 覆盖判定 = 该 arc 位置有 Scene 直接引用，或其映射的 structure 位置已被覆盖（映射：START→BEG、SHIFT→TURN、END→END）。 | 已落地（待复核） |
| **OQ-43** | **`/reports/coverage.yaml` 的 Schema 未定义（原 OQ-12 的一部分）。** | Story 5 | **已落地（dsh 提议）**：`{schema_version, blueprint_version, generated_at, summary, warnings: [{id: COV_NNN, type, severity, message, refs}]}`；type ∈ structure_coverage / arc_coverage / ending_coverage / length_coverage / reveal_alignment / blueprint_reference_integrity。 | 已落地 |
| **OQ-44** | **Coverage 各类型的 severity 未定义。** §16 只说"解析失败、order 越界、重复覆盖均为 high warning"。 | Story 5 | **已落地**：structure / ending / reveal_alignment / blueprint_reference_integrity = high；length / arc = medium。所有 warning 都**不阻塞**（§28 精神：用户可继续创作）。 | 已落地 |
| **OQ-45** | **Scene 的 `proposed_additions[]` 条目结构未定义。** §14 只写 `proposed_additions: []`。 | Story 5 | **已落地（解读 I-36）**：`{id: ADD_###, value, status: PROPOSED, source: scene_breakdown}`，ID 在每个 Scene 内独立编号（与 §9.1 的 `ADD_###` 形态一致，不新增前缀）。 | 已落地 |
| **OQ-46** | **Gate 2 的 POV 一致性 warning 需要载体。** OQ-40 裁决要求增加 warning 检查，但 meta 的 Schema 未包含 warning 字段。 | Story 5 | **已落地**：Gate 2 结果对象与 CLI 打印 warning；`warnings` 以只读数组返回，不写入 meta（避免改动已冻结的 OQ-10 结构）。 | 已落地 |
| **OQ-47** | **Scene 没有 tone 字段，但 §11.3（OBH）与 §23.1（Style Sample）都要按 `scene_type ∪ tone` 匹配。** | Story 6 | **【Story 7 起始会裁决：给 Scene 新增必填字段 `tone: [tone_value, ...]`（≥1，取自 OQ-41 八值枚举），由 `scene_breakdown@0.1` 的 LLM 输出，不从 Scene 文本推断；OBH 匹配 = Scene 的 `scene_type ∪ tone` 与 hint 的 `applicable_scene_types` 求交集，非空即加载。回写清单加入 §11.3 / §14（《架构设计》+《需求规格》）。】** | 已裁决（已落地） |
| **OQ-48** | **`writer_context` 的持久化位置未定义。** §29/§32 只列出 `reports/context-manifest.yaml`，没有 writer_context 文件。 | Story 6 | **Story 7 起始会裁决：保持现状。** writer_context 由 Compiler 返回（CLI 打印 / `--json`），不落盘；只有 Manifest 写入 `reports/context-manifest.yaml`。 | 已裁决 |
| **OQ-49** | **一个项目多个 Scene 的 Manifest 如何存放未定义。** §21 的 Schema 是单 Scene 一份，而 §29 只给了一个文件路径。 | Story 6 | **Story 7 起始会裁决：保持现状**（单文件、末次覆盖）；并要求在 `context-manifest.yaml` 顶部加一行 `# Last compiled scene: scene-XXX` 注释便于人工审计（已落地）。 | 已裁决（已落地） |
| **OQ-50** | **`excluded_sensitive.type` 没有"角色内心"这一类。** 六类 reason 里有 `non_pov_inner_state`，但 type 枚举只有 key_knowledge / foreshadowing / future_content / unconfirmed_content / user_override。 | Story 6 | **【Story 7 起始会裁决：`excluded_sensitive.type` 扩为 6 类，新增 `character_inner_state`；`included_sensitive.type` 不加新类；reason 词表不变。回写清单加入 §22。】** 已落地。 | 已裁决（已落地） |
| **OQ-52** | **升华词典的文件 Schema 未定义。** 用户只要求"独立文件 + 独立 version"。 | Story 8 | **已落地（dsh 提议）**：`{schema_version, version, phrases: [{id: EL_NNN, pattern, severity, note?}]}` —— 与模板动作词表同构（OQ-07 的 fallback 规则同样适用）。 | 已落地（待复核） |
| **OQ-53** | **`evidence` 的"按规则固定结构"未给出具体字段。** | Story 8 | **已落地（dsh 提议）**：`template_actions` → `{action_id, pattern, occurrences, severity_basis: hit|repeated, spans}`；`sentence_length_variance` / `paragraph_length_variance` → `{cv, mean, stddev, sentence_count|paragraph_count, lengths}`；`dialogue_ratio` → `{ratio, dialogue_code_points, total_code_points, dialogue_span_count}`；`paragraph_ending_elevation` → `{consecutive, paragraph_indexes, matched_patterns}`。 | 已落地（待复核） |
| **OQ-54** | **"段尾"的窗口口径未定义。** | Story 8 | **已落地（解读 I-60）**：段落最后 **16 个非空白码点**内命中升华词典即视为"以升华句收尾"。 | 已落地（待复核） |
| **OQ-55** | **`reports/linter.yaml` 如何承载多场结果未定义。** Schema 带单 `scene_id`，而 §29 只给一个文件路径。 | Story 8 | **已落地（解读 I-61）**：与 Manifest 同约定——单文件、末次覆盖，顶部写 `# Last linted scene:` 注释；`--all` 逐场检查并打印摘要。 | 已落地（待复核） |
| **OQ-56** | **五类语义类型的 severity 未定义。** §25.3 只给了展示策略。 | Story 9 | **已落地（dsh 提议）**：`author_summary` / `subtext_exposed` = high；`emotion_repeated` / `voice_blur` / `over_explanation` = medium。 | 已落地（待复核） |
| **OQ-57** | **`reports/linter.yaml` 在 Rewrite 会话后可能同时含 llm 与 rule 的 warning。** | Story 9 | **已落地（解读 I-67）**：报告级 `linter` = 最后一次完整运行；warning 级 `linter` = 该条来源；被改写目标的 `rewrite` 记录保留在报告里。若你希望"rule / llm 各自一份文件"，需要裁决新增文件（与 OQ-49/OQ-55 一并）。 | 已落地（待复核） |
| **OQ-58** | **"不得引入 Scene 中没有的实体"的判定口径未定义。** | Story 9 | **已落地（解读）**：保守口径 = 替换文本不得出现"Blueprint 角色名但当前 Scene 正文中不存在"的名字；`de_entity=true` 样本的实体原值沿用 Story 7 的 diff 判定。 | 已落地（待复核） |
| **OQ-59** | **低危日志（low severity log）的持久化位置未定义。** 裁决 2 要求"真子集 → 正常 + `low_severity_log`"，但 `story_state` 的 Schema 没有该字段，而 Story 10 的硬边界是"不新增 Schema"。 | Story 10 | **已裁决（封版）**：**不新增 `reports/state-extraction.yaml`**。低危日志保持 CLI 输出可见（`harness gate3 --confirm` 打印 `low_severity_log`，`--json` 同样可见），需要留档用 **stdout 重定向**；`story_state` 不加字段（Story 10 不新增 Schema）。 | 已裁决（已落地） |
| **OQ-60** | **Story Development Test Set 里只有 2 个 Seed 有离线 fixture 覆盖。** 需求规格 §31.1 要求 ≥10 Seed，但离线 fixture 必须先有真实模型产出才能录制。 | Story 10 | **已裁决（封版）**：**补齐 5 个 fixture（情感 / 悬疑 / 温情 / 现实 / 轻科幻）→ measured 达到 7 个**（2 项目型 + 5 fixture 型，离线回放 `seed_interpreter` → Gate 1 → `story_developer`，指标现算不硬编码）；**接受 3 个 `corpus_only`（开放结局 / 单场景 / 强反转）**，命令会显式列出它们而不假装全部跑过。 | 已裁决（已落地） |
| **OQ-61** | **v0.1 的"8 点自检"条款原文没有随三份冻结文档进入仓库。** 三份文档以附件形式提供，仓库里只有实现产物，没有《开发 Story 拆分》Story 10 结尾的自检清单原文。 | Story 10 | **已裁决（封版）**：原文在《开发 Story 拆分》**Story 10 G 节**——① 一句话 Seed 可以形成可用 Blueprint ② Gate 顺序低摩擦 ③ Blueprint 可稳定拆 Scene ④ Proposal 不会渗透 Writer ⑤ POV / secret / future 不明显泄漏 ⑥ Seed Preservation Rate 可测 ⑦ Harness 正文在 AI 感维度出现明确改善趋势 ⑧ 用户不承担高频审批。重建版第 1/7/8 条偏离（第 1 条不应泛化成"链路"、第 7 条不得把"改善趋势"降级为"可运行"、第 8 条是产品指标而非技术指标）已全部替换；逐条证据见 `docs/DECISIONS.md` §十二 与 `tests/acceptance/story10.acceptance.test.ts` 验收 F。 | 已裁决（已落地） |
