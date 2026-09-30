# Short-story-first Writing Harness v0.1 — 架构设计

## 1. 文档状态

- 版本：v0.1
- 状态：冻结开发基线（评审修订版）
- 适用范围：短篇优先模式
- 本文所有 Schema 与《需求规格》保持唯一版本，不允许实现层自行定义平行结构

---

## 2. 架构目标

v0.1 采用轻量、单模型可运行、非多 Agent、非 RAG 架构。

重点解决：

1. 模糊 Story Seed 如何发展成可确认 Blueprint；
2. 已确认 Blueprint 如何稳定拆成 Scene；
3. Writer 如何只获得当前 Scene 所需信息；
4. 正文如何降低 AI 感；
5. 所有状态升级如何保持作者主权。

---

## 3. 总体架构

```text
┌──────────────────────┐
│      User Seed       │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│   Seed Interpreter   │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│ Author Gate 1        │
│ 确认/修正/跳过理解   │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│   Story Developer    │
│   2~3 Proposals      │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│ Author Gate 2        │
│ 选/合并/改 Blueprint │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│ Confirmed Blueprint  │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│   Scene Breakdown    │
└──────┬────────┬──────┘
       │        └────────→ Coverage Check
       ↓
┌──────────────────────┐
│   Context Compiler   │
│ + POV Filter         │
└──────┬───────────────┘
       ├────────→ Context Manifest
       ↓
┌──────────────────────┐
│    Prose Writer      │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│ Rule / LLM Linter    │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│    Local Rewrite     │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│ Author Gate 3        │
│    终稿确认          │
└──────────┬───────────┘
           ↓
┌──────────────────────┐
│   State Extractor    │
│ OCCURRED / Conflict  │
└──────────────────────┘
```

---

## 4. Seed Interpreter

### 输入

自由文本 Story Seed。

### 输出

```yaml
fixed_by_user:
ambiguous:
open_questions:
```

### 规则

- `fixed_by_user` 必须来自用户原始输入；
- 推断不能混入 `fixed_by_user`；
- 保留 raw input；
- Open Question 不自动变成 Ask User。

---

## 5. Author Gate 1

位置固定为：

```text
Seed Interpreter
→ Gate 1
→ Story Developer
```

### 允许操作

- 接受全部；
- 删除错误分类；
- `ambiguous → fixed_by_user`；
- `fixed_by_user → ambiguous`；
- 编辑；
- 跳过。

### 状态影响

若用户主动将内容提升为 `fixed_by_user`：

```text
status = USER_GIVEN
source = user_gate1
origin = gate1_confirmation
```

原始 Seed 中直接抽取的 fixed item 必须记录：

```text
source = user
origin = raw_seed
```

Gate 1 非阻塞。

`raw_seed_anchor_ids` 与 `gate1_status` 均持久化在 `seed.yaml`；前者首次 Interpreter 后冻结，Gate 1 不重算。

---

## 6. Story Developer

输入：

- Story Seed；
- Gate 1 后的 Seed Interpretation；
- 可选用户风格偏好。

输出：

2～3 个 Proposal。

要求：

- 差异明显；
- 每个 Proposal 有完整故事闭环；
- 每个 Proposal 强制包含 `seed_fidelity`；
- 新增主题必须显式列出；
- 所有新增内容为 `PROPOSED`；
- 若与 USER_GIVEN 冲突，必须产生 conflict。

---

## 7. 状态机

### 状态

```text
USER_GIVEN
PROPOSED
CONFIRMED
OCCURRED
```

通用状态项最少包含：

```yaml
id:
value:
status:
source:
source_ref:
```

其中 `origin` 仅对 USER_GIVEN 有意义：

```text
source=user, origin=raw_seed
source=user_gate1, origin=gate1_confirmation
```

其他状态不要求 origin。

Blueprint 的 `source_refs` 不使用自由字符串，统一为：

```yaml
source_refs:
  - type: seed | proposal | user_edit | blueprint_gate2
    ref_id:
```

### 合法流转

```text
USER_GIVEN
    └── 保持 USER_GIVEN

PROPOSED
    └── Gate 2 用户确认 → CONFIRMED

CONFIRMED
    └── Gate 3 后正文实际发生 → OCCURRED
```

### 禁止流转

```text
PROPOSED → CONFIRMED（无 Gate 2）
PROPOSED → OCCURRED
Scene 使用 → 自动升级
Writer 使用 → 自动升级
Draft 出现 → 自动升级
OCCURRED → 自动覆盖 CONFIRMED
```

## 8. 冲突模型

### USER_GIVEN vs PROPOSED

若冲突：

- 不覆盖；
- 不合并；
- Proposal 记录 conflict；
- Gate 2 用户解决。

### OCCURRED vs CONFIRMED

若冲突：

- 不覆盖；
- State Extractor 产生 conflict；
- 用户选择修改正文或修改 Blueprint。

---

## 9. Proposal Schema

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
- `source_refs.type=seed` 只做其他 Blueprint 字段的辅助溯源；
- `source_refs.type=seed` 不参与 Seed Preservation Rate 计算。

## 10. Blueprint Builder

职责：

- 选择 Proposal；
- 合并 Proposal；
- 接受用户手改；
- 将最终用户接受内容转为 CONFIRMED；
- 生成 Blueprint；
- 生成 Blueprint 快照。

Blueprint 是 Scene Breakdown 的唯一故事规划来源。

---

## 11. Blueprint Schema — 唯一版本

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
```

**`seed_fidelity`（v0.1 补充定义，回写项 1）**

- 它是 **Seed Preservation Rate 的唯一计算来源**（需求规格 §10.2），Blueprint 顶层必填；
- `preserved[].seed_ref` / `altered[].seed_ref` 必须指向 Seed Anchor ID；
- `added[]` 是 Harness 补出的内容，**永久 `status: PROPOSED`、`source: harness`**，不得伪装为 USER_GIVEN；
- Blueprint 其余内容项的 `status` 只允许 `CONFIRMED`（= Gate 2 接受），**唯一例外就是 `seed_fidelity.added[]`**。

**ID 生成规则（v0.1 补充定义，回写项 2）**

| 项 | ID 形态 | 生成规则 |
|---|---|---|
| Observable Behavior Hint | `OBH_<角色后缀>_<NN>` | 角色后缀 = 角色 ID 去掉 `CH_` 前缀（`CH_LIN_YU` → `LINYU`）；同一角色内 `NN` 从 `01` 递增 |
| Relationship | `REL_<来源后缀>_<目标后缀>` | 来源后缀 = 拥有该 relationship 的角色后缀，目标后缀 = `target` 角色后缀；同一 Blueprint 内重名时追加 `_2`、`_3` |

ID 由 Harness 确定性分配，模型不自行编号；模型给出的编号在装配阶段按上表规范化。

### 11.2 结构位置引用规则

- `reveal_at_structure / setup_at_structure / payoff_at_structure` 必须引用 `BP_STR_*`；
- `*_order` 表示该 structure 段内按最终 Scene.order 排序后的第 N 个 Scene；
- 真实 scene_id 只在 Scene Breakdown 后产生；
- 解析得到的 scene_id 不反写 Blueprint。

### 11.3 其他既定规则

- `len(meta.pov) ∈ {1,2}`；
- **单 POV 的 `inner_state_pov_visible` 默认规则（v0.1 收窄解读，回写项 3）**：POV 角色自己填 `[self]`（即 `[meta.pov[0]]`），**非 POV 角色的 `inner_state_pov_visible` 一律为 `[]`**（空数组合法）。
  理由：若所有角色都填 `[meta.pov[0]]`，非当前 POV 角色的 `desire` / `fear` / `contradiction` 会顺着 hint 进入 Writer 输入，直接违反 §21 的 POV 隔离与需求规格 §20.3 的"Writer 默认不能获得"清单；
- 双 POV 必须显式生成；
- **observable hint 的加载匹配（v0.1 补充定义，回写项 4）**：匹配集合 = **Scene 的 `scene_type` ∪ Scene 的 `tone`**，与 hint 的 `applicable_scene_types` 求交集，**非空即加载**。
  取值：`scene_type` ∈ {`dialogue`, `action`, `interior`, `transition`}；`tone` ∈ {`conflict`, `tension`, `tenderness`, `restraint`, `absurdity`, `suspense`, `warmth`, `grief`}（8 值最小标签集）。`applicable_scene_types` 因此是"scene_type ∪ tone 的联合白名单"，**不是**单一的 scene type 列表；
- `style_direction` 作为整体 Blueprint Item 使用；
- relationship 级 source_refs 比 character 级更具体，冲突时以 relationship 级为准。

## 12. Blueprint Versioning

每次 Gate 2 确认：

```text
blueprint_version += 1
```

同时保存：

```text
/history/blueprint-001.yaml
/history/blueprint-002.yaml
```

仅保留快照，不实现事件溯源或自动 diff。

---

## 13. Key Knowledge Schema

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
    reveal_to: [CH_LIN_YU]
    reveal_to_reader: true
    source_refs: []
```

规则：

- `known_by` 使用 character id 做 key；
- 单 POV / 双 POV 使用同一结构；
- POV Filter 只查询当前 POV 对应的值；
- truth 只保存在 Blueprint；
- Story State 只保存运行时知识投影；
- 不做完整知识传播图。

## 14. Scene Schema — 唯一版本

Scene Breakdown 是 structure position → concrete scene 的解析阶段。

```yaml
schema_version: "0.1"
scene_id:
order:
pov:
scene_type:
tone: [tension]          # 必填，≥1（v0.1 新增，回写项 5）
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

**`tone`（v0.1 新增必填字段，回写项 5）**

- 取值集合（8 值最小标签集）：`conflict` / `tension` / `tenderness` / `restraint` / `absurdity` / `suspense` / `warmth` / `grief`，**至少 1 个**，可多选；
- 由 Scene Breakdown 阶段产出，**不从 Scene 正文或场景文本推断**；
- 与 `scene_type` 组成匹配集合 `scene_type ∪ tone`，供 Observable Behavior Hint（§11.3）与 Style Sample 匹配（§24）使用；
- `narrative_role_ref` 允许引用结构位置（`BP_STR_*`）**或 arc 位置（`BP_ARC_*`）**（回写项 5）。

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

## 15. allowed_reveals 契约

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

state_rebuild_conflicts: []
```

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
- 未处理 ORPHANED 时禁止 Context Compile。

## 18. OCCURRED 路径

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

## 19. Draft Context

Draft Context 是临时文本上下文，不是状态。

默认选择：

```text
当前 Scene 之前最近的“相同 POV” Scene Draft，
截取末尾 600 个中文字符。
```

配置：

```yaml
draft_context:
  mode: same_pov_previous
  max_chars: 600
```

约束：

- `max_chars` 推荐配置范围 500～800；
- 首个该 POV Scene 不加载；
- 不默认加载其他 POV；
- 不加载完整上一 Scene；
- 不进入 Story State；
- 不触发状态升级；
- Blueprint 优先；
- Draft 与 Blueprint 冲突时交给 Linter。

## 20. Context Compiler 数据源

只允许读取：

```text
blueprint.yaml
story_state.yaml
current scene
style samples
必要 Draft Context
```

**不得读取 `proposals.yaml`。**

这意味着“排除未确认 Proposal”通过数据源物理隔离实现，不通过 LLM 自行判断。

---

## 21. Context Compiler 输出

输出：

```text
writer_context
context_manifest
```

Writer Context 可包含：

- 当前 Scene；
- 当前 POV；
- 相关 Blueprint Confirmed 信息；
- `allowed_reveals`；
- Director Surface Notes；
- Style Samples；
- 必要 Draft Context。

Writer Context 排除：

- Future Scenes；
- Ending；
- 未允许 reveal 的 truth；
- 非当前 POV 可见的角色内心字段；
- Proposal；
- 伏笔真相。

角色 POV 可见性由 `characters[].inner_state_pov_visible` 物理执行，不依赖 Prompt 自律。

---

## 22. Context Manifest Schema

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
    type: key_knowledge | foreshadowing | future_content | unconfirmed_content | user_override
    source_ref:
    reason:

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

规则：

- excluded 的 reason 必填；
- 普通 included fact 不记录；
- 用户 director note 的正文指令进入 `director_surface`，source=`user_override`；
- `overrides` 只保存审计来源，并通过 `director_surface_ref` 一对一引用对应指令；
- Manifest 重点记录敏感 include / exclude。

---

## 23. Context Compiler 降级路径

若 Compiler 漏关键信息：

1. 用户可对 Scene 加 `director_note`；
2. note 进入 Manifest；
3. 如果 note 只是表达方式，不更新 Blueprint；
4. 如果 note 改变故事事实，要求回 Gate 2 更新 Blueprint。

---

## 24. Style Sample Selector

标签：

```text
pov
scene_type
tone
```

降级：

```text
pov + scene_type + tone
→ pov + scene_type
→ pov
→ 不加载样本
```

无样本不阻塞 Writer。

Manifest 记录最终匹配方式。

---

## 25. Prose Writer

只负责将 Scene 写成正文。

不得：

- 读取 proposals；
- 修改 Blueprint；
- 修改 Story State；
- 推进 Future Scene；
- 提前 reveal；
- 自行加核心主题。

---

## 26. Rule Linter

Story 8 开发前必须冻结版本化模板动作词表：

```text
/config/anti-ai-template-actions.yaml
```

仅处理确定性 / 统计型规则：

- 模板动作列表；
- 句长方差；
- 段长方差；
- 对话比例；
- 连续段尾升华模式。

词频 / 高频情绪词：

- v0.1 不作为主要规则；
- 如保留，只能 low severity 日志。

---

## 27. LLM Linter

仅处理语义型：

```text
author_summary
subtext_exposed
emotion_repeated
voice_blur
over_explanation
```

不得与 Rule Linter 重复同一类检测。

---

## 28. Linter 配置与降级

- warning 分 high / medium / low；
- high 默认展开；
- medium 默认折叠；
- low 仅日志；
- 用户可关闭单条 Rule；
- Rule 开关写入 project-config.yaml；
- LLM Linter 不产生 Hard Error。

---

## 29. Local Rewrite

Rewrite 输入：

- 问题 span；
- 前后必要上下文；
- warning；
- 当前 Scene；
- Style Sample。

Rewrite 后：

- Rule Linter 只重跑 span 所在段落及必要相邻范围；
- LLM Linter 只检查 span 及前后一段；
- 不默认全篇重跑；
- 终稿前或用户请求时可跑完整检查。

---

## 30. 失败降级策略

### Seed Interpreter 质量差

- Gate 1 允许用户直接修；
- 允许跳过。

### Proposal 差异不足

- 重做；
- 第二次仍不满意时允许手动指定方向；
- 允许直接手写 Blueprint 起点。

### Context Compiler 漏信息

- 当前 Scene 增加 director note；
- 记录 Manifest；
- 若改变故事事实，回 Gate 2。

### Linter 误报

- 可关闭单 Rule；
- 不阻塞写作。

---

## 31. Seed Preservation Rate

初始化 Seed Interpreter 后冻结：

```text
raw_seed_anchor_ids
```

只包含首次从原始 Seed 提取出的：

```text
source=user
origin=raw_seed
```

Anchor ID。

```text
Seed Preservation Rate
= preserved ∩ raw_seed_anchor_ids
/ raw_seed_anchor_ids 总数
```

Gate 1 的升 / 降级不改变分母。

USER_GIVEN 被 Proposal 改写仍必须进入 conflict，不能只靠该指标提示。

## 32. 文件结构

```text
/project
  seed.yaml
  proposals.yaml
  blueprint.yaml
  story_state.yaml
  project-config.yaml

  /history
    blueprint-001.yaml

  /scenes
    scene-001.yaml

  /style
    profile.yaml
    /samples

  /drafts
    scene-001.md
    final.md

  /reports
    coverage.yaml
    context-manifest.yaml
    linter.yaml
```

---

## 33. 技术实现原则

### 33.1 单模型优先

不同能力使用不同 Prompt Contract，不引入多 Agent 编排。

### 33.2 文件优先

v0.1 不要求数据库。

### 33.3 Schema 优先

状态迁移必须建立在结构化数据上。

### 33.4 Proposal 物理隔离

Writer 链路不得读取 proposals 文件。

### 33.5 Author Control

系统不能自动：

- 接受 Proposal；
- 改 Blueprint；
- 改用户 Seed；
- 把 PROPOSED 升为 CONFIRMED；
- 用 OCCURRED 覆盖 CONFIRMED。

---

## 34. 四条原则的架构测试要求

### P1

Scene / Writer 使用 Proposal 不改变 status。

### P2

Harness 新增内容必须保留 `source=harness`，不能伪装成 USER_GIVEN。

### P3

敏感信息排除必须在 Manifest 可见。

### P4

多轮推演不会产生状态升级。

---

## 35. 架构冻结结论

v0.1 的可靠性主要来自：

```text
明确的 Gate 顺序
唯一 Blueprint Schema
唯一 Scene Schema
严格状态机
Proposal 物理隔离
Key Knowledge reveal 契约
可审计 Context Manifest
局部 Rewrite
```

而不是复杂 Agent 或大型状态系统。
