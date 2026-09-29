# Prompt Contract：Plain Prompt（评估对照用）v0.1

- contract id: `plain_prompt`
- contract version: `0.1`
- 用途：**仅用于 Story 10 的 Anti-AI A/B 对照**（需求规格 §31.2）。
  它是"普通一次性 Prompt"的复现：把 Scene Intent 直接丢给模型，不经过
  Context Compiler / POV Filter / Style Samples。

> 本契约不参与创作流程，也不产生任何状态。

## 输入

### Scene Intent

```yaml
{{scene_intent}}
```

## 要求

请根据上面的场景设定写一段小说正文（约 300 字）。

## 现在请直接输出正文
