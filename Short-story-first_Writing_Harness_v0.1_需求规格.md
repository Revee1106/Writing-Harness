# Short-story-first Writing Harness v0.1 — 需求规格

## 1. 文档状态

- 版本：v0.1
- 状态：冻结开发基线（评审修订版）
- 产品定位：短篇优先 Writing Harness
- 目标篇幅：1,000～30,000 字
- 默认叙事范围：现代或通用背景、线性时间、单 POV / 双 POV
- 核心目标：将一句话或一段模糊故事种子，发展为可用故事蓝图，并进一步生成低 AI 感正文
- 本文与《架构设计》《开发 Story 拆分》共同构成 v0.1 唯一开发基线

**v0.1 最终基线（回写完成 2026-09-30）**

- 封版点（commit）：`d0d65da`
- 回写批次：批次 1（状态模型核心）→ 批次 2（POV / 隔离 / 报告 / Style）→ 批次 3（文件结构 / 评估）→ 批次 4（状态与冲突模型补漏）**四批全部执行完毕**
- 回写依据：仓库内 `docs/DECISIONS.md` §十三「封版后文档维护清单」（32 条）+ §十四 回写期裁决
- 回写性质：**只做定义补全、枚举扩展、位置明确、备案**，不改变架构方向；条款级改动逐条带「回写项 N」标记
- 文档自洽性：三份文档在同一批次内同步修改，不保留中间状态
- 封版记录（完整 sha256 / 遗留 OQ 分类与复核时机 / 未来版本清单）：`docs/DECISIONS.md` **§十六**


---

## 2. 产品定义

Short-story-first Writing Harness v0.1 是一个面向短篇创作的轻量型写作系统。

用户不需要先准备完整设定，只需要提供自由文本形式的故事大概。输入可以是一句话、多句话或一小段带简单 Markdown 格式的描述。

示例：

> 一对情侣其实都深爱对方，因为一件小事争吵，女方提出分手。女方想的是只要男方认错她就愿意留下，男方想的是为什么每次都要小题大做。

系统负责：

1. 分辨用户已经明确确定的内容、模糊内容和未决定内容；
2. 让用户以低成本确认或修正 Seed 理解；
3. 基于确认后的理解提出 2～3 个差异明显的故事方案；
4. 由用户选择、合并或修改方案；
5. 形成正式 Story Blueprint；
6. 自动拆分 Scene Breakdown；
7. 根据当前场景和 POV 编译 Writer 所需上下文；
8. 生成正文；
9. 使用规则型和 LLM 型 Linter 检测 AI 感与叙事问题；
10. 只对局部文本进行 Rewrite；
11. 由用户确认终稿；
12. 终稿确认后，自动提取必要的 OCCURRED 状态。

v0.1 唯一需要证明的核心命题：

> 一句话种子，能否稳定变成可用蓝图，再变成低 AI 感短篇正文，同时不丢失用户真正想写的核心。

---

## 3. 四条底层原则

### 原则 1：LLM 无权修改现实

> LLM 可以创造候选内容，但没有修改现实的权限。

任何模型生成的内容默认只是候选内容，除非用户明确确认，不能升级为正式故事事实。

### 原则 2：可以提案，不能伪装

> Harness 可以提出故事选择，但不能把自己的选择伪装成作者已经确定的事实。

所有由 Harness 补出的情节、设定、人物动机、结局、主题等，默认状态必须是 `PROPOSED`。

### 原则 3：Context Compiler 必须可审计

> Context Compiler 可以决定模型看到什么，但必须留下可审计记录。

Writer 只能获得当前场景需要的信息。任何秘密、伏笔真相、未来剧情是否暴露，都必须可追溯。

### 原则 4：推演不会产生事实

> 推演不会产生事实，只有用户确认或用户确认过的正文实际发生，才能产生事实。

该原则必须进入状态机实现，不能只停留在提示词层面。

---

## 4. 核心用户流程

```text
Story Seed
    ↓
Seed Interpreter
    ↓
Author Gate 1：确认 / 修正 Seed 理解（可跳过）
    ↓
Story Developer
    ↓
2～3 Story Proposals
    ↓
Author Gate 2：选择 / 合并 / 修改并确认 Blueprint
    ↓
Confirmed Blueprint
    ↓
Scene Breakdown
    ↓
Blueprint Coverage Check
    ↓
Context Compiler
    ↓
Writer Context + Context Manifest
    ↓
Prose Writer
    ↓
Rule Linter
    ↓
LLM Linter
    ↓
Local Rewrite
    ↓
Final Draft
    ↓
Author Gate 3：终稿确认
    ↓
State Extractor
    ↓
OCCURRED 更新 / 冲突提示
```

说明：

- `Open Question` 不等于 `Ask User`。
- Seed Interpreter 不弹问卷。
- Gate 1 在 Story Developer 之前。
- Scene Breakdown 不设逐场 Gate。
- Linter 默认只报告问题，不自动整篇重写。
- Proposal 文件不会进入 Context Compiler。
- 未确认内容不能通过 Scene、Writer 或 Draft 使用行为自动升级。

---

## 5. Author Gate

v0.1 仅保留三次显式 Author Gate。

### 5.1 Gate 1：Seed 理解确认

Seed Interpreter 输出：

```text
fixed_by_user
ambiguous
open_questions
```

Gate 1 是低摩擦、非阻塞操作。用户可以：

- 接受全部；
- 删除错误分类；
- 将某个 `ambiguous` 手动提升为 `fixed_by_user`；
- 将某个 `fixed_by_user` 降级为 `ambiguous`；
- 编辑条目；
- 直接跳过，进入 Story Developer。

规则：

- 用户手动提升为 `fixed_by_user` 的内容，状态为 `USER_GIVEN`，来源记录为 `user_gate1`。
- Gate 1 被跳过时，系统使用 Interpreter 当前结果继续生成 Proposal，但必须记录 `gate1_status: skipped`。
- Gate 1 不得变成问卷，不要求用户回答所有 Open Questions。

### 5.2 Gate 2：Blueprint 选择与确认

系统输出 2～3 个差异明显的 Proposal。

用户可以：

- 选 A / B / C；
- 合并多个 Proposal；
- 修改其中一个；
- 要求重做 Proposal；
- 直接手写或补写 Blueprint 内容。

只有用户确认后的方案才进入 `Confirmed Blueprint`。

Gate 2 是 `PROPOSED → CONFIRMED` 的唯一正常升级入口。

### 5.3 Gate 3：终稿确认

用户审阅最终正文，可要求：

- 局部修改；
- 删除；
- 扩写；
- 改对白；
- 改节奏；
- 改结尾。

只有用户确认后的终稿，才允许 State Extractor 产生 `OCCURRED`。

---

## 6. 状态模型

### 6.1 四种状态

```text
USER_GIVEN
PROPOSED
CONFIRMED
OCCURRED
```

### 6.2 USER_GIVEN

用户明确提供的内容。

特点：

- 最高优先级；
- 不允许 Harness 自动覆盖；
- 若 Proposal 与 `USER_GIVEN` 冲突，必须产生 conflict；
- conflict 不自动覆盖、不自动合并，在 Gate 2 由用户处理；
- **参与本次 Gate 2 的提案若存在 `resolution = pending` 的冲突，则拒绝确认**（v0.1 补充定义，回写项 31）：
  逐条给出待处理的冲突与处理命令，用户先裁决（`kept_user` / `changed_user` / `dropped`）再确认；
- **裁决结果只写 Gate 2 元数据（`blueprint-history/<NNN>.meta.yaml` 的 `conflict_resolutions`），不回写 `proposals.yaml`**——
  Proposal 是"当时提出的方案"的历史记录，不得被事后修改。

### 6.3 PROPOSED

由 Harness 补充的候选内容。

关键规则：

- 被 Story Developer 使用，仍然是 `PROPOSED`；
- 被 Scene Breakdown 引用，仍然是 `PROPOSED`；
- 被 Prose Writer 引用，仍然是 `PROPOSED`；
- 出现在 Draft 中，仍然不会自动升级；
- 被多次使用也不会自动升级；
- 只有 Gate 2 的用户确认可正常升级为 `CONFIRMED`；
- **`PROPOSED → USER_GIVEN` 无条件禁止（G1，v0.1 新增，回写项 31）**：用户确认只能产生 `CONFIRMED`，
  不存在"用户后来认可所以改标 `USER_GIVEN`"。一旦把机器推测标成 `USER_GIVEN`，就等于把 Harness 的补充伪装成用户原意（违反原则 2）；
  若要改变"这是用户自己说的"这一事实，只能由用户**重新编辑 Seed**（新增 item 或走 Gate 1 操作）。

### 6.4 CONFIRMED

用户在 Blueprint 阶段明确接受的设定。

用于：

- Scene Breakdown；
- Blueprint Coverage Check；
- Context Compiler；
- Writer 的故事约束。

`Story State` 不存 CONFIRMED 内容，只保存由 Blueprint 派生的运行时投影。

### 6.5 OCCURRED

表示已经出现在用户确认过的最终正文中的关键事件或事实。

规则：

- 只能在 Gate 3 之后产生；
- 由 State Extractor 自动提取；
- v0.1 默认只提取：
  - `key_knowledge` 的揭示 / 获知变化；
  - 人物关系状态变化；
- OCCURRED 自动写入 `story_state.occurred`，并同步更新对应的 `knowledge_state / relationship_state`，不逐条打断用户；
- Gate 3 同时把已确认 Scene 写入 `story_state.confirmed_scenes`；
- 若 OCCURRED 与 CONFIRMED 冲突，才提示用户；
- OCCURRED 不得自动反向覆盖 CONFIRMED。

---

## 7. 状态数据必须保留来源

所有关键状态项至少包含：

```yaml
id: ITEM_001
value: ...
status: USER_GIVEN | PROPOSED | CONFIRMED | OCCURRED
source: user | user_gate1 | harness | blueprint | final_text
source_ref: optional-reference

# 仅 USER_GIVEN 有意义
origin: raw_seed | gate1_confirmation | null
```

### 7.1 origin 语义

`origin` 只对 `USER_GIVEN` 有意义：

```text
raw_seed
用户原始输入直接形成的 Seed Anchor

gate1_confirmation
Interpreter 推测经用户在 Gate 1 明确确认后提升
```

其他状态 `origin = null / omitted`。

### 7.2 source_refs 统一结构

Blueprint 中所有 `source_refs` 元素统一为：

```yaml
source_refs:
  - type: seed | proposal | user_edit | blueprint_gate2
    ref_id: SEED_F001
```

约束：

- `type=seed` → `ref_id` 指向 Seed item ID；
- `type=proposal` → 指向 Proposal 或 Proposal 内可追溯项 ID，统一采用**字段路径** `<proposal_id>.<field_path>`（如 `PROP_A.core_premise`）；
- `type=user_edit` → 指向 **Gate 2 用户手改记录**。这里有两级，不要混用：
  - **记录级（最终写进 Blueprint 的形态）**：`ref_id = EDIT_<NNN>`，即 `blueprint-history/<NNN>.meta.yaml` 中 `user_edits[].id`（跨版本全局递增）；
  - **字段级（装配输入形态）**：`derived_from = user_edit:<字段路径>`，装配时**按 `field` 匹配**该版本的 `user_edits[]`，解析为对应的 `EDIT_<NNN>`；
  - 若某字段声明了 `user_edit:<字段>` 但用户并未手改该字段 → **报错**；字段来源为 `user` 但查不到对应手改记录 → 回落为 `blueprint_gate2`（`GATE2_<NNN>`）；
  - **`type=user_edit` 的 `ref_id` 是记录级 `EDIT_<NNN>`**；装配阶段的字段级声明 `user_edit:<字段路径>` **不进入 `source_refs`**，只作为装配输入（装配后只留记录级 ID）；
- `type=blueprint_gate2` → 指向本次 Blueprint 确认动作 ID：`GATE2_<NNN>`；字段来源标记为"Harness 依裁决派生"时也映射到该类型（`harness` → 同一形态）；
- 不允许使用无法解析的自由字符串作为 source ref。

**Gate 2 的字段来源纪律（v0.1 补充定义，回写项 32）**：

- 每个字段的 `source_refs` 必须是**字段计划里为它指定的那个 Proposal 字段**（或对应的 `user_edit` / `blueprint_gate2`）；
- 若装配结果声明的来源与字段计划不一致 → **报错，不静默换源**；
- 字段在两个 Proposal 中都存在且用户未指定来源 → **报错**（不自动取 A，也不自动合并）。

不得只保存最终值而丢失来源。

## 8. Story Seed

### 8.1 输入与持久化

v0.1 接受自由文本：一句话、多句话、一小段描述或简单 Markdown。

`raw_seed_anchor_ids` 与 `gate1_status` 都持久化在 `seed.yaml`：

```yaml
story_seed:
  raw_input: "一个男人每天给去世的妻子发微信，某天突然收到回复。"
  raw_seed_anchor_ids: [SEED_F001]
  gate1_status: partial   # confirmed | skipped | partial

  fixed_by_user:
    - id: SEED_F001
      value: 妻子已经死亡
      status: USER_GIVEN
      source: user
      origin: raw_seed

  ambiguous: []
  open_questions:
    - id: SEED_Q001
      value: 真相何时揭晓
      source: interpreter
```

### 8.2 冻结规则

Seed Interpreter 首次产出后立即冻结：

```text
raw_seed_anchor_ids = 当时所有 origin=raw_seed 的 fixed_by_user.id
```

Gate 1 后不重算：

- fixed → ambiguous：不删除历史 anchor；
- ambiguous → fixed：不加入 raw_seed_anchor_ids；
- gate1_status 写入 `confirmed | partial | skipped`。

### 8.3 Open Question 生命周期

- `SEED_Q*` ID 在 seed.yaml 中稳定；
- Gate 1 删除某 Open Question → 后续 Story State 投影删除该项；
- Gate 1 编辑但保留 → ID 不变；
- v0.1 不允许 Scene 自动新增 Open Question。

## 9. Story Proposal

每个 Story Seed 生成 2～3 个差异明显的 Proposal。

### 9.1 Proposal Schema

```yaml
proposal_id: PROP_A
title:
genre:
core_premise:
core_conflict:
truth_or_turn:
character_arc:
ending:
pov:
target_length:
tone:

seed_fidelity:
  preserved:
    - seed_ref: SEED_F001
      value_in_proposal:
  altered:
    - seed_ref: SEED_F002
      original:
      changed_to:
  added:
    - id: ADD_001
      value:
      status: PROPOSED
      source: harness
  risk:
    - id: RISK_001
      value:
      related_addition_refs: [ADD_001]

conflicts:
  - id: CONF_001
    seed_ref: SEED_F001
    proposal_field: core_premise
    user_value:
    proposal_value:
    resolution: pending | kept_user | changed_user | dropped
```

### 9.2 Proposal conflict

`conflicts[]` 必须能回答：

- 冲突哪个 Seed Anchor；
- 冲突 Proposal 哪个字段；
- 用户值；
- Proposal 值；
- Gate 2 最终处理结果。

**Gate 2 的处理纪律（v0.1 补充定义，回写项 31）**

- `resolution` 取值：`pending | kept_user | changed_user | dropped`；
- **本次 Gate 2 参与提案存在 `pending` 冲突 → 拒绝确认**（不自动覆盖、不自动合并，见 §6.2）；
- 最终处理结果写入 Gate 2 元数据的 `conflict_resolutions[]`（`{id: CONF_<NNN>, proposal_id, seed_ref, resolution}`）；
- **不修改 `proposals.yaml`**：Proposal 侧保留 `pending` 原值，用户裁决不回写。

### 9.3 source_refs.type=proposal

v0.1 不为 Proposal 每个字段额外发 ID，统一采用字段路径：

```text
<proposal_id>.<field_path>
```

例如：

```yaml
source_refs:
  - type: proposal
    ref_id: PROP_A.core_premise
```

`ref_id` 必须可解析到真实 Proposal 和字段路径。

### 9.4 Seed 溯源边界

- `seed_fidelity` 是 Seed Preservation Rate 的唯一计算来源；
- `seed_fidelity` 在 **Proposal 与 Blueprint 两级都存在**，结构与字段完全一致；评估最终稿时以 **Blueprint 的 `seed_fidelity`** 为对象（用户 merge 多个 Proposal 后，评估对象必须是最终 Blueprint）；
- `source_refs.type=seed` 只做其他 Blueprint 字段的辅助溯源；
- `source_refs.type=seed` 不参与 Seed Preservation Rate 计算；
- `seed_fidelity.added[]` 的条目**永久保持 `status: PROPOSED`、`source: harness`**；Blueprint 其余内容项的 `status` 只允许 `CONFIRMED`，唯一例外就是该子树。

## 10. Seed Preservation Rate

统一指标名称：

> **Seed Preservation Rate**

用于衡量 Harness 是否保留用户原始核心。

### 10.1 原始 Seed Anchor 集合

Seed Interpreter 首次完成后，立即冻结：

```text
raw_seed_anchor_ids
```

其内容等于首次从原始 Story Seed 提取出的：

```text
status = USER_GIVEN
source = user
origin = raw_seed
```

的 Seed Anchor ID 集合。

Gate 1 之后：

- 把 raw_seed anchor 降级为 ambiguous，不删除它在 `raw_seed_anchor_ids` 中的历史身份；
- 把 ambiguous 提升为 fixed，不加入 `raw_seed_anchor_ids`；
- 因此评估分母不会随 Gate 1 操作漂移。

### 10.2 计算

```text
Seed Preservation Rate
= Proposal / Blueprint 中 preserved 的 raw_seed_anchor_id 数
/ raw_seed_anchor_ids 总数
```

**可执行口径（v0.1 补充定义，回写项 6）**：

- **分子** = `seed_fidelity.preserved` 中**同时属于 `raw_seed_anchor_ids`** 的锚点数（去重）；
- **分母** = `raw_seed_anchor_ids` 的总数（首次 Interpreter 完成后冻结，Gate 1 操作不改变它，见 §10.1）；
- `seed_fidelity.altered` 与 `conflicts[]` 中提到的锚点**不增加分子**：它们只用于"该锚点是否被明确处置"的检查（分子只由 `preserved` 贡献）；
- 不属于分母的 `seed_ref`（典型来源：Gate 1 用户提升项）→ 记为**额外约束**（`SEED_REF_NOT_ANCHOR`），不进入分子或分母；
- 既不在 `preserved`、也不在 `altered` / `conflicts` 中的锚点 → 记为**未记账锚点**（`UNACCOUNTED_ANCHOR`），不计入分子，且必须被显式指出（不得静默丢弃）；
- 分母为 0（Seed 中没有 `origin=raw_seed` 的锚点）→ Rate 记为 `null`（`EMPTY_DENOMINATOR`），不退化为 100%。

要求：

- Rate 范围固定为 0～100%，输出保留 1 位小数（`rate_percent`）；
- Gate 1 确认的推测可作为额外约束，但不进入分母；
- 如 Proposal 主动改变原始 USER_GIVEN，必须进入 conflict；
- `seed_fidelity` 同时记录新增主题及喧宾夺主风险；
- Story 10 必须对自动计算结果做人工复核。

## 11. Story Blueprint — 唯一 Schema

Blueprint 先于 Scene Breakdown 产生，因此 **Blueprint 禁止直接引用 scene_id**。

所有 reveal / foreshadowing 落点使用 Blueprint `structure` 相对位置。

### 11.1 Schema 关键部分

```yaml
schema_version: "0.1"
blueprint_version: 1

meta:
  title:
  genre:
  pov: [CH_LIN_YU]   # len ∈ {1,2}
  target_length:

premise:
  id: BP_PREMISE_01
  value:
  status: CONFIRMED
  source_refs: []

theme:
  primary: {id: BP_THEME_01, value: null, source_refs: []}
  secondary: []

characters:
  - id: CH_LIN_YU
    name:
    role:
    desire:
    fear:
    contradiction:
    voice_hint:
    inner_state_pov_visible: [CH_LIN_YU]
    observable_behavior_hints:
      - id: OBH_LINYU_01
        value: 不满时句子变短
        applicable_scene_types: [conflict, dialogue]
    relationships:
      - id: REL_LINYU_CHENMO
        target: CH_CHEN_MO
        kind: lover
        state: together
        since_ref: BP_STR_BEG
        source_refs: []
    source_refs: []

core_conflict:
  id: BP_CONFLICT_01
  value:
  source_refs: []

arc:
  start: {id: BP_ARC_START, value: null, source_refs: []}
  shift: {id: BP_ARC_SHIFT, value: null, source_refs: []}
  end: {id: BP_ARC_END, value: null, source_refs: []}

structure:
  beginning: {id: BP_STR_BEG, value: null, source_refs: []}
  development: {id: BP_STR_DEV, value: null, source_refs: []}
  turning_point: {id: BP_STR_TURN, value: null, source_refs: []}
  climax: {id: BP_STR_CLIMAX, value: null, source_refs: []}
  ending: {id: BP_STR_END, value: null, source_refs: []}

key_knowledge:
  - id: K001
    truth:
    truth_status: CONFIRMED
    known_by:
      CH_LIN_YU: false
      CH_CHEN_MO: true
    reader_knows: false
    reveal_at_structure: BP_STR_TURN
    reveal_order: 1
    reveal_to: [CH_LIN_YU]
    reveal_to_reader: true
    source_refs: []

foreshadowing:
  - id: BP_FS_001
    value:
    setup_at_structure: BP_STR_BEG
    setup_order: 1
    payoff_at_structure: BP_STR_CLIMAX
    payoff_order: 1
    source_refs: []

style_direction:
  id: BP_STYLE_01
  narration:
  dialogue:
  rhythm:
  source_refs: []

seed_fidelity:            # v0.1 新增（回写项 1）
  preserved:
    - seed_ref: SEED_F001
      value_in_proposal:
  altered:
    - seed_ref: SEED_F002
      original:
      changed_to:
  added:
    - id: ADD_001
      value:
      status: PROPOSED
      source: harness
  risk:
    - id: RISK_001
      value:
      related_addition_refs: [ADD_001]
```

> **`seed_fidelity`（v0.1 补充定义，回写项 1）**：Blueprint 顶层必填，结构与本规格 §9.1 的 Proposal `seed_fidelity` 完全一致；
> 它是 Seed Preservation Rate 的唯一计算来源（§10.2）；`added[]` 永久保持 `status: PROPOSED` / `source: harness`，
> 是 Blueprint 内容项 `status: CONFIRMED` 规则的唯一例外。
> ID 生成规则（`OBH_<角色后缀>_<NN>` / `REL_<来源后缀>_<目标后缀>`）见《架构设计》§11.1。

### 11.2 结构位置引用规则

- `reveal_at_structure / setup_at_structure / payoff_at_structure` 必须引用 `BP_STR_*`；
- `*_order` 表示该 structure 段内按最终 Scene.order 排序后的第 N 个 Scene；
- 真实 scene_id 只在 Scene Breakdown 后产生；
- 解析得到的 scene_id 不反写 Blueprint。

### 11.3 其他既定规则

- `len(meta.pov) ∈ {1,2}`；
- **单 POV 的 `inner_state_pov_visible` 默认规则（v0.1 收窄解读，回写项 3）**：POV 角色自己填 `[self]`，**非 POV 角色一律为 `[]`**（空数组合法）；若所有角色都填 `[meta.pov[0]]`，非 POV 角色的 desire / fear / contradiction 会进入 Writer 输入，违反 §20.3 的"Writer 默认不能获得"清单；
- 双 POV 必须显式生成；
- **observable hint 的加载匹配（v0.1 补充定义，回写项 4）**：匹配集合 = Scene 的 `scene_type` ∪ Scene 的 `tone`，与 hint 的 `applicable_scene_types` 求交集，非空即加载；`scene_type` ∈ {`dialogue`, `action`, `interior`, `transition`}，`tone` ∈ {`conflict`, `tension`, `tenderness`, `restraint`, `absurdity`, `suspense`, `warmth`, `grief`}；
- `style_direction` 作为整体 Blueprint Item 使用；
- relationship 级 source_refs 比 character 级更具体，冲突时以 relationship 级为准。

## 12. Blueprint 版本快照

每次用户确认或再次确认 Blueprint 时：

```text
/project/history/blueprint-001.yaml
/project/history/blueprint-002.yaml
...
```

要求：

- 不要求实现 diff；
- 不要求事件溯源；
- 只保证用户可以回到旧版本；
- 当前 `/project/blueprint.yaml` 始终是当前生效版本。

---

## 13. Key Knowledge

v0.1 不做完整知识传播图。

只记录：

- 真相；
- 各 POV 角色是否知道；
- 读者是否知道；
- 计划何时揭示；
- 计划揭示给谁。

统一使用 Blueprint 中的唯一 Key Knowledge Schema：

```yaml
key_knowledge:
  - id: K001
    truth:
    truth_status: CONFIRMED

    known_by:
      CH_LIN_YU: false
      CH_CHEN_MO: true

    reader_knows: false
    reveal_at_structure: BP_STR_TURN
    reveal_order: 1
    reveal_to:
      - CH_LIN_YU
    reveal_to_reader: true
    source_refs: []
```

规则：

- `known_by` 的 key 必须引用 `characters[].id`；
- 单 POV 只需要一个 character key；
- 双 POV 不增加特殊字段，仍使用同一 map；
- POV Filter 根据当前 `scene.pov` 查询 `known_by[current_pov]`；
- `truth` 永远从 Blueprint 读取，不复制到 Story State；
- Story State 只保存 Key Knowledge 的运行时投影。

用途仅限：

- POV Filter；
- 揭示顺序；
- 悬念；
- 误会；
- 秘密。

## 14. Scene Breakdown — 唯一 Schema

Scene Breakdown 是 structure position → concrete scene 的解析阶段。

```yaml
schema_version: "0.1"
scene_id:
order:
pov:
scene_type:
tone: [tension]          # 必填，≥1；取值见下
purpose:
target_length:

narrative_role_ref: BP_STR_TURN

characters:
location:
start_state:
conflict:
turn:
end_state:

allowed_reveals: []
director_notes: []
referenced_blueprint_items: []
proposed_additions: []
```

**`tone`（v0.1 新增必填字段，回写项 7）**

- 取值集合（8 值最小标签集）：`conflict` / `tension` / `tenderness` / `restraint` / `absurdity` / `suspense` / `warmth` / `grief`，**至少 1 个**，可多选；
- 由 Scene Breakdown 阶段产出，**不从 Scene 正文或场景文本推断**；
- 用途：与 `scene_type` 组成**匹配集合 `scene_type ∪ tone`**，供 Observable Behavior Hint（§11.3）与 Style Sample 匹配（§23.1）使用；
- **arc 的覆盖判定不在 Scene 上做**：`narrative_role_ref` 以 structure 位置（`BP_STR_*`）为准，v0.1 **不要求** Scene 挂 arc 位置；
  arc 是否被覆盖由 §16 Coverage Check 按"该 arc 位置被 Scene 直接引用，**或其映射的 structure 位置已被覆盖**（START→BEG、SHIFT→TURN、END→END）"判定。

### 14.1 Structure Resolver

例如 Blueprint：

```yaml
reveal_at_structure: BP_STR_TURN
reveal_order: 1
```

Scene Breakdown 找出：

```text
narrative_role_ref = BP_STR_TURN
```

的全部 Scene，按全局 `Scene.order` 排序，取第 1 个 Scene，并写：

```yaml
allowed_reveals: [K001]
```

Foreshadowing 的 setup/payoff 同理解析。

真实 scene_id：

- 写入 Scene；
- foreshadowing 解析结果写入 Story State；
- 不反写 Blueprint。

order 越界时 Coverage Check 报 high warning。

## 15. allowed_reveals 与结构位置解析的关系

本节正式改为 **allowed_reveals 与结构位置解析契约**。

1. Blueprint 不保存 `reveal_scene`；
2. `allowed_reveals` 只能引用 `key_knowledge.id`；
3. Scene Breakdown 根据 `reveal_at_structure + reveal_order` 生成 `allowed_reveals`；
4. `reveal_to / reveal_to_reader` 来自 Blueprint；
5. `allowed_reveals` 只表示“当前 Scene 允许发生 reveal”，不表示 POV 在 Scene 开始时已经知道；
6. 当前 Scene.allowed_reveals 含 Kx 时，Writer 可获得 `truth + reveal_to + reveal_to_reader`；
7. Writer 不更新 knowledge_state；
8. 一个计划 reveal 默认只能解析到一个 Scene。

## 16. Blueprint Coverage Check

Scene Breakdown 后检查：

- structure / arc / ending / length 覆盖；
- 每个 `reveal_at_structure + reveal_order` 是否恰好解析到一个 Scene；
- 对应 K ID 是否恰好出现在一个 Scene.allowed_reveals；
- foreshadowing setup/payoff structure position 是否都解析成功；
- Scene 是否引用不存在的 Blueprint ID。

`reveal_alignment` 定义为：

> 每个 Blueprint reveal 计划被且只被一个 Scene 的 allowed_reveals 覆盖。

解析失败、order 越界、重复覆盖均为 high warning。

**各检查类型的 severity（v0.1 补充定义，回写项 8）**

| warning 类型 | severity | 说明 |
|---|---|---|
| `structure_coverage` | **high** | structure 位置是否被 Scene 覆盖 |
| `ending_coverage` | **high** | ending 位置是否被覆盖 |
| `reveal_alignment` | **high** | 每个 K 是否恰好被一个 Scene 的 `allowed_reveals` 覆盖 |
| `blueprint_reference_integrity` | **high** | Scene 是否引用了不存在的 Blueprint ID |
| `length_coverage` | medium | 各场 `target_length` 与 Blueprint `meta.target_length` 的匹配 |
| `arc_coverage` | medium | arc 位置是否被覆盖（见下） |

**所有 Coverage warning 一律不阻塞**（§28 的精神：用户可继续创作）。

**arc 覆盖判定（v0.1 补充定义，回写项 8）**

arc 位置**不由 Scene 直接承载**（Scene 的 `narrative_role_ref` 只允许 structure 位置，见 §14），判定按映射进行：

```text
arc 位置被覆盖 ⇔
  （该 arc 位置有 Scene 直接引用）
  或（其映射的 structure 位置已被覆盖）

映射：START → beginning（BP_STR_BEG）
      SHIFT → turning_point（BP_STR_TURN）
      END   → ending（BP_STR_END）
```

- arc 值为空（`null` / 空串）时**跳过该位置的判定**；
- 两者都不满足时产生 `arc_coverage` warning（medium），**不阻塞**。

## 17. Story State Schema

`story_state.yaml` 是运行时投影，不复制 CONFIRMED 内容。

v0.1 **删除 `story_state.characters[].notes`**，避免未定义的杂项状态容器。

```yaml
schema_version: "0.1"
blueprint_version: 1

confirmed_scenes: []

occurred: []

knowledge_state:
  - blueprint_ref: K001
    known_by:
      CH_LIN_YU: false
      CH_CHEN_MO: true
    reader_knows: false
    occurred_reveal: false
    last_updated_scene: null

relationship_state:
  - blueprint_ref: REL_LINYU_CHENMO
    state: together
    last_updated_scene: null

open_questions:
  - seed_ref: SEED_Q001
    value:
    state: open | resolved
    resolution_ref:
      type: blueprint_item | scene
      ref_id:

foreshadowing_state:
  - blueprint_ref: BP_FS_001
    resolved_setup_scene: scene-001
    resolved_payoff_scene: scene-006
    state: planned | setup_written | paid_off

state_rebuild_conflicts:
  - id: SRC_001
    type: ORPHANED | OCCURRED_CONFLICT   # v0.1 扩展枚举，回写项 9
    ref_type: knowledge | relationship | foreshadowing | scene | seed_question
    ref_id:
    blueprint_version: 1
    message:
    resolution_note: null                # null = 未处理
```

**`state_rebuild_conflicts[].type`（v0.1 扩展枚举，回写项 9）**

| 取值 | 产生时机 | 语义 |
|---|---|---|
| `ORPHANED` | §17.3 的 Blueprint 版本重建 | 旧 occurred 引用的 Blueprint 项已不存在；**不删除，重建继续** |
| `OCCURRED_CONFLICT` | Gate 3 的 State Extractor 校验 | 正文实际发生的内容与 Blueprint 计划/投影不一致（如 `revealed_to` 真超集、无交集，或 `relationship_change.from_state` 与 `relationship_state` 不符）；**不覆盖、不自动合并，由用户裁决** |

- 两种类型共用 `SRC_<NNN>` 编号；新增条目从既有最大编号继续（`OCCURRED_CONFLICT` 使用偏移，避免与既有冲突撞号）；
- **未处理的冲突（`resolution_note === null`）一律禁止 Context Compile**（§17.3 的规则对两类冲突同时生效）；
- 冲突**不产生事实**：不写入 `occurred`、不修改 `knowledge_state` / `relationship_state`、不回写 Blueprint。

**低危日志不属于 `story_state`（v0.1 位置明确，回写项 9）**

- 低危日志（如"实际揭示范围窄于计划"）**不是** story_state 的字段，也不落盘；
- v0.1 只在 Gate 3 的结果输出 / CLI 输出中可见，需要留档时用 stdout 重定向；
- 其字段与取值定义见 OCCURRED 生成机制（§18）与 LLM Linter 报告（§25.2）。

### 17.1 初始化

- knowledge_state ← Blueprint 初始 known_by / reader_knows；
- relationship_state ← Blueprint relationship baseline；
- `last_updated_scene = null`；
- foreshadowing_state ← Structure Resolver 的真实 scene_id；
- open_questions ← 当前 seed.yaml.open_questions；
- 不持久化 timeline，顺序只读 `/scenes/*.yaml → order`。

### 17.2 planned_knowledge_view

当前 Scene 开始时，POV 是否已经知道 Kx：

- 相关 reveal Scene 已 confirmed → 用 `knowledge_state.known_by`；
- 尚未 confirmed → 用 Blueprint 初始 known_by + resolved reveal Scene.order + reveal_to + current Scene.order 推导；
- 当前 Scene 本身是 reveal Scene 时，开场仍视为未 reveal；
- allowed_reveals 只控制本场 reveal 权限。

### 17.3 Blueprint Version 重建

- occurred / confirmed_scenes 保留；
- 运行时投影从新 Blueprint / 新 Scene Resolution 初始化；
- occurred 按 `Scene.order` 重放；
- 同一 Scene 内按 occurred 数组物理顺序；
- 引用失效产生 ORPHANED `state_rebuild_conflict`；
- ORPHANED 不删除，重建继续；
- 未处理 ORPHANED 时禁止 Context Compile；
- **Gate 3 阶段产生的 `OCCURRED_CONFLICT` 与 ORPHANED 同类处理**（均为未处理即阻塞 Context Compile，同样不删除、需用户裁决）。

## 18. OCCURRED 生成机制

> 本节的 **§18.1–§18.4 沿用 v0.1 冻结编号**；v0.1 回写只在 §18 内**新增了一个小节**（下方第一个小节），
> 未对既有小节重新编号，因此任何指向 §18.1 / §18.2 的引用仍然有效。

### payload 命名与低危日志（v0.1 新增小节，回写项 10；**§18.1–§18.4 编号未变**）

**payload 命名（与 `story_state` 的字段名分工）**

| 位置 | 字段 | 含义 |
|---|---|---|
| `occurred[].payload` | `knowledge_ref` / `relationship_ref` | **发生了什么变化**（本次正文实际发生） |
| `story_state.knowledge_state[]` / `relationship_state[]` | `blueprint_ref` | **投影自哪个 Blueprint 项** |

- 代码保证 `payload.knowledge_ref === knowledge_state[].blueprint_ref`（同一 ID 的不同角色），**不要求字面同名**；
- 该分工的理由：OCCURRED 描述"事实上发生了什么"，投影描述"这条状态对应哪一项计划"，两者语义不同、生命周期也不同。

**State Extractor 的校验与低危日志**

State Extractor 只输出候选（`knowledge_reveals` / `relationship_changes`），**由 Harness 校验后才写入事实**：

| 情形 | 处理 |
|---|---|
| `payload.revealed_to` == Blueprint `reveal_to` | 正常写入 |
| **真子集**（实际揭示范围窄于计划） | 正常写入 + **低危日志** `{"code": "revealed_to_narrower_than_plan", ...}`（附 `knowledge_ref` / `plan` / `actual`） |
| **真超集** | **conflict**（不写入 occurred、不改投影、不回写 Blueprint） |
| **无交集** | **conflict** |
| `relationship_change.from_state` 与 `relationship_state` 不一致 | **conflict** |
| 引用不存在的 K / REL | **conflict** |

- 低危日志的 entry 形态：`{code, message, evidence}`；本次新增的 code 为 **`revealed_to_narrower_than_plan`**；
- **低危日志不是 `story_state` 的字段，v0.1 不落盘**（见 §17）：只在 Gate 3 的结果 / CLI 输出中可见，需要留档用 stdout 重定向；
- 所有冲突写入 `story_state.state_rebuild_conflicts`（`type: OCCURRED_CONFLICT`，见 §17）。

Gate 3 后 State Extractor 按 `Scene.order` 逐 Scene 处理。

### 18.1 tagged union + deterministic ID

```yaml
id:
type:
scene_id:
status: OCCURRED
source: final_text
source_ref:
payload:
```

ID：

```text
knowledge_reveal    → OCC_K_<knowledge_id>_<scene_id>
relationship_change → OCC_REL_<relationship_id>_<scene_id>
```

重跑按 ID upsert。

### 18.2 knowledge_reveal

`payload.revealed_to` 默认来自 Blueprint `reveal_to`。

State Extractor 对正文实际范围做检查：

- 一致 → 正常写入；
- 实际范围与 Blueprint 不一致 → conflict；
- 不自动静默改写 Blueprint 计划。

### 18.3 relationship_change

必须引用 relationship baseline，并更新 `relationship_state.state / last_updated_scene`。

### 18.4 foreshadowing_state

Structure Resolver 已给出：

```text
resolved_setup_scene
resolved_payoff_scene
```

Gate 3 后按 Scene 顺序推进：

```text
resolved_setup_scene ∈ confirmed_scenes → planned → setup_written
resolved_payoff_scene ∈ confirmed_scenes → setup_written → paid_off
```

payoff 已确认但 setup 未确认 → high warning，不自动跳状态。

## 19. Draft Context（非状态）

在 Gate 3 之前，Scene Draft 不是事实。

为保持相邻 Scene 的语言与 POV 连贯，Context Compiler 可以读取有限 Draft Context。

### 19.1 默认选择规则

```text
默认寻找当前 Scene 之前最近的“相同 POV” Scene Draft，
只截取其末尾 600 个中文字符。
```

配置：

```yaml
draft_context:
  mode: same_pov_previous
  max_chars: 600
```

`max_chars` v0.1 推荐允许 500～800 范围配置。

**`max_chars` 的计数口径（v0.1 补充定义，回写项 11）**

- 单位是 **Unicode 码点**（code point），**不是字节、不是 UTF-16 code unit**；
- 计数**只统计非空白码点**：空白、换行、制表符一律不计入；
- 因此"末尾 600 个中文字符" = **末尾 600 个非空白码点**（中英文混排时按字符个数计，不按宽度计）；
- 截断从末尾向前取（保持紧邻前文的语感），并按段落边界回退到最近的换行处，避免从句子中间切开；
- 同一口径贯穿：`draft_context.max_chars`、Linter 的 span / 阈值、`target_length` 与长度统计、A/B 长度归一化。

规则：

- 首个该 POV Scene 不加载 Draft Context；
- 不默认加载其他 POV 的 Draft；
- 不加载完整上一 Scene；
- Draft Context 不是第五种状态；
- 不写入 `story_state.yaml`；
- 不触发状态升级；
- Blueprint / CONFIRMED 约束优先于 Draft；
- 若 Draft 与 Blueprint 冲突，Linter 报告，不自动更新状态。

## 20. Context Compiler

Context Compiler 从以下输入生成 Writer Context：

- 当前 Blueprint；
- `story_state.yaml`；
- 当前 Scene；
- Key Knowledge；
- 可选 Draft Context；
- Style Samples；
- 当前 Scene 的 `allowed_reveals`。

### 20.1 明确数据源边界

Context Compiler：

- **不得读取 `proposals.yaml`**；
- 不需要“识别并过滤 Proposal 文件”；
- 所有未确认 Proposal 从数据源层面物理隔离；
- Scene 中 `proposed_additions` 默认不进入 Writer Context；
- 若 `proposed_additions` 是事实性内容，必须回 Gate 2 确认后才能进入 Writer；
- 只有纯表达性 / 导演性指令可以由用户改写为 `director_note` 临时加入 Context，这类 note 不得产生故事事实。

### 20.2 Writer 可获得

- 当前 Scene 目的；
- 当前 POV；
- Blueprint 中相关 CONFIRMED 信息；
- 当前 Scene 可观察信息；
- `allowed_reveals` 对应内容；
- Director Surface Notes；
- 2～3 个 Style Samples；
- 必要 Draft Context。

### 20.3 Writer 默认不能获得

- 后续 Scene 内容；
- Ending；
- 未获 `allowed_reveals` 权限的真相；
- 其他角色完整内心；
- `proposals.yaml`；
- 未确认 Proposal；
- 伏笔幕后解释。

---

## 21. Context Manifest Schema

每次 Context 编译必须生成 Manifest。

统一 Schema：

```yaml
schema_version: "0.1"
scene_id:
blueprint_version:
pov:

included_sensitive:
  - id:
    type: key_knowledge | foreshadowing | user_override
    source_ref:
    reason:

excluded_sensitive:
  - id:
    type: key_knowledge | foreshadowing | future_content | unconfirmed_content | user_override | character_inner_state
    source_ref:
    reason: not_revealed_yet | future_scene | non_pov_inner_state | unconfirmed_content | foreshadowing_backstage | user_override

director_surface:
  - id:
    source_ref:
    instruction:
    source: blueprint | scene | user_override

style_samples:
  - sample_id:
    matched_on: [pov, scene_type, tone]

future_content_exposed: false
unconfirmed_proposal_exposed: false

overrides:
  - id: OVR_001
    director_surface_ref: DIR_USER_001
    note:
    source: user
```

约束：

- `excluded_sensitive.reason` 必填，且必须是上面六类之一（枚举，不接受自由字符串）；
- **`excluded_sensitive.type` 共 6 类**（v0.1 扩展枚举，回写项 12）：在原 5 类之上新增 **`character_inner_state`**（"角色内心"这类信息需要能被显式排除，否则 POV 隔离无法在 Manifest 里被审计）；
- **`included_sensitive.type` 不加新类**，仍为 `key_knowledge | foreshadowing | user_override`；reason 词表不变；

**`type` 与 `reason` 的关系（v0.1 补充定义，回写项 12）**

`type` 与 `reason` **不强制 1:1 对应**，但**每条 `excluded_sensitive` 条目的 `reason` 必须与 `type` 语义一致**
（例如 `type: character_inner_state` 的 `reason` 只能是 `non_pov_inner_state` 或 `user_override`）。
实际合法的组合：

| `type` | 允许的 `reason` |
|---|---|
| `key_knowledge` | `not_revealed_yet`（尚未揭示） / `user_override`（用户已在前文揭示） |
| `foreshadowing` | `foreshadowing_backstage`（伏笔幕后解释） |
| `future_content` | `future_scene`（**仅**用于后续 Scene 的内容） |
| `unconfirmed_content` | `unconfirmed_content`（未确认内容） |
| `user_override` | `user_override` |
| `character_inner_state` | `non_pov_inner_state` / `user_override`（含**本场未出场**角色的内心） |

> **OQ-63 裁决（2026-09-30，批次 4）**：① **Schema 不做 type↔reason 强校验**（两者是语义维度，强校验会让用户
> override 复杂化）；本表 + 运行时软检查即为约束。② **组合收窄**：`future_content` 只用于"未来 Scene 的内容"、
> reason 只允许 `future_scene`；"未出场角色的内心"统一用 `character_inner_state` + `non_pov_inner_state`
> （实现已同步，`src/context/compiler.ts`）。

- 普通非敏感 included facts 不逐条写入；
- 用户补充的 director note 内容写入 `director_surface`，并使用 `source: user_override`；
- 同一条用户 override 的审计来源写入 `overrides`，通过 `director_surface_ref` 一对一引用对应 `director_surface.id`；
- 不允许同一用户 note 在两个数组中形成两份彼此无关的正文内容；
- Manifest 默认展示摘要，完整内容用于审计。

**存储位置与覆盖语义（v0.1 位置明确，回写项 13）**

- Manifest 落在 `reports/context-manifest.yaml`，**单文件、末次覆盖**（一个项目多场编译只有一份文件）；
- 文件顶部必须写一行注释 `# Last compiled scene: scene-XXX`，便于人工审计"当前这份是谁留下的"；
- **`writer_context` 不落盘**：它由 Compiler 返回（CLI 打印 / `--json`），只有 Manifest 持久化；
- 需要保留多场 Manifest 时，由使用者自行复制 / 重定向（v0.1 不新增文件结构）。

---

## 22. Context Compiler 失败降级

如果用户发现 Compiler 漏掉关键信息：

- 允许用户在当前 Scene 增加 `director_note`；
- 该 note 进入 Manifest；
- 不自动修改 Blueprint；
- 如果该 note 实际改变故事事实，必须回到 Gate 2 更新 Blueprint。

**两条路径必须区分（v0.1 补充定义，回写项 14）**

| 路径 | 命令 | 落点 | `source` |
|---|---|---|---|
| **持久化到 Scene** | `breakdown --note` | 写进当前 Scene 的 `director_notes[]`（改 Scene 文件） | `user` |
| **只影响本次编译** | `context --note` / `--scene` | 只写进本次 Manifest 的 `director_surface` + `overrides`（**不改 Scene 文件**） | `user_override` |

- 两处语义同时成立：同一句用户指令，持久化路径能跨编译保留，降级路径只对这一次编译生效；
- v0.1 **不允许在编译期静默改写已确认的 Scene**：`context --note` 不写回 Scene；
- 无论走哪条路径，**note 都不得产生故事事实**；若它改变了事实，必须回 Gate 2 更新 Blueprint。

---

## 23. Style Samples

v0.1 标签仅使用：

```text
pov
scene_type
tone
```

### 23.1 匹配降级

按以下顺序选择：

1. `pov + scene_type + tone`
2. 无 tone 命中：降级为 `pov + scene_type`
3. 无 scene_type 命中：降级为 `pov`
4. 全部无匹配：不加载样本，并在 Manifest 记录

Style Sample 不得成为 Writer 阻塞条件。

### 23.2 去实体化

推荐：

```text
人物名 → [CHAR_A]
地点 → [CITY]
公司 → [COMPANY]
特定实体 → [ENTITY]
```

Writer 只参考：

- 句法；
- 节奏；
- 对白密度；
- 叙述距离；
- 修辞密度；
- 信息省略方式。

**`style/profile.yaml` 的 Schema（v0.1 补充定义，回写项 15）**

```yaml
schema_version: "0.1"
samples:
  - sample_id: SAMPLE_001
    tags:
      pov: CH_LIN_YU            # 必须是 CH_* 角色 ID
      scene_type: dialogue      # dialogue | action | interior | transition
      tone: tension             # 与 OBH 相同的 8 值 tone 白名单
    text: |                     # 原文**原样保留**
      ……
    de_entity: true             # 是否已去实体化（§23.2）
    sanitized_text: |           # de_entity=true 时**必填**
      [CHAR_A] 把碗推过去。
```

- `sample_id` 形如 `SAMPLE_<NNN>`，**项目内唯一且不复用**；
- `de_entity=true` 时必须提供 `sanitized_text`（否则无法验证"Writer 不得抄用原实体"）；
- `tags.tone` 与 Scene 的 `tone` 使用**同一套 8 值标签集**（§14）；
- 匹配降级顺序（§23.1）逐级求交：`pov + scene_type + tone` → `pov + scene_type` → `pov` → 不加载样本；
- 最终命中哪一级必须写进 Manifest 的 `style_samples[].matched_on`（可审计）；
- **样本永远不阻塞 Writer**：全无匹配时照常写作，只在 Manifest 记录。

---

## 24. Prose Writer

Writer 的任务不是重新设计故事。

Writer 只负责：

> 将当前 Scene Intent 写成正文。

不得：

- 自行推进未来 Scene；
- 自行揭示未经允许的真相；
- 自行改变结局；
- 自行增加新的核心主题；
- 自行修改状态；
- 读取 Proposal 文件。

---

## 25. Anti-AI Linter

### 25.1 Rule Linter — 只做确定性 / 统计型问题

Story 8 开发前必须冻结一份版本化模板动作词表：

```text
/config/anti-ai-template-actions.yaml
```

首版至少包含“沉默了片刻 / 深吸一口气 / 苦笑 / 眼底闪过 / 微微一怔”等测试项，词表变化必须带版本号。

**词表位置与覆盖（v0.1 位置明确，回写项 16）**

- 模板动作词表是**项目级**配置：`projects/<project_id>/config/anti-ai-template-actions.yaml`；
- 项目未提供时，**回落到仓库级默认词表** `config/anti-ai-template-actions.yaml`（不同题材项目可覆盖，例如悬疑 vs 温情）；
- 升华词典是**独立文件 + 独立 version**：`config/anti-ai-elevation-phrases.yaml`（项目级可覆盖），结构为
  `{schema_version, version, phrases: [{id: EL_<NNN>, pattern, severity, note?}]}`——与模板动作词表同构，因此**同样的回落规则**适用；
- 两份词表都带 `version`，Linter 报告必须记录本次使用的两个版本号（便于复现"当时为什么报警"）。

v0.1 默认启用：

- 明确模板动作列表；
- 句长方差；
- 段长方差；
- 对话比例；
- 连续段尾升华模式。

词频类“重复词 / 高频情绪词”不作为默认主要规则：

- 可进入 low severity 日志；
- 不默认弹给用户；
- 可在后续版本扩展。

### 25.2 LLM Linter — 只做语义型问题

仅检测：

- `author_summary`
- `subtext_exposed`
- `emotion_repeated`
- `voice_blur`
- `over_explanation`

Rule Linter 不检测这些语义问题，避免重复报告。

**Linter 报告的存储与结构（v0.1 位置明确，回写项 17）**

- 报告落在 `reports/linter.yaml`，**单文件、末次覆盖**；文件顶部写 `# Last linted scene: scene-XXX`；
- **Rule 与 LLM 报告共用同一份 Schema**：warning 级字段 `linter: rule | llm` 标明来源；
  报告级 `linter` 表示"最后一次**完整**运行的 Linter"；局部重跑不会把它改成 `llm`；
- warning 结构：`{id: LINT_<NNN>, linter, rule, severity, scene_id, span: {start, end} | null, evidence, message, rewrite?}`；
- **`span` 使用 Unicode 码点偏移（`start` 含、`end` 不含）**；
- `low_severity_log[]` 记录不弹给用户的低级别信息（词频类、`llm_span_invalid` 等），**不进 `warnings[]`**；
  `warnings[]` 中不允许出现 `severity: low`。

**`evidence` 的固定结构（v0.1 补充定义，回写项 18）**

| 规则 | `evidence` 字段 |
|---|---|
| `template_actions` | `{action_id, pattern, occurrences, severity_basis: hit \| repeated, spans}` |
| `sentence_length_variance` | `{cv, mean, stddev, sentence_count, lengths}` |
| `paragraph_length_variance` | `{cv, mean, stddev, paragraph_count, lengths}` |
| `dialogue_ratio` | `{ratio, dialogue_code_points, total_code_points, dialogue_span_count}` |
| `paragraph_ending_elevation` | `{consecutive, paragraph_indexes, matched_patterns}` |

- **"段尾"的窗口口径**：段落最后 **16 个非空白码点**内命中升华词典，即视为"以升华句收尾"；
- 阈值集中在实现内并可被 `project-config.yaml` 的 `linter.thresholds` 覆盖（下文数值为默认值，项目配置是覆盖层）。

**Rule Linter 默认阈值（v0.1 补充定义）**

```text
sentenceLengthCv          0.3      # 句长变异系数下限
paragraphLengthCv         0.35     # 段长变异系数下限
dialogueRatioHigh         0.85     # 对话占比过高
dialogueRatioLow          0.1      # 对话占比过低
templateActionEscalateCount 3      # 同一模板动作出现 ≥3 次升为 high
elevationConsecutiveParagraphs 3   # 连续 3 段以升华句收尾
sentenceLengthMinCodePoints 100    # 短于该长度（码点）不做句长统计
paragraphCountMin         3        # 段落数下限（不足则跳过段长方差）
dialogueMinCodePoints     200      # 对话样本长度下限
wordFrequencyMinOccurrences 3      # 词频类 low 日志的出现次数阈值
paragraphSplit            blank_line
```

### 25.3 Severity

```text
high   默认展开
medium 默认折叠
low    仅日志
```

**五类语义类型的默认 severity（v0.1 补充定义，回写项 18）**

| 类型 | 默认 severity | 含义 |
|---|---|---|
| `author_summary` | **high** | 替读者总结（"她终于明白……"） |
| `subtext_exposed` | **high** | 把潜台词直接说明 |
| `emotion_repeated` | medium | 同一情绪反复直说 |
| `voice_blur` | medium | 角色声音模糊（说话人可互换） |
| `over_explanation` | medium | 过度解释动作 / 因果 |

- severity 决定展示策略，**不改变"Linter 只产 warning、不产生 Hard Error"**；
- LLM Linter 的 span 必须满足 `0 ≤ start < end ≤ 码点总数` 且回切非空，不合法时**丢弃该条**并写入
  `low_severity_log: [{code: "llm_span_invalid", …}]`，**不让整个 Linter 失败**。

---

## 26. Linter 降级与配置

如果某条 Rule Linter 误报明显：

- 用户可以关闭单条规则；
- 关闭状态写入项目配置；
- 不影响其他规则。

LLM Linter 只提供 warning，不设置 Hard Error。

---

## 27. Local Rewrite

禁止默认整篇重写。

流程：

```text
Draft
↓
Linter
↓
定位 span
↓
局部 Rewrite
↓
局部二次 Linter
```

Rewrite 后：

- Rule Linter 只重跑 span 所在段落及相邻必要范围；
- LLM Linter 只检查 span 及前后一段；
- 不默认重跑全篇统计；
- 用户主动请求或终稿前全检时，才跑完整 Linter。

**Local Rewrite 契约（v0.1 补充定义，回写项 19）**

- 输入：问题 span + 该 span 的切片 + warning + 前后各一段 + Scene 元信息 + Style Samples；
- 输出：**纯文本**（不带引号、不加前缀、不含 Markdown 包裹）；
- 长度上限：**≤ 原 span 长度的 3 倍**；
- 无法改写时输出原文，并记 `rewrite.applied = false`；
- 不得引入 Scene 之外的实体、不得泄露未授权 truth、**不得改变 `end_state` 语义**；
- **拼接守恒**：替换后除该 span 之外，正文必须**字节级一致**；
- **重叠重复防线**：替换文本与紧邻上下文的**最长重叠达到 4 码点即拒绝**（避免"手机亮了一次，手机亮了一次"这类重复粘贴；4 码点以下视为正常衔接）；
- 落回方式：**原地改写** `drafts/scene-NNN.md`；**不新增备份文件、不实现自动回滚**；
- 审计：在被处理的 warning 上写 `rewrite: {applied, before, after, rewrite_contract, rewritten_at}`；该记录必须能被后续局部重跑保留。

**二次检查范围（v0.1 补充定义，回写项 20）**

| Linter | 重跑范围 |
|---|---|
| Rule Linter | span 所在**段落 + 相邻段落** |
| LLM Linter | span **± 前后各一段** |

- 两个范围**各自独立定义**，不互相推导；
- 范围外的旧 warning **不变**；范围内的旧 warning 被新结果替换；
- 重跑产生的 warning **重新分配 ID**（不复用旧 ID）；
- 终稿前或用户显式请求时跑完整 Linter（`--full`）。

---

## 28. Proposal 失败降级

若 Story Developer 产生的 Proposal 差异不足：

1. 用户可点击“重做”；
2. 第二次仍不满意，可：
   - 手动指定方向；
   - 直接手写 Blueprint 起点；
3. 系统不得卡住用户继续创作。

---

## 29. 项目文件结构

统一使用结构化 Proposal 文件：

```text
/project
  seed.yaml
  proposals.yaml
  blueprint.yaml
  story_state.yaml

  /history
    blueprint-001.yaml
    blueprint-002.yaml

  /blueprint-history          # v0.1 新增（回写项 21 / 23）
    001.meta.yaml             # Gate 2 元数据，与 history/blueprint-<NNN>.yaml 按同一 NNN 一一对应
    002.meta.yaml

  /scenes
    scene-001.yaml
    scene-002.yaml

  /drafts
    scene-001.md
    scene-002.md
    final.md

  /style
    profile.yaml
    /samples

  /reports
    coverage.yaml
    context-manifest.yaml
    linter.yaml

  project-config.yaml
```

不维护 `proposals.md`。

**v0.1 回写核对（2026-09-30，批次 3）**：

- **新增条目**：`blueprint-history/<NNN>.meta.yaml`（Gate 2 的字段计划 / 字段来源 / 用户手改 `EDIT_<NNN>` / 冲突裁决 `CONF_<NNN>` / Gate 2 action `GATE2_<NNN>` / warnings）；
  快照仍在 `history/blueprint-<NNN>.yaml`，两者按同一 `<NNN>` 一一对应；`blueprint.yaml` 内容不受该文件影响；
- **其余文件树无变更（备案）**：`drafts/final.md` 落在既有 `/drafts` 下；评估资产放在仓库的 `tests/fixtures/evaluation/`（**不在 `projects/` 内**，因此不改变本节的目录结构）；
  `/config` 下的词表为**项目级可选覆盖**（缺省回落仓库级默认，见 §25.1）。

---

## 30. MVP 范围

### 支持

- 1,000～30,000 字短篇；
- 自由文本 Story Seed；
- Gate 1 低摩擦修正；
- 2～3 个 Proposal；
- Blueprint 选择 / 合并 / 编辑；
- Blueprint 快照；
- 单 POV / 双 POV；
- 线性时间；
- Scene Breakdown；
- Blueprint Coverage Check；
- Key Knowledge；
- Context Compiler；
- Context Manifest；
- Style Samples；
- Rule Linter；
- LLM Linter；
- Local Rewrite；
- Gate 3 后 OCCURRED 提取。

### 不支持

- 长篇 Canon 管理；
- Chapter Facts 全局检索；
- 完整事件溯源；
- Retcon 影响分析；
- 多时间线；
- 群像；
- 硬核推理公平性；
- 复杂力量体系；
- RAG / Vector DB；
- 自动知识传播图；
- 多 Agent；

**v0.1 回写核对（2026-09-30，批次 3）：无变更（备案）。**
- 自动无限续写。

---

## 31. 评估指标

### 31.1 Story Development

- 一句话输入能否得到可用 Blueprint；
- Proposal 差异度；
- 用户对 Blueprint 的修改量；
- **Seed Preservation Rate**；
- 新增主题喧宾夺主率。

**v0.1 落地（回写项 25）**

- **测试集**：`tests/fixtures/evaluation/story-development/seeds.yaml`，收录 **10 个 Seed**（≥10 的最低要求写在文件里，加载时强制校验）；
- **measured 7 个** = 2 个项目型（`demo-01` / `demo-02`，指标从 Gate 2 产物汇总）+ 5 个 fixture 型
  （情感 / 悬疑 / 温情 / 现实 / 轻科幻，由**离线回放**走与产品相同的代码路径现算：`seed_interpreter` → Gate 1 → `story_developer`）；
- **corpus_only 3 个**（开放结局 / 单场景 / 强反转）：只保留输入，**不产出指标行**，命令必须显式列出它们而不得假装跑过；
- **结果文件**：`results.csv`，列为 `seed_id, proposal_count, distinctness_ok, proposal_id, seed_preservation_rate, preserved, altered, additions, risks, conflicts, unaccounted_anchors`；
- Seed Preservation Rate 的口径见 §10.2（分子只由 `preserved` 贡献，未记账锚点必须为 0）。

### 31.2 正文质量

至少 10 组 A/B：

```text
普通 Prompt
vs
Writing Harness
```

盲测评价：

- 更像人写；
- 更自然；
- 人物更像真人；
- 对话更自然；
- AI 感更低；
- 更愿意继续阅读。

**v0.1 落地与边界（回写项 26）**

- **v0.1 不执行盲测、不自动评分**：只准备"可运行的 A/B 对照 + 人工填写模板"；
- 对照集：`tests/fixtures/evaluation/anti-ai/session-<NNN>/`，含 **≥10 个 Scene Intent**（两个 demo 各 5 场），
  每个分组给出 `group-G<NN>.a.txt`（**普通一次性 Prompt**，输入仅 Scene Intent）与 `group-G<NN>.b.txt`（**Writing Harness**）；
- 人工评分模板 `ratings.csv` 的列固定为：
  `group_id, text_a_file, text_b_file, rater_id, more_humanlike, more_natural, dialogue_more_natural, characters_more_alive, lower_ai_feel, want_to_continue, notes`
  （评分列在 v0.1 由人工填写，工具不写入）；
- **长度归一化口径**：因为 A / B 两侧文本长度可能相差很大，报告必须同时给出"平均码点数"与
  "**每千个非空白码点的 warning 数**"；两侧平均长度差 **≤ ±20%** 时原始计数可信，否则以归一化结果为准；
- 该归一化结果作为 v0.1 通过标准第 7 条（AI 感改善趋势）的证据；**样本量有限（10 组）**，方向明确但需在 v0.2 扩大样本验证。

### 31.3 作者成本

记录：

- 显式 Gate 次数；
- Gate 1 是否经常需要大修；
- Blueprint 修改量；
- Linter warning 数；
- 局部 Rewrite 次数。

目标：

```text
显式 Author Gate = 3
```

**v0.1 落地（回写项 27）**

- 结果文件：`tests/fixtures/evaluation/story-development/author-cost.csv`，列固定为
  `project_id, explicit_gates, gate1_status, gate1_fixed_items, gate1_gate1_confirmed_items, blueprint_versions, blueprint_conflicts_resolved, linter_warnings, rewrites_applied, scenes, confirmed_scenes, occurred, unresolved_state_conflicts`；
- 所有数值**可从项目状态复算**（不手工填），"显式 Gate 次数"按 Gate 1 / Gate 2 / Gate 3 各计一次；两个 demo 实测均为 **3 次**。

---

## 32. 四条原则必须落入测试

### 原则 1 测试

构造一个 PROPOSED 项，运行 Scene Breakdown 和 Writer。

期望：

```text
status 仍为 PROPOSED
```

### 原则 2 测试

测试覆盖三个阶段：

1. Proposal 生成；
2. Scene Breakdown 引用；
3. Draft 生成。

Seed 没有“忘记纪念日”，Harness 新增该设定时，三个阶段都必须保持：

```text
source = harness
status = PROPOSED
```

不得成为 `USER_GIVEN`；在未经过 Gate 2 前也不得成为 `CONFIRMED`。

### 原则 3 测试

构造一个未揭示 Key Knowledge。

期望：

- Writer Context 不包含 truth；
- Manifest 的 `excluded_sensitive` 有对应记录和 reason。

### 原则 4 测试

连续生成多个 Scene，后续 Scene 引用前面推演出的未确认设定。

期望：

```text
状态不自动升级
```

**v0.1 回写核对（2026-09-30，批次 3）：无变更（备案）。** 四条原则的自动 / 固定测试已在 Story 10 F 落地
（`tests/acceptance/story10.principles.test.ts` + 各 Story 的状态机表驱动测试）。

---

## 33. 冻结结论

Short-story-first Writing Harness v0.1 不追求成为通用 AI 小说系统。

它只证明：

> 一个普通用户只给一句故事大概，系统能否保留其核心想法，发展出可选的完整故事方案，并最终生成比普通一次性 Prompt 更自然、更低 AI 感的短篇正文。

冻结后的核心控制点为：

```text
Gate 1 位置固定
唯一 Blueprint Schema
唯一 Scene Schema
Key Knowledge / allowed_reveals 规则固定
OCCURRED 路径固定
Story State Schema 固定
Context Manifest Schema 固定
Proposal 与 Writer 物理隔离
```

**v0.1 冻结声明（2026-09-30，四批回写全部完成）**

```text
封版点（commit）      d0d65da
本文件                《需求规格》v0.1（回写完成版，33 章）
同批冻结              《架构设计》v0.1（35 章）、《开发 Story 拆分》v0.1
回写批次              批次 1 状态模型核心 / 批次 2 POV·隔离·报告·Style /
                      批次 3 文件结构·评估·备案·冻结声明 / 批次 4 状态与冲突模型补漏
                      → 四批全部执行完毕，条目 1–32 全部处置
通过标准              《开发 Story 拆分》Story 10 G（8 条，逐条有可执行证据，见 G.1）
遗留未决（不阻塞）    OQ-56 / OQ-57 / OQ-58（待复核）；OQ-59 / OQ-60 / OQ-61 / OQ-62 / OQ-63 已处理
```

- 通过标准 8 条与其实证据见《开发 Story 拆分》Story 10 G / G.1；
- 本文件所有与 v0.1 实现相关的补充定义，均带「回写项 N」标记，可在 `docs/DECISIONS.md` §十三 逐条追溯。
