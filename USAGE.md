# 使用说明：把一句故事想法写成短篇

这份说明写给**用命令行、但不写代码的写作者**。你不需要懂它的内部结构，
只需要照着命令一步一步走，最后会得到一篇完整的短篇正文。

---

## 1. 这是什么

你给它一句模糊的故事想法（我们叫"故事种子"），它先把这句话理解清楚，
再展开成 2～3 个**明显不同**的故事方案；你挑一个（或者把两个方案拼起来），
它就按你的选择拆出场景、逐场写正文，然后帮你找出"AI 味"重的地方并做局部改写，
最后拼成一篇完整的短篇。

它不会替你决定故事，也不会偷偷改你的想法：**它的产物默认都是"提案"，
要你点头才会变成"确定"**。写作过程中它只问你三次（Gate 1 / Gate 2 / Gate 3）。

---

## 2. 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | **24 或更高**（用到 Node 24 直接运行 TypeScript 的能力） |
| pnpm | **10 或更高**（`npm i -g pnpm` 可安装；用 `pnpm -v` 检查） |
| 操作系统 | 只在实际** Linux（Ubuntu）** 上完整跑过与测试过。Windows / macOS 理论上可用（纯 Node 项目、无原生依赖），但**未经验证**；Windows 上建议在 WSL 里用。 |
| 是否需要 API key | **取决于你怎么用**：仓库里自带两个演示项目与一批"离线录制"，所以你可以**不配 key 先跑通全流程**（见第 8 节 A 部分）。但要用**你自己的故事想法**生成新内容，从 Gate 2 开始就需要一个模型 API key（见下）。 |

**配置 API key（要用自己的故事时才需要）**

它支持任何兼容 OpenAI 接口的服务（OpenAI、DeepSeek、通义、本地 vLLM 等）。
在命令行里设置三个环境变量即可，不需要改任何文件：

```bash
export HARNESS_LLM_BASE_URL="https://api.deepseek.com/v1"   # 服务地址（示例）
export HARNESS_LLM_API_KEY="sk-你的key"
export HARNESS_LLM_MODEL="deepseek-chat"                    # 模型名（示例）
export HARNESS_LLM_TIMEOUT_MS="120000"                      # 可选：超时毫秒数
```

之后在命令后加 `--provider openai-compat`，表示"这次真的去调用模型"。
不加这个参数时，默认是 `auto`：**有离线录制就用录制，没有就需要上面三个变量**。

---

## 3. 安装

```bash
git clone <这个仓库的地址>            # 或直接拿到仓库目录
cd "Write Harness"                    # 进入仓库目录
pnpm install
```

**不需要 `pnpm build`。** 这是一个 Node 24 直接运行 TypeScript 的项目，
装完依赖就能用。

确认可用：

```bash
pnpm harness help
```

你会看到一整屏命令列表（这就是全部命令，没有隐藏功能）。

> 说明：所有命令都以 `pnpm harness` 开头。如果你想让帮助里写的
> `harness init ...` 也能直接用，可以加一个别名：
> `alias harness="pnpm harness"`（Linux / macOS 有效）。
> 也可以直接跑 `node src/cli/index.ts <命令>`。

---

## 4. 快速开始：一篇完整短篇的流程

下面是一个完整流程。为了让你**今天就能不花 API 费用跑通**，
第 8 节会给你一个可以直接照抄的完整会话（用仓库自带的演示项目）。
这一节先讲清每一步在做什么、你有哪些选择。

### 0）准备一个项目目录

每个故事是一个"项目"，放在 `projects/<项目名>/` 下。
项目名只能用英文小写、数字、`-`、`_`，例如 `my-first-story`。

### 1）创建项目并输入故事想法

```bash
pnpm harness init my-first-story --title "我知道" --seed "一个男人每天给去世的妻子发微信，某天突然收到回复。"
```

* **这条命令做什么**：建立一个空项目，并把你的想法原样存下来。
* **你需要输入什么**：项目名（必填）、标题（可选）、故事想法（`--seed` 直接写，或 `--seed-file 路径` 从文件读）。
* **你会看到什么**：

  ```text
  已创建项目：/…/projects/my-first-story
    seed.yaml            schema_version=0.1 gate1_status=pending
    project-config.yaml   id=my-first-story created_at=…
  ```
* **下一步**：让系统先理解这句话（Gate 1）。

想事后改想法也可以：

```bash
pnpm harness seed set my-first-story --text "新的想法……"
pnpm harness seed show my-first-story      # 看当前存的内容
```

> 小提示：`--seed "…"`（直接写）和 `--seed-file 文件`（从文件读）保存的文本**逐字保留**。
> 从文件读时，文件末尾的换行也算内容——这会影响离线录制的匹配，写自己的故事时无所谓，
> 但跟第 8 节 A 部分照抄演示时请用文件方式。

### 2）Gate 1：确认"它有没有读懂你"

```bash
pnpm harness gate1 my-first-story --plan
```

* **这条命令做什么**：把你的想法拆成三类——**你说的（明确）／模糊的／没定的**，
  并生成"Seed Preservation Rate"的分母（也就是你真正说了的几条）。
  `--plan` 是**只看不改**。
* **你会看到什么**（真实输出片段）：

  ```text
  provider=recorded model=recorded-seed-interpreter-v0.1 contract=seed_interpreter@0.1
  fixed_by_user（用户明确说的）：6 条
    - SEED_F001  男人的妻子已经去世    原文：「去世的妻子」
    - SEED_F002  男人每天给妻子发微信    原文：「每天给去世的妻子发微信」
    …
  ambiguous（模糊的）：2 条
    - SEED_A001  回复究竟是谁发的    （无原文片段）
  open_questions（未决定的）：2 条
    - SEED_Q001  回复的来源真相何时揭晓    （无原文片段）
  [plan] 只读预览：未写盘、未改变 gate1_status（Gate 1 非阻塞，需求规格 §5.1）
  ```
* **你有哪些选择**（**必须选一个**，但都很轻）：
  * `--accept-all`：它理解对了，全部接受（状态变成 `confirmed`）。
  * `--skip`：**不想看，直接跳过**（状态变成 `skipped`），后面照样能继续。
  * `--op`：只改你不满意的那几条，可以重复写：
    ```bash
    pnpm harness gate1 my-first-story --op promote:SEED_A001 --op edit:SEED_F001=妻子去世一年
    ```
    可用操作：`promote:ID`（把模糊的变成明确的）、`demote:ID`（反过来）、
    `edit:ID=新内容`（改内容）、`delete:ID`（分类错了就删掉）。
* **不选会怎样**：这一步是**非阻塞**的，你不选就不会往下走（但也不会破坏任何东西）。
  对写作者最省事的做法就是 `--skip`。

### 3）生成故事方案（2～3 个）

```bash
pnpm harness develop my-first-story
pnpm harness proposals show my-first-story     # 看摘要
```

* **这条命令做什么**：把你的想法展开成 2～3 个**在核心冲突／真相／结局上真的不同**的方案，
  并给出每个方案"保留了你原意的百分之多少"。
* **你会看到什么**：

  ```text
  PROP_A  定时消息（现代悬疑）
    核心冲突：男人想继续相信这是妻子，又必须面对这是程序的事实
    真相/转折：那三个字出自妻子生前写好的一串定时消息…
    结局：他等到生日那天，第二条消息如期到来，他没有再回复
    seed_fidelity：preserved 6 / altered 0 / added 1 / risk 1
    Seed Preservation Rate：100%（6/6）
  PROP_B  替她说话的人（现代悬疑）
    …
    Seed Preservation Rate：83.3%（5/6）
    [CONFLICT_PENDING] PROP_B 的 CONF_001 与用户已明确内容冲突…等待 Gate 2 裁决
  ```
* **你有哪些选择**：都不满意就再跑一次 `develop`（会**覆盖** `proposals.yaml`，旧方案不保留，建议先把 `proposals.yaml` 复制一份），或者在 Gate 2 手写字段（见第 7 节）。
* **下一步**：进入 Gate 2 做选择。

### 4）Gate 2：选方案 / 合并 / 手改 → 得到你的"剧本大纲"

```bash
# 只想选 A 方案：
pnpm harness gate2 my-first-story --from PROP_A

# 想合并（每个字段分别指定来自哪个方案），并裁决冲突：
pnpm harness gate2 my-first-story \
  --field title=PROP_A --field premise=PROP_B --field structure=PROP_B --field ending=PROP_A \
  --resolve PROP_B:CONF_001=changed_user \
  --plan          # 先只预览，确认无误后去掉 --plan 真正写入
```

* **这条命令做什么**：把选中的方案（或拼起来的方案）变成正式的**蓝图**——
  可以理解成"剧本大纲 + 人物设定 + 关键信息什么时候揭示"。
* **你有哪些选择**：
  * `--from PROP_A`：整份选 A。
  * `--field 字段=PROP_X`：逐字段挑来源（字段名：`title` / `genre` / `pov` / `target_length` /
    `premise` / `theme` / `characters` / `core_conflict` / `arc` / `structure` /
    `key_knowledge` / `foreshadowing` / `style_direction`）。
  * `--edit 字段=你写的内容`：某个字段你想自己写。
  * `--resolve PROP_B:CONF_001=kept_user|changed_user|dropped`：裁决"方案与你的原意冲突"的地方。
* **不选会怎样**：**必须处理完冲突**才允许确认。如果有没裁决的冲突，它会直接拒绝并告诉你缺哪一条
  （真实报错）：

  ```text
  错误：存在未裁决的 USER_GIVEN 冲突，Gate 2 必须先处理（需求规格 §6.2 / §9.2）：
  - PROP_B:CONF_001（SEED_F004 的 truth_or_turn）：请用 --resolve … 裁决
  ```
* **下一步**：确认后你会看到蓝图摘要，以及两个文件：当前蓝图与它的版本快照。

### 5）拆场景

```bash
pnpm harness breakdown my-first-story
pnpm harness scenes show my-first-story
pnpm harness coverage show my-first-story
```

* **这条命令做什么**：把蓝图拆成 5 场左右的**场景**（每场：谁、在哪、要发生什么、结束时是什么状态），
  同时生成"故事运行状态"，并自动检查大纲有没有漏掉的东西。
* **你会看到什么**（真实输出片段）：

  ```text
  scene-001  order=1  dialogue  pov=CH_WOMAN  BP_STR_BEG  1500字
      purpose: 建立两人的日常与那件小事的引爆点
      两人还在为晚饭吃什么拌嘴 → 一件小事被反复提起… → 她放下筷子说出"那就分吧" → 两人各自沉默，饭没吃完
      proposed_additions（永久 PROPOSED）: 那天晚饭吃的是她做的汤
  ```
* **你有哪些选择**：不满意可以重跑（`--rerun`），也可以给某场加一句导演说明
  （`--note`）。检查出的 warning **不会拦住你**。
* **下一步**：给某一场编译"这一场要用的资料"，再写正文。

### 6）写正文（逐场）

```bash
pnpm harness context my-first-story --scene scene-003    # 看看这一场会看到什么资料
pnpm harness write my-first-story                       # 按顺序写完全部场景
pnpm harness drafts show my-first-story                 # 查看每场长度/格式
```

* **这条命令做什么**：`context` 为某一场景整理它**允许知道**的信息（打印一份清单，并写进报告文件）；
  `write` 按场景逐个写出正文，存成 `drafts/scene-001.md` 这样的文件。
* **你会看到什么**（真实输出片段）：

  ```text
  scene_id=scene-003 pov=CH_WOMAN blueprint_version=1
  characters（内心可见性由 inner_state_pov_visible 物理决定）：
    CH_WOMAN  内心=可见  hints=OBH_WOMAN_01
    CH_MAN  内心=不可见  hints=OBH_MAN_01
  allowed_reveals: K001
  draft_context: scene-002 末尾 168 个非空白码点
  ```
* **你有哪些选择**：只想重写一场就加 `--scene`；只想预览不写盘就加 `--plan`。
* **不选会怎样**：正文不满意是常态——先别急，看第 7 节的"Linter + 局部改写"，或者直接手改
  `drafts/scene-003.md`（它是普通文本文件，你可以随便编辑）。

### 7）Linter 检查 + 局部改写（可选）

```bash
pnpm harness lint my-first-story                        # 规则检查（确定性 / 统计型）
pnpm harness lint my-first-story --scene scene-004 --llm # 语义检查（需要模型）
pnpm harness lint show my-first-story                   # 看报告
pnpm harness rewrite my-first-story --scene scene-004 --warning LINT_001   # 只改这一处
```

* **这条命令做什么**：找出读起来"像 AI 写的"地方——模板化的动作、句子长度太均匀、
  对话比例失衡、段落结尾爱升华、把潜台词直接说出来等。`rewrite` **只改问题所在的那一小段**，
  不重写整篇。
* **你会看到什么**（真实输出）：

  ```text
  scene-004  linter=llm  warnings: high 1 / medium 1（low 仅日志）
    [high/expanded] LINT_001 subtext_exposed 95-114
        把人物的条件与潜台词直接说出来，读者不再需要推断
  ```
  ```text
  scene-004  LINT_001  span 95-114
    原文：她想，只要他把那句话说出来，她就留下来
    替换：她想，只要他先开口，她就留在这里
    结果：已原地改写 drafts/scene-004.md
    局部二次检查：span 所在段落 + 相邻段落 → 范围 18-144，当前 warning 2 条
  ```
* **你有哪些选择**：逐条决定改不改；也可以完全不管——**Linter 只是提示，不会阻拦交付**。
* **下一步**：终稿确认。

### 8）Gate 3：终稿确认

```bash
pnpm harness gate3 my-first-story --confirm
pnpm harness final show my-first-story
```

* **这条命令做什么**：把五场正文按顺序拼成一篇 `drafts/final.md`，
  **一次性确认整篇**（没有"逐场确认"这回事），并自动记录正文里真正发生了什么事
  （例如"某个关键信息在第三场被知道了"）。
* **你会看到什么**：

  ```text
  Gate 3：5 场已确认（confirmed_scenes 一次性写入）
  final.md：818 字（818 码点）→ …/drafts/final.md
  OCCURRED：1 条
    OCC_K_K001_scene-003  knowledge_reveal  scene=scene-003
  未处理的状态冲突：0 条（需用户裁决：改正文或改 Blueprint）
  ```
* **不选会怎样**：不加 `--confirm` 会被拒绝（这是故意的，避免误确认）。
  想先看看不落盘，用 `--plan`。
* **结束**：`drafts/final.md` 就是你的成品，可以直接复制走。
* **注意**：如果你在 Gate 3 之后又改了任何一场正文（手改或 `rewrite`），
  `final.md` 就旧了——**再跑一次 `gate3 --confirm`** 重新拼一次即可。

---

## 5. 命令速查表

所有命令（`pnpm harness help` 能列出的都在这里）：

| 命令 | 作用 | 何时用 |
|---|---|---|
| `harness init <项目名>` | 创建项目（可带 `--title` / `--seed` / `--seed-file` / `--target-length`） | 一开始 |
| `harness seed set <项目名> --text "…"` | 保存或覆盖故事想法（`--file` 从文件读） | 创建后 / 想改想法时 |
| `harness seed show <项目名>` | 看故事想法与系统对它的分类 | 任何时候 |
| `harness config show <项目名>` | 看项目配置（目标篇幅、Linter 开关等） | 想改配置前 |
| `harness gate1 <项目名> --plan\|--accept-all\|--skip\|--op …` | **Gate 1**：确认"它读懂你了吗" | 输入想法之后 |
| `harness develop <项目名>` | 生成 2～3 个故事方案（重新跑会覆盖原方案；`--style` 可给风格偏好，`--plan` 只预览） | Gate 1 之后 |
| `harness proposals show <项目名>` | 看方案摘要与"保留你原意的比例" | 选方案前 |
| `harness gate2 <项目名> --from/--field/--edit/--resolve` | **Gate 2**：选 / 合并 / 手改 / 裁决冲突 → 蓝图（加 `--plan` 只预览） | 选方案时 |
| `harness blueprint show <项目名>` | 看当前蓝图摘要 | Gate 2 之后 |
| `harness breakdown <项目名>` | 拆场景（`--rerun` 重跑，`--note` 加导演说明） | 蓝图确认后 |
| `harness scenes show <项目名>` | 看场景列表 | 拆完之后 |
| `harness state show <项目名>` | 看故事运行状态（自动维护） | 想确认"故事里现在知道什么" |
| `harness coverage show <项目名>` | 看大纲覆盖检查结果 | 拆完之后 |
| `harness context <项目名> --scene scene-003` | 为某场编译"该场能用的资料"并打印清单（`--all` 逐场） | 写正文前 |
| `harness style add <项目名> --text "…" --pov CH_X --scene-type dialogue --tone tension` | 加一条你自己的文风样本 | 想让文字更像你时 |
| `harness style show <项目名>` | 看已有的文风样本 | 写作前 |
| `harness write <项目名>` | 逐场写正文（`--scene` 只写一场，`--plan` 只预览） | 拆完之后 |
| `harness drafts show <项目名>` | 看每场正文长度与格式检查 | 写完之后 |
| `harness lint <项目名>` | 规则检查 AI 味（`--scene` / `--plan` / `--json`） | 正文写完后 |
| `harness lint <项目名> --scene scene-004 --llm` | 语义检查（需要模型） | 想更深一层检查时 |
| `harness lint show <项目名>` | 看最近的检查报告 | 检查后 |
| `harness rewrite <项目名> --scene scene-004 --warning LINT_001` | 只改问题所在的那一小段（`--full` 改完跑完整检查） | 有不想留的 warning 时 |
| `harness gate3 <项目名> --confirm` | **Gate 3**：拼终稿 + 整篇确认 + 记录事实（`--plan` 只预览） | 正文满意后 |
| `harness final show <项目名>` | 看 `drafts/final.md` 摘要与开头结尾 | 最终检查 |
| `harness eval story-development` | 生成"故事开发"评估表（CSV） | 想横向比较多个项目时 |
| `harness eval author-cost` | 生成"作者成本"表（CSV） | 想统计自己花了多少次确认时 |
| `harness eval ab-generate` | 生成 A/B 对照集与人工评分模板 | 想比较"它写的"和"直接问模型写的" |
| `harness eval ab-report --session session-001` | 看 A/B 的长度归一化摘要 | 有了 A/B 文稿之后 |
| `harness help` | 显示全部帮助（**加 `--help` 的效果一样**） | 忘命令时 |

**通用选项**：`--projects-root <目录>` 可以把项目放到别处（默认 `projects/`）；
`--provider recorded|openai-compat|auto` 控制"用离线录制还是真的调模型"。

---

## 6. 目录结构说明

以 `projects/demo-01/` 为例（你的项目结构完全一样）：

```text
projects/demo-01/
  seed.yaml              # 你的故事想法 + 系统对它的分类。想改想法用 seed set，一般不手改
  project-config.yaml    # 目标篇幅、Linter 规则开关。想调长度/关规则可以手改
  proposals.yaml         # 2～3 个故事方案。只读；要换方案请重跑 develop
  blueprint.yaml         # 你最终选定的"剧本大纲"。想改内容请走 gate2（手改容易破坏引用）
  story_state.yaml       # 故事运行状态：哪些场已确认、谁知道了什么。自动维护，不要手改
  scenes/                # 拆出来的场景（scene-001.yaml…）。想调某场可手改，改动前先备份
  drafts/                # 正文：scene-001.md…（普通文本，随你改）与 final.md（终稿）
  reports/               # 检查报告：coverage / context-manifest / linter。只读参考
  history/               # 蓝图的版本快照（每次 Gate 2 一份）
  blueprint-history/     # Gate 2 的元数据：每个字段来自哪里、你的手改与冲突裁决记录
  style/                 # 你的文风样本：profile.yaml + samples/
```

**你需要手改的，基本上只有 `drafts/*.md`。** 其他文件是给系统读的：
手改 `seed.yaml` / `story_state.yaml` / `blueprint.yaml` 很容易让后续步骤对不上，
想改这些内容请用对应的命令。

---

## 7. 常见问题

**Q1：生成的内容不满意怎么办？**
分三种情况处理。只是某几句不好 → 直接编辑 `drafts/scene-003.md`；觉得"AI 味"重 → 跑 `lint` 然后用 `rewrite` 逐条改；
觉得整个故事方向不对 → 回到 `gate2` 重新选/重新合并（甚至重跑 `develop` 生成新方案）。
不用担心弄坏什么：每一步都能重跑，蓝图每次确认都会留快照。

**Q2：能不能跳过某个 Gate？**
Gate 1 可以完全跳过（`--skip`），跳过不影响后面；Gate 2 和 Gate 3 必须做一次确认——
它们是你"选择方案"和"确认终稿"的地方，跳过就等于系统替你拍板，这是它刻意不做的。
想先看不写盘，两个 Gate 都可以加 `--plan` 预览。

**Q3：能不能手动改 Blueprint？**
能，但**建议通过命令改**：`gate2 --field 字段=来源` 或 `gate2 --edit 字段=内容`。
直接编辑 `blueprint.yaml` 也能跑，但里面很多字段互相引用（人物、场景位置、关键信息），
手改容易让"场景拆分"和"覆盖检查"报错。如果非要手改，改完跑一次 `coverage show` 看看有没有新 warning。

**Q4：怎么加自己的文风样本？**
用 `style add`，一次贴一小段**你自己写的**文字（3～5 句就够），并标注它属于哪个视角、哪种场景类型、
什么气氛。写正文时系统会按"视角 + 场景类型 + 气氛"去找最接近的样本，找不到就降级，不影响写作。
样本可以勾选"已去实体化"——就是把里面的人名地名换成占位符，避免系统把你样本里的具体人名搬到故事里。

**Q5：Linter 报的问题必须改吗？**
不必。它只是提示，**永远不会拦着你交付**。它分三档：`high` 默认展开给你看，`medium` 折叠，
`low` 只写进日志。写作者通常只处理 `high`，`medium` 视情况，`low` 可以忽略。
另外，检查结果不完美是正常的——同一段文字，模型每次判断都可能略有不同。

**Q6：改写后还能回滚吗？**
`rewrite` 是**原地覆盖**你的 `drafts/scene-003.md`，**不自动备份**。
所以：改写前如果你想留底，先自己复制一份（例如 `cp drafts/scene-003.md drafts/scene-003.old.md`），
或者把整个项目目录复制一份当作版本。改写记录会留在 warning 里（改了哪一段、改成了什么），
能看到"改了什么"，但不能一键还原。

**Q7：生成过程中断了怎么办？**
直接重新跑那条命令就行。它是"文件优先"的：每一步都把结果写进项目目录，已经完成的步骤不会丢。
但要注意**重新跑同一步会重新生成那一步的内容**（例如 `write` 会重写全部场景，可能再次调用模型），
所以想省钱省时间时，用 `--scene scene-003` 只补那一场，或者已经满意的步骤就别再跑。

**Q8：怎么把多个项目分开管理？**
默认每个故事一个目录（`projects/故事名/`），互不干扰，你可以同时开好几个。
也可以把项目放到别处（例如按年份分文件夹）：
`pnpm harness init 故事名 --projects-root ~/我的小说/2026`，之后每条命令都带上同样的 `--projects-root`。

---

## 8. 一个完整的示例会话

分两部分：**A 部分现在就能照抄跑通**（不花钱、不需要 key），
**B 部分**告诉你换成自己的故事要改哪里。

### A. 先跟着跑一遍：仓库自带的演示项目（离线，约 1 分钟）

先把它复制到临时目录，这样不会碰坏仓库里的演示数据：

```bash
mkdir -p /tmp/my-writing && cp -r projects/demo-01 /tmp/my-writing/demo-01
alias harness="pnpm harness"     # 可选；下面命令都以 pnpm harness 为准
```

**① 看看这个故事的想法和现状**

```bash
$ pnpm harness seed show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/seed.yaml
schema_version: 0.1
gate1_status:   skipped
anchors:        6
fixed/ambiguous/open_questions: 6/1/2
--- raw_input（原样） ---
一对情侣其实都深爱对方，因为一件小事争吵，女方提出分手。女方想的是只要男方认错她就愿意留下，
男方想的是为什么每次都要小题大做。两个人都在等对方先开口。
--- end raw_input ---
```

**② 看两个方案和"保留原意的比例"**

```bash
$ pnpm harness proposals show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/proposals.yaml
schema_version: 0.1
proposals: 2
PROP_A  两个人都在等  SPR=100% (6/6)  conflicts=0
PROP_B  谁先开口  SPR=83.3% (5/6)  conflicts=1
```

**③ 看已确认的蓝图（= 剧本大纲）**

```bash
$ pnpm harness blueprint show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/blueprint.yaml
schema_version: 0.1
blueprint_version: 1
title: 两个人都在等（现代情感）
pov: CH_WOMAN
target_length: 9000
premise: 两个都深爱对方的人，在同一个晚上各自等对方先开口
core_conflict: 谁先开口，谁就先承认自己更在乎这段关系
structure: BP_STR_BEG / BP_STR_DEV / BP_STR_TURN / BP_STR_CLIMAX / BP_STR_END
key_knowledge: K001@BP_STR_TURN#1
foreshadowing: BP_FS_001(BP_STR_BEG→BP_STR_END)
seed_fidelity: preserved 6 / altered 0 / added 1 / risk 1
```

**④ 看场景与覆盖检查**

```bash
$ pnpm harness scenes show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/scenes（5 个 Scene）
scene-001  order=1  dialogue  pov=CH_WOMAN  BP_STR_BEG  1500字  allowed_reveals=-
scene-002  order=2  interior  pov=CH_WOMAN  BP_STR_DEV  1600字  allowed_reveals=-
scene-003  order=3  dialogue  pov=CH_WOMAN  BP_STR_TURN  1800字  allowed_reveals=K001
scene-004  order=4  interior  pov=CH_WOMAN  BP_STR_CLIMAX  1600字  allowed_reveals=-
scene-005  order=5  transition  pov=CH_WOMAN  BP_STR_END  1200字  allowed_reveals=-

$ pnpm harness coverage show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/reports/coverage.yaml
schema_version: 0.1
blueprint_version: 1
summary: scenes=5 structure=5/5 arc=3/3 reveals=1/1 refs=29 length=7700
（无 warning）
```

**⑤ 看"第三场能用的资料"（这一场要揭示关键信息）**

```bash
$ pnpm harness context demo-01 --scene scene-003 --projects-root /tmp/my-writing
scene_id=scene-003 pov=CH_WOMAN blueprint_version=1
scene_type=dialogue narrative_role_ref=BP_STR_TURN
characters（内心可见性由 inner_state_pov_visible 物理决定）：
  CH_WOMAN  内心=可见  hints=OBH_WOMAN_01
  CH_MAN  内心=不可见  hints=OBH_MAN_01
allowed_reveals: K001
已知 K（开场）：K001
style_samples: SAMPLE_002[pov+scene_type+tone]
draft_context: scene-002 末尾 168 个非空白码点
included_sensitive: 2 条  excluded_sensitive: 2 条
future_content_exposed=false unconfirmed_proposal_exposed=false
已写入 Manifest：…/reports/context-manifest.yaml（scene_id=scene-003）
```

**⑥ 看已生成的正文与检查结果**

```bash
$ pnpm harness drafts show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/drafts（5 个已知正文）
scene-001.md  160 个非空白码点  段落 5  格式问题 0
scene-002.md  168 个非空白码点  段落 4  格式问题 0
scene-003.md  157 个非空白码点  段落 5  格式问题 0
scene-004.md  140 个非空白码点  段落 4  格式问题 0
scene-005.md  153 个非空白码点  段落 3  格式问题 0

$ pnpm harness lint demo-01 --projects-root /tmp/my-writing
scene-001  linter=rule  warnings: high 0 / medium 0（low 仅日志）
scene-004  linter=rule  warnings: high 0 / medium 1（low 仅日志）
  [medium/collapsed] LINT_001 sentence_length_variance 0-146
      句长变异系数 0.27 低于阈值 0.3（句子节奏过于均匀，共 7 句）
…
已检查 5 场（失败 0 场）；报告保留最后一场：…/reports/linter.yaml
```

**⑦ 只看一处改写（先看原文，再决定）**

```bash
$ pnpm harness rewrite demo-01 --scene scene-004 --warning LINT_001 --projects-root /tmp/my-writing
scene-004  LINT_001  span 95-114
  原文：她想，只要他把那句话说出来，她就留下来
  替换：她想，只要他先开口，她就留在这里
  结果：已原地改写 drafts/scene-004.md
  局部二次检查：span 所在段落 + 相邻段落 → 范围 18-144，当前 warning 2 条
```

**⑧ 终稿确认，并看成品**

```bash
$ pnpm harness gate3 demo-01 --confirm --projects-root /tmp/my-writing
Gate 3：5 场已确认（confirmed_scenes 一次性写入）
final.md：818 字（818 码点）→ /tmp/my-writing/demo-01/drafts/final.md
OCCURRED：1 条
  OCC_K_K001_scene-003  knowledge_reveal  scene=scene-003
未处理的状态冲突：0 条（需用户裁决：改正文或改 Blueprint）

$ pnpm harness final show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/drafts/final.md
码点：819  段落：21
格式检查：通过（无标题 / 无元数据 / 无分隔符）
--- 开头 ---
汤是下午就开始炖的，到端上桌的时候已经不烫了。
她把碗推到他面前，说了一句什么，他没听清，问了一遍，她就重复了一遍，声音比第一次短了一半。
--- 结尾 ---
…
草稿箱里那半句话还在，没有被发出去，也没有被删掉。
```

**⑨ 看故事"现在知道什么"（Gate 3 自动记录的结果）**

```bash
$ pnpm harness state show demo-01 --projects-root /tmp/my-writing
# /tmp/my-writing/demo-01/story_state.yaml
confirmed_scenes: scene-001, scene-002, scene-003, scene-004, scene-005
occurred: 1 条
knowledge_state: K001(reveal=true, scene=scene-003)
relationship_state: REL_WOMAN_MAN=together / REL_MAN_WOMAN=together
foreshadowing_state: BP_FS_001(scene-001→scene-005:paid_off)
state_rebuild_conflicts: 0 条（未处理 0 条）
```

到这一步，你已经完整走过一遍：**想法 → 方案 → 蓝图 → 场景 → 正文 → 检查 → 改写 → 终稿**。

### B. 换成你自己的故事

```bash
$ pnpm harness init my-first-story --title "我知道" --seed "一个男人每天给去世的妻子发微信，某天突然收到回复。"
已创建项目：…/projects/my-first-story
  seed.yaml            schema_version=0.1 gate1_status=pending

$ pnpm harness gate1 my-first-story --plan
provider=recorded model=recorded-seed-interpreter-v0.1 contract=seed_interpreter@0.1
fixed_by_user（用户明确说的）：6 条
  - SEED_F001  男人的妻子已经去世    原文：「去世的妻子」
  - SEED_F002  男人每天给妻子发微信    原文：「每天给去世的妻子发微信」
  …
ambiguous（模糊的）：2 条
  - SEED_A001  回复究竟是谁发的    （无原文片段）
open_questions（未决定的）：2 条
  - SEED_Q001  回复的来源真相何时揭晓    （无原文片段）

$ pnpm harness gate1 my-first-story --skip
Gate 1 已应用：
  - 跳过 Gate 1（gate1_status=skipped）
  - raw_seed_anchor_ids 未改变：[SEED_F001, … SEED_F006]（需求规格 §8.2）

$ pnpm harness develop my-first-story
PROP_A  定时消息（现代悬疑）
  核心冲突：男人想继续相信这是妻子，又必须面对这是程序的事实
  真相/转折：那三个字出自妻子生前写好的一串定时消息…
  Seed Preservation Rate：100%（6/6）
PROP_B  替她说话的人（现代悬疑）
  核心冲突：妹妹想让姐夫好过一点，却把他困在一个永远不会结束的等待里
  真相/转折："我知道"是妹妹回的…
  Seed Preservation Rate：83.3%（5/6）
  [CONFLICT_PENDING] PROP_B 的 CONF_001 与用户已明确内容冲突…等待 Gate 2 裁决
已写入：…/proposals.yaml
```

**从这里开始，如果你想用自己的想法生成新内容，就要配上模型**（第 2 节的三个环境变量），
并在命令后加 `--provider openai-compat`：

```bash
export HARNESS_LLM_BASE_URL="https://api.deepseek.com/v1"
export HARNESS_LLM_API_KEY="sk-…"
export HARNESS_LLM_MODEL="deepseek-chat"

pnpm harness gate1 my-first-story --provider openai-compat --plan
pnpm harness develop my-first-story --provider openai-compat
pnpm harness gate2 my-first-story --provider openai-compat --from PROP_A
pnpm harness breakdown my-first-story --provider openai-compat
pnpm harness write my-first-story --provider openai-compat
pnpm harness lint my-first-story --provider openai-compat --llm
pnpm harness gate3 my-first-story --provider openai-compat --confirm
```

**为什么必须换模型**：仓库里的"离线录制"是给演示项目用的固定答案。
如果你的想法不在里面，它会明确告诉你"没有录制"，而不是编一个答案给你（真实报错）：

```text
错误：RecordedProvider 未命中：contract=scene_breakdown contract_version=0.1
可用 fixture 数：5
补齐方式：在 fixture 文件中新增一条记录，写入上面的 input_sha256，然后运行 `pnpm fixtures:refresh` 复核。
```

（最后那两行是给开发者看的，写作者可以直接忽略——你只需要加 `--provider openai-compat`。）

---

## 9. 已知限制（说清楚，免得你踩坑）

1. **只支持短篇**：目标篇幅 1,000～30,000 字。写成中长篇它会力不从心。
2. **只支持线性时间**：场景按顺序发生，不支持倒叙/闪回/多时间线。
3. **只支持单视角或双视角**：不能写群像（所有人的内心都自由切换）。
4. **文风样本要自己准备**：它不会自动学习你的文风，你得手动贴几段自己写的文字。
5. **模型的判断不稳定**：语义检查（`--llm`）报出的位置（`span`）每次可能略有不同，
   改写建议也只是建议；别把它当"必须修的错题"。
6. **离线模式下不能生成新内容**：仓库自带的离线录制只覆盖演示项目。
   你自己的故事从 Gate 2 起需要配 key（见第 2 节），否则会看到"未命中"的报错。
7. **演示项目是压缩样本**：仓库里两个演示项目每场只有 110～200 字，
   目的是让你几秒钟跑完一遍流程，**不代表它的写作水平**；你的项目会按你设定的篇幅生成。
8. **正文长度不会严格等于目标**：它会按场景目标长度生成，但实测偏短（演示项目约 150 字/场）。
   想要更长，请调大 `--target-length` 与场景目标，或在生成后自己扩写。
9. **改写不自动备份、不能一键回滚**：动手前先自己复制一份文件。
10. **不要手改 `story_state.yaml` / `blueprint.yaml` / `seed.yaml`**：手改容易让后续步骤对不上；
    想改内容请用对应命令（`seed set` / `gate2` / `breakdown --rerun`）。

---

## 10. 遇到问题找谁

* **反馈入口**：这个仓库目前**没有配置远程地址**，所以没有公开的 issue 页面。
  请把问题反馈给**把这份工具交给你的人**（或你拿到仓库的那个渠道）。
  如果你自己把它放到了 GitHub / Gitee，就在那个仓库里直接开 issue。
* **反馈时请附上这些信息**（能让对方一次就定位）：
  1. 你跑的那条完整命令（含所有参数）；
  2. 完整的报错文本（它通常已经写明了"哪一步、缺什么"）；
  3. 你的项目目录里这几个文件：`seed.yaml`、`project-config.yaml`，
     以及 `reports/` 下的报告（正文内容如果不想公开可以删掉）；
  4. 你的环境：`node -v`、`pnpm -v`、操作系统版本。
* **常见的"不是故障"**：
  * 看到 `RecordedProvider 未命中` → 你在用离线模式跑新故事，加 `--provider openai-compat` 即可；
  * `gate3` 报"需要显式确认" → 这是故意的，加上 `--confirm`；
  * `gate2` 报"存在未裁决的冲突" → 用 `--resolve` 处理掉那条冲突再确认。
