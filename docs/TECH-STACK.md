# 技术选型（v0.1，D1 裁决）

## 一、选定方案

**TypeScript + Node 24 + pnpm**，依赖：`zod`（Schema）、`yaml`（序列化）、`vitest`（测试）、`typescript`（类型检查）。

| 需求（用户给定） | 落实方式 |
|---|---|
| YAML 序列化 / 反序列化结构化状态 | `yaml` 包（`Document` API 控制 key 顺序与 block literal 风格；写盘前统一 `undefined` 剪枝，保证"省略字段"不会被写成空值） |
| 调用 LLM，且 provider 可替换 | 计划中的 `src/providers/` provider 接口（`complete(contract, input)`）；实现 `OpenAICompatProvider`（DeepSeek/OpenAI/Ollama 等只需 base_url + model）与 `RecordedProvider`（离线 fixture，测试可复现）。**Story 1 尚未引入 LLM 调用。** |
| CLI 或最小 Web UI | CLI 优先：Node 24 原生执行 TS（`node src/cli/index.ts`），使用 `node:util` 的 `parseArgs`，零额外依赖。核心层保持纯函数 + 服务门面，后续 Story 6+ 可再挂最小本地 Web UI。 |
| 单元测试能力 | `vitest run`（`tests/unit`、`tests/acceptance`），全离线 |
| Schema 优先 | zod：Schema 即运行时校验 + 类型来源，替代纯注释式约定 |
| 中文统计 | Node 24 原生 `Intl.Segmenter`（Story 8/9 使用；计数口径见 OQ-16） |

## 二、环境实测（选型依据）

| 探测项 | 结果 |
|---|---|
| Node | `v24.19.0`，原生执行 `.ts`（type stripping）实测通过 |
| pnpm | `10.34.5`，`pnpm add` 实测成功（约 1s），npm registry 可达 |
| Python | `3.12.3` 存在，但**无 pip、无 ensurepip、`venv` 不带 pip**；`~/.local` 在沙箱内不可写 |
| Python 现有依赖 | 系统自带 PyYAML 6.0.1（仅够 stdlib 方案） |

## 三、备选方案（保留，不采用）

**Python 3.12 stdlib + PyYAML 6.0.1**：`dataclasses` + PyYAML + `argparse` + `unittest` 可满足四项硬要求，**零安装**即可运行。代价是手写校验与类型约束（pydantic/ruamel/pytest 需要额外的 pip 引导步骤）。

若未来切换，Schema 语义（字段名、枚举、ID 前缀、状态机规则表）可原样搬运，因为全部集中定义在 `src/core` 与 `src/schema`，不依赖框架特性。

## 四、运行命令

```bash
pnpm install          # 安装依赖
pnpm test             # 运行全部单元测试 / 验收测试
pnpm typecheck        # tsc --noEmit（TypeScript 7）
pnpm harness help     # CLI 入口（无需编译，Node 24 直接执行 TS）
```

## 五、v0.1 明确不引入

数据库、RAG / Vector DB、多 Agent 编排、事件溯源、Retcon 影响分析、多时间线、完整知识传播图（需求规格 §30、架构 §33、Story 拆分「后续版本储备」）。
