# 仓库级默认配置目录

本目录用于放置**仓库级默认**配置文件。

- `anti-ai-template-actions.yaml`：反 AI 模板动作词表（版本化）。
  - 依据：需求规格 §25.1 / 架构设计 §26 —— "Story 8 开发前必须冻结一份版本化模板动作词表"。
  - 位置裁决（OQ-07）：**项目级**优先，路径为
    `projects/<project_id>/config/anti-ai-template-actions.yaml`；
    **允许 fallback 到仓库级默认词表**（即本目录下的同名文件）。
  - 本目录当前为空占位：词表内容属于 Story 8 的交付物，Story 1 不提前发明词表。

除上述用途外，本目录不承载任何项目状态。所有项目状态均落在 `projects/<project_id>/` 下（需求规格 §29 / 架构设计 §32）。
