# 项目数据目录

本目录存放各个短篇项目的数据。

- 每个项目一个子目录：`projects/<project_id>/`（D7 裁决），内部文件树照抄
  《需求规格》§29 / 《架构设计》§32：

```text
projects/<project_id>/
  seed.yaml              # Story 1 实现
  project-config.yaml    # Story 1 实现
  proposals.yaml         # Story 3
  blueprint.yaml         # Story 4
  story_state.yaml       # Story 5
  history/               # Story 4（blueprint-NNN.yaml 快照）
  scenes/                # Story 5
  drafts/                # Story 7
  style/                 # Story 7
    profile.yaml
    samples/
  reports/               # Story 5/6/8/9
  config/                # 项目级配置（OQ-07：anti-ai-template-actions.yaml）
```

- 新建项目：`pnpm harness init <project_id> --seed "..."`。
- `demo-01/` 是 Story 1 的端到端示例项目（真实 Seed，用于后续 Story 与 M1 验证）。
- `demo-02/` 是 Story 2 的端到端示例：已跑过 Seed Interpreter + Gate 1（含一次用户提升，
  见 `fixed_by_user` 中 `source: user_gate1` 的条目），可直接作为 Story 3（Story Developer）的输入。
- `demo-01/`、`demo-02/` 均已跑过 Story 3，产出 `proposals.yaml`（每个 2 个差异明显的方案、
  含 seed_fidelity / conflicts / Seed Preservation Rate）。
- `demo-01/`、`demo-02/` 也已完成 Story 4 的 Gate 2：`blueprint.yaml`（当前版本）、
  `history/blueprint-001.yaml`（快照）、`blueprint-history/001.meta.yaml`（Gate 2 动作与字段来源元数据）。
- `demo-01/`、`demo-02/` 也已完成 Story 5：`scenes/scene-00N.yaml`、`story_state.yaml`、
  `reports/coverage.yaml`（两个项目均为 5 个 Scene、零 Coverage warning）。
- `demo-01/`、`demo-02/` 也已完成 Story 6：`style/profile.yaml`（手工样本）与
  `reports/context-manifest.yaml`（受控上下文审计）。demo-01 的 Manifest 是 scene-003
  （含 allowed_reveals=K001 与一条用户 override），demo-02 的是 scene-001。
- `demo-01/`、`demo-02/` 也已完成 Story 7：`drafts/scene-00N.md`（各 5 场正文，**零硬检查失败**）。
  fixture 正文刻意压缩（约 110～200 码点/场）以便离线复现，因此篇幅软检查会给出
  `LENGTH_DEVIATION` 提示；这正是"target_length 只做外部校验"的演示。
  这两个项目可直接作为 Story 8 / Story 9（Linter + Rewrite）的输入。
- 其余目录中的项目属于本地创作数据；是否提交由作者决定（当前仓库未对 `projects/**` 设忽略规则）。
