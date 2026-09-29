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
- 其余目录中的项目属于本地创作数据；是否提交由作者决定（当前仓库未对 `projects/**` 设忽略规则）。
