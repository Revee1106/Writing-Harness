# Short-story-first Writing Harness v0.1 — 开发 Story 拆分

## 1. 文档状态

- 版本：v0.1
- 状态：冻结开发基线（评审修订版）
- Story 数量：10
- 强制里程碑：M1（Story 5 后）
- 所有 Schema 直接引用《架构设计》，不得在 Story 实现时另建平行结构

**v0.1 最终基线（回写完成，2026-09-30）**

- 封版点（commit）：`d0d65da`
- 回写批次：批次 1（状态模型核心）→ 批次 2（POV / 隔离 / 报告 / Style）→ 批次 3（文件结构 / 评估）→ 批次 4（状态与冲突模型补漏，待完成）
- 回写依据：仓库内 `docs/DECISIONS.md` §十三「封版后文档维护清单」（32 条）+ §十四 回写期裁决
- 回写性质：**只做定义补全、枚举扩展、位置明确、备案**，不改变架构方向；条款级改动逐条带「回写项 N」标记
- 文档自洽性：三份文档在同一批次内同步修改，不保留中间状态


---

## 2. 开发原则

- 按 Story 1 → Story 10 顺序推进；
- Story 5 完成后必须执行 Milestone M1；
- v0.1 不引入 RAG、多 Agent、事件溯源、复杂数据库；
- 每个 Story 完成后必须有自动测试或固定样例；
- 四条底层原则必须进入测试；
- 不允许为了“以后可能需要”提前引入长篇架构。

---

# Story 1：Project Model + Story Seed

## 目标

建立最小项目结构、状态枚举和自由文本 Seed 输入。

## 功能

实现：

```text
USER_GIVEN
PROPOSED
CONFIRMED
OCCURRED
```

通用状态数据：

```yaml
id:
value:
status:
source:
source_ref:

# 仅 USER_GIVEN 使用
origin: raw_seed | gate1_confirmation | null
```

并定义 Blueprint source refs 通用结构：

```yaml
source_refs:
  - type: seed | proposal | user_edit | blueprint_gate2
    ref_id:
```

支持创建：

```text
seed.yaml
project-config.yaml
```

Seed 接受：

- 一句话；
- 多句话；
- 简单 Markdown 自由文本。

## 验收

1. 可创建新短篇项目；
2. 可保存用户 raw input；
3. 用户原话原样保留；
4. 状态 / source 可序列化；
5. 不存在自动状态升级；
6. 状态机非法流转可被单元测试拦截。

---

# Story 2：Seed Interpreter + Gate 1

## 目标

完成：

```text
Seed
→ Interpreter
→ Author Gate 1
```

## Interpreter 输出

```text
fixed_by_user
ambiguous
open_questions
```

## Gate 1 允许

- 接受全部；
- 删除错误分类；
- ambiguous → fixed；
- fixed → ambiguous；
- 编辑；
- 跳过。

## 规则

- fixed 必须能追溯用户原文；
- 用户主动提升内容时：
  - `status=USER_GIVEN`
  - `source=user_gate1`
  - `origin=gate1_confirmation`
- 原始 Seed fixed item：
  - `source=user`
  - `origin=raw_seed`
- Gate 1 非阻塞；
- 跳过需记录 `gate1_status=skipped`；
- 不生成问卷。

## 验收

至少 10 个 Seed。

检查：

- 用户明确事实不遗漏；
- 推断不混入 fixed；
- Gate 1 修改能正确更新 source；
- Gate 1 跳过后仍可进入 Story 3；
- `raw_seed_anchor_ids` 与 `gate1_status` 必须写入 `seed.yaml`；
- Gate 1 升降级不得重算 raw_seed_anchor_ids。

---

# Story 3：Story Developer + Proposal

## 目标

生成 2～3 个差异明显 Proposal。

## 数据源

只读取：

- seed.yaml；
- Gate 1 后的 Interpreter 结果；
- 可选风格偏好。

## 输出

统一写入：

```text
proposals.yaml
```

不得维护 proposals.md 状态副本。

## Proposal Schema

使用架构文档唯一 Proposal Schema。

强制：

- `seed_fidelity`
- 结构化 `conflicts[]`（seed_ref / proposal_field / user_value / proposal_value / resolution）
- `source_refs.type=proposal` 采用 `<proposal_id>.<field_path>`
- 新增内容 `status=PROPOSED`
- `source=harness`

## 降级

- 用户可重做；
- 连续两次不满意后可手动指定方向或直接写 Blueprint 起点。

## 验收

至少 10 个 Seed：

- Proposal 2～3 个；
- 差异不是措辞差异；
- USER_GIVEN 冲突可被记录；
- Seed Preservation Rate 可计算；
- Harness 新增内容不会成为 USER_GIVEN。

---

# Story 4：Blueprint Confirm / Merge / Edit（Gate 2）

## 目标

完成第二个核心 Author Gate。

## 功能

支持：

- 选择一个 Proposal；
- 合并多个 Proposal；
- 手动修改；
- 重新生成；
- 直接从用户自写内容开始；
- 确认 Blueprint。

## Schema

必须使用架构文档唯一 Blueprint Schema。

Story 4 必须保证所有可引用 Blueprint 项都有稳定 ID，包括：

```text
theme
arc
structure
foreshadowing
style_direction
relationships
key_knowledge
```

并实现结构化 `seed_fidelity`，使 preserved / altered 能回指 Seed Anchor ID。

同时必须实现：

- Blueprint 禁止直接引用 scene_id；
- Key Knowledge 使用 `reveal_at_structure + reveal_order`；
- Foreshadowing 使用 `setup/payoff_at_structure + order`；
- 单 POV 时 `inner_state_pov_visible` 默认规则；
- 双 POV 时显式可见性；
- 结构化 `observable_behavior_hints`；
- relationship baseline；
- `style_direction` 作为整体 Blueprint Item；
- `source_refs` 使用结构化 `{type, ref_id}`；
- 初始化并冻结 `raw_seed_anchor_ids`，供 Seed Preservation Rate 使用。

## 状态规则

只有显式 Gate 2 确认：

```text
PROPOSED → CONFIRMED
```

未选内容保持 PROPOSED。

## 版本

每次确认产生：

```text
blueprint.yaml
/history/blueprint-NNN.yaml
```

## 验收

1. 可确认单 Proposal；
2. 可合并 A+B；
3. 关键字段保留 source_refs；
4. Seed Fidelity 存在；
5. 未确认 Proposal 不进入 Blueprint；
6. Blueprint snapshot 可回读；
7. USER_GIVEN 冲突必须在确认前可见。

---

# Story 5：Scene Breakdown + Story State + Coverage Check

## 目标

将 Blueprint 拆成 Scene，并建立轻量 Story State。

## Scene Schema

必须使用架构文档唯一 Scene Schema，包括：

```text
order
allowed_reveals
referenced_blueprint_items
proposed_additions
```

## Story State

实现架构文档唯一 `story_state.yaml` Schema。

关键实现约束：

- Story State 是运行时投影，不复制 Blueprint CONFIRMED；
- 不持久化 timeline，Scene 顺序只读 `/scenes/*.yaml → order`；
- Gate 3 的确认结果写 `confirmed_scenes`；
- Key Knowledge 使用 `known_by` map；
- knowledge_state 不复制 truth，只保存 `blueprint_ref` 与运行时可见状态；
- relationship_state 初始化自 Blueprint relationship baseline；
- foreshadowing_state 初始化为 planned，并保存 resolved_setup_scene / resolved_payoff_scene；
- open_questions.resolution_ref 使用 `{type: blueprint_item | scene, ref_id}`；
- v0.1 移除 story_state.characters[].notes；
- relationship change 必须引用 `relationship.id`；
- planned knowledge view 仅在 Compiler 内临时计算，不持久化；
- Blueprint Version 变化时必须重建运行时投影，并重放 occurred；
- occurred 使用 tagged union + deterministic ID。

## POV / Key Knowledge / allowed_reveals

实现双 POV 统一模型：

```text
key_knowledge.known_by[character_id]
```

并实现角色内心物理隔离：

```text
characters[].inner_state_pov_visible
```

非当前 POV 角色不得把 desire / fear / contradiction 加入 Writer 输入。

实现 Structure Resolver + allowed_reveals 契约：

- `reveal_at_structure + reveal_order` 解析为唯一真实 Scene；
- Key Knowledge ID 自动写入解析 Scene.allowed_reveals；
- Foreshadowing setup/payoff 结构位置解析为 resolved_setup_scene / resolved_payoff_scene；
- 真实 scene_id 不反写 Blueprint；
- order 越界或重复解析为 high warning。

## Coverage Check

检查：

- structure；
- arc；
- foreshadowing；
- ending；
- length；
- reveal alignment；
- Blueprint 引用完整性。

## 关键规则

Scene 新增内容：

```text
status=PROPOSED
source=scene_breakdown
```

即使被后续 Scene 引用也不升级。

## 验收

1. Blueprint 稳定拆成 Scene；
2. Scene 引用 Blueprint ID；
3. allowed_reveals 只能引用 Key Knowledge；
4. Story State 可初始化；
5. Scene proposed additions 不升级；
6. Coverage warning 结构化输出；
7. `reveal_to / known_by / allowed_reveals` 的优先级有固定测试；
8. Blueprint version 升级可重建 State；
9. occurred 重跑不会重复；
10. open question resolution 可引用 Blueprint Item 或 Scene；
11. structure position → scene_id 可唯一解析；
12. foreshadowing setup/payoff 解析结果可进入 Story State；
13. Story State 不存在未定义的 characters.notes。

---

# Milestone M1：最小端到端验证

> M1 是强制流程里程碑，不占 Story 编号。

Story 5 完成后立即执行。

## 路径

```text
Seed
→ Interpreter
→ Gate 1
→ Proposal
→ Gate 2
→ Blueprint
→ Scene Breakdown
→ Story State
→ 手工模拟 Writer Context
```

## 检查项

- status 是否完整；
- source / source_refs 是否完整；
- Blueprint → Scene 字段是否够用；
- Scene 是否引用未确认 Proposal；
- Blueprint 全可引用项是否有稳定 ID；
- Key Knowledge known_by map 是否支撑单 / 双 POV；
- 角色内心是否可物理隔离；
- relationship baseline 是否可投影；
- `reveal_at_structure / setup_at_structure / payoff_at_structure → scene_id` 是否解析正确；
- allowed_reveals 是否由解析结果生成并可执行；
- Future Scene 是否可排除；
- Seed Fidelity 是否能通过 seed_ref 回溯原始锚点；
- relationship change 是否有可引用 baseline；
- reveal_to / known_by / allowed_reveals 的运行时语义是否唯一；
- Blueprint version → State rebuild 是否可跑通；
- occurred 是否为 tagged union 且 ID 幂等；
- open question resolution_ref 是否可解析；
- source_refs 是否为结构化引用；
- Draft Context 规则是否唯一；
- proposals 是否可从 Writer 数据源完全隔离。

## 通过条件

M1 必须使用真实 Seed 跑通。

失败时：

```text
暂停 Story 6
优先修 Schema / 数据契约
```

---

# Story 6：Context Compiler + POV Filter + Manifest

## 目标

生成受控 Writer Context，并确保 Compiler 可审计。

## 数据源

Compiler 只读取：

```text
blueprint.yaml
story_state.yaml
current scene
style metadata
必要 draft context（最近同 POV Scene 末尾，默认 600 字）
```

明确禁止读取：

```text
proposals.yaml
```

## 输出

```text
writer_context
context_manifest
```

## Manifest

必须使用架构文档唯一 Context Manifest Schema。

位置与覆盖（回写项 13）：`reports/context-manifest.yaml`，**单文件末次覆盖**，顶部写 `# Last compiled scene: scene-XXX`；
`writer_context` 不落盘。

`excluded_sensitive.type` 6 类（回写项 12）：`key_knowledge` / `foreshadowing` / `future_content` /
`unconfirmed_content` / `user_override` / **`character_inner_state`**；`reason` 为六类枚举，必填。

## 物理隔离

Writer Context 不得包含：

- future scene；
- ending；
- 未 allowed 的 truth；
- 其他角色完整内心；
- proposal；
- 未确认内容。

## 用户降级路径

Compiler 漏信息：

- 用户可在 Scene 增加 director note；
- 进入 Manifest；
- 若改变故事事实，回 Gate 2。

两条路径（回写项 14）：`breakdown --note` 持久化到 Scene（`source: user`）；`context --note` 只进本次 Manifest 的
`director_surface` + `overrides`（`source: user_override`），**不改 Scene 文件**。

## 验收

至少 10 个 POV 场景：

- secret 不泄漏；
- future 不泄漏；
- Proposal 文件不可达；
- allowed reveal 正常进入；
- excluded_sensitive 有 reason；
- user override 可追踪（included / excluded 都支持 user_override）；
- 非当前 POV 角色完整内心不可达；
- observable_behavior_hints 按 **scene_type ∪ tone** 的联合白名单匹配加载（回写项 4）；
- 当前 POV 对 K001 的“已知/未知”由 confirmed state 或 planned_knowledge_view 唯一判定；
- allowed_reveals 只决定当前 Scene reveal 权限；
- future_content_exposed=false；
- unconfirmed_proposal_exposed=false。

---

# Story 7：Prose Writer + Style Samples

## 目标

完成受控 Scene 正文生成。

## Style Sample 标签

仅：

```text
pov
scene_type
tone
```

## 匹配降级

```text
pov + scene_type + tone
→ pov + scene_type
→ pov
→ no sample
```

不匹配不阻塞；最终命中的级别写进 Manifest 的 `style_samples[].matched_on`。

标签取值（回写项 15）：`scene_type` ∈ {dialogue, action, interior, transition}；`tone` ∈ {conflict, tension,
tenderness, restraint, absurdity, suspense, warmth, grief}（与 Scene 的 `tone` 同一套 8 值标签集）。
样本文件 `style/profile.yaml`：`{schema_version, samples: [{sample_id: SAMPLE_<NNN>, tags, text, de_entity,
sanitized_text?}]}`；`sample_id` 项目内唯一不复用；`de_entity=true` 时必须给 `sanitized_text`。

## Draft Context

默认只加载：

```text
当前 Scene 之前最近的相同 POV Scene Draft 的最后 600 个中文字符
```

`max_chars` 允许项目配置，推荐 500～800。

## 功能

- 手动保存样本；
- 可选去实体化；
- 每 Scene 选择最多 2～3 个样本；
- 按 Scene 生成正文；
- 可带必要 Draft Context。

## Writer 限制

不得：

- 读 Proposal；
- 改 Blueprint；
- 改 Story State；
- 提前 reveal；
- 推进 Future Scene；
- 自动升级状态。

## 验收

至少 10 个 Scene：

- Style Sample 不搬运实体（`de_entity=true` 时必须给 `sanitized_text`，该字段在回写项 15 中明确为必填）；
- POV 不越界；
- 无 future leak；
- 无 state mutation；
- Scene End State 基本符合计划。

---

# Story 8：Rule Anti-AI Linter

## 目标

只实现确定性 / 统计型 AI 痕迹检查。

## v0.1 默认规则

Story 8 开始前必须提交并冻结：

```text
/config/anti-ai-template-actions.yaml
```

作为可测试的版本化模板动作词表。

默认规则：

- 模板动作列表；
- 句长方差；
- 段长方差；
- 对话比例；
- 连续段尾升华。

## 不属于 Story 8 的内容

以下不由 Rule Linter 判断：

```text
作者总结
潜台词直说
情绪语义重复
角色声音趋同
解释过度
```

这些全部属于 Story 9。

## 词频类

- 非核心；
- 如实现，只能 low severity 日志（`low_severity_log[]`，不进 `warnings[]`）。

报告与词表（回写项 16 / 17）：报告落在 `reports/linter.yaml`，单文件末次覆盖（顶部 `# Last linted scene:`）；
Rule 与 LLM 共用同一 Schema（warning 级 `linter: rule | llm`）；模板动作词表为项目级 + 仓库级 fallback，
升华词典为同构独立文件（独立 `version`），两份版本号都写进报告。
`evidence` 按规则固定结构，"段尾"窗口 = 段落最后 16 个非空白码点，默认阈值见《需求规格》§25.2。

## 配置

用户可以关闭单条规则。

保存：

```text
project-config.yaml
```

## 验收

固定测试文本：

- 同一文本结果稳定；
- 规则可单独关闭；
- 不自动 Rewrite；
- 不产生语义型 warning。

---

# Story 9：LLM Linter + Local Rewrite

## 目标

处理语义型 AI 感，并支持局部修复。

## LLM Linter 仅允许类型

```text
author_summary
subtext_exposed
emotion_repeated
voice_blur
over_explanation
```

不得重复 Story 8 的统计型检查。

默认 severity（回写项 18）：`author_summary` / `subtext_exposed` = high；`emotion_repeated` / `voice_blur` /
`over_explanation` = medium。

span 合法性（回写项 17）：`0 ≤ start < end ≤ 码点总数` 且回切非空；不合法 → **丢弃该条**并写
`low_severity_log: [{code: "llm_span_invalid", …}]`，不让整个 Linter 失败。

## Local Rewrite

输入：

- span；
- warning；
- 前后必要上下文；
- 当前 Scene；
- Style Samples。

输出替代 span。

契约（回写项 19）：

- 输出**纯文本**（不带引号 / 前缀 / Markdown 包裹）；长度 ≤ 原 span 的 3 倍；无法改写输出原文并记 `applied: false`；
- **拼接守恒**：除该 span 外正文字节级一致；
- 不得引入 Scene 外实体、不得泄露未授权 truth、不得改变 `end_state` 语义；
- 替换文本与紧邻上下文的**最长重叠 ≥4 码点即拒绝**（防重复粘贴）；
- **原地改写** `drafts/scene-NNN.md`；不新增备份文件、不实现自动回滚；
- 被处理的 warning 上写 `rewrite: {applied, before, after, rewrite_contract, rewritten_at}`，且该记录在局部重跑后保留。

## 二次检查范围

Rewrite 后：

- Rule Linter 只跑 span 所在段落及必要相邻范围（span 所在段落 ±1）；
- LLM Linter 只检查 span + 前后一段；
- 不默认重跑全文；
- 终稿前可主动全检（`--full`）。

范围语义（回写项 20）：两个范围**各自独立定义**；范围外旧 warning 不变；范围内旧 warning 被替换；
重跑产生的 warning **重新分配 ID**（不复用）。

## 验收

至少 20 个问题 span：

- LLM warning 结构化；
- rewrite 不整篇重写；
- rewrite 不引入 future / secret leak；
- 局部二次 Linter 可运行。

---

# Story 10：Gate 3 + State Extractor + End-to-End Evaluation

## 目标

完成终稿确认、OCCURRED 生成和 v0.1 核心评估。

## A. Gate 3

用户确认：

```text
final.md
```

只有 Gate 3 后才运行 State Extractor。

## B. State Extractor

默认只提取：

```text
key_knowledge reveal
relationship change
```

结构要求：

```text
knowledge_reveal → payload.knowledge_ref
relationship_change → payload.relationship_ref + from_state / to_state
```

OCCURRED 使用 tagged union，并按确定性规则生成 ID：

```text
OCC_K_<knowledge_id>_<scene_id>
OCC_REL_<relationship_id>_<scene_id>
```

相同终稿重跑 State Extractor 必须 upsert，不生成重复记录。

写入：

```text
story_state.occurred
```

正常情况不逐条审批。

若与 CONFIRMED 冲突：

- 提示用户；
- 选择改正文或改 Blueprint；
- 不自动覆盖。

## C. Story Development Test Set

至少 10 个 Seed。

记录：

- Proposal 可用性；
- Proposal 差异度；
- Blueprint 修改量；
- Seed Preservation Rate（分母使用 Seed Interpreter 首次冻结的 raw_seed_anchor_ids，不随 Gate 1 升降级变化）；
- 新增主题风险；
- 用户最终选择。

## D. Anti-AI A/B Test

至少 10 个 Scene Intent。

生成：

```text
普通 Prompt
vs
Harness
```

匿名盲测：

- 更像人写；
- 更自然；
- 对话更自然；
- 人物更鲜活；
- AI 感更低；
- 更愿意继续阅读。

## E. Author Cost

记录：

- 三个 Gate 的交互次数；
- Gate 1 修改量；
- Blueprint 修改量；
- warning 数；
- rewrite 数。

## F. 四条原则自动 / 固定测试

### P1：LLM 无权修改现实

PROPOSED 经 Scene + Writer 后状态仍为 PROPOSED。

### P2：可以提案，不能伪装

测试必须覆盖：

1. Proposal 输出；
2. Scene Breakdown 引用；
3. Draft 生成。

Harness 新增“忘记纪念日”时，三个阶段均保持：

```text
source=harness
status=PROPOSED
```

不得成为 USER_GIVEN；未经过 Gate 2 也不得成为 CONFIRMED。

### P3：Compiler 可审计

未揭示 K001：

- Writer 无 truth；
- Manifest excluded_sensitive 有 K001 + reason。

### P4：推演不会产生事实

多 Scene 连续引用未确认设定：

- 状态不升级。

## G. v0.1 通过标准

不要求“自动写出优秀小说”。

只要求：

1. 一句话 Seed 可以形成可用 Blueprint；
2. Gate 顺序低摩擦；
3. Blueprint 可稳定拆 Scene；
4. Proposal 不会渗透 Writer；
5. POV / secret / future 不明显泄漏；
6. Seed Preservation Rate 可测；
7. Harness 正文在 AI 感维度出现明确改善趋势；
8. 用户不承担高频审批。

---

## G.1 每条的 v0.1 证据（回写项 28）

| # | 通过标准 | v0.1 证据（可执行） |
|---|---|---|
| 1 | 一句话 Seed 可以形成可用 Blueprint | 两个 demo 的 Blueprint 过 Schema 且 structure / characters / key_knowledge / style_direction 齐全；Seed 锚点被 `preserved ∪ altered` 全覆盖（6/6、4/4） |
| 2 | Gate 顺序低摩擦 | 每项目 `explicit_gates = 3`（Gate 1+2+3）、`blueprint_versions = 1`、拆场不产生额外审批 |
| 3 | Blueprint 可稳定拆 Scene | Coverage `structure_covered = 5/5`、`warnings = []`；重跑拆场后 Scene 文件逐字节一致 |
| 4 | Proposal 不会渗透 Writer | 每场编译上下文（context + manifest）序列化后不含 `PROP_` / `proposal_id`，也不含 `proposals.yaml` 原文行 |
| 5 | POV / secret / future 不明显泄漏 | 每场 `future_content_exposed=false`、`unconfirmed_proposal_exposed=false`；非 POV 内心只进 `excluded_sensitive`（`non_pov_inner_state`）；Key Knowledge 的 truth 在揭示场景前不出现在正文 |
| 6 | Seed Preservation Rate 可测 | 7 个 measured Seed 全部给出百分比、`unaccounted_anchors = 0`，且同时存在 100% 与 <100%（指标有区分度） |
| 7 | Harness 正文在 AI 感维度出现明确改善趋势 | A/B 长度归一化：A **47.56** / 千码点 vs B **2.55** / 千码点（B/A = 0.054，单位长度 AI 味信号下降 ≥75%）；样本量有限（10 组），需 v0.2 扩大验证 |
| 8 | 用户不承担高频审批 | 每项目 3 次显式 Gate、`explicit_gates / scenes = 0.6 < 1`、rewrite ≤1 次（按需）；Gate 3 为整篇一次性 `--confirm`，无逐场确认 |

证据位置：`tests/acceptance/story10.acceptance.test.ts` 的"验收 F"逐条对应；
命令：`pnpm harness eval story-development` / `eval author-cost` / `eval ab-report`。

---

# 后续版本储备（非 v0.1）

不得提前进入：

```text
Long-form mode
Chapter Facts 全局检索
完整 Canon 管理
事件溯源
Retcon 影响分析
完整知识传播图
Reader Model
多时间线
群像
复杂世界规则
硬核推理公平性
RAG
Vector DB
多 Agent
```

只有 v0.1 核心命题得到验证后再讨论。
