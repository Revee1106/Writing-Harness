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
