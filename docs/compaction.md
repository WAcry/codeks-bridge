# 压缩与跨模型恢复

bridge 接收 codeks 的远程压缩 V2 请求。对于 OpenAI Responses 上游，同时生成原生压缩结果与可读摘要；对于 Anthropic Messages 和 Chat Completions 上游，生成可读摘要。两条路径都返回一个 `compaction` item，因此 codeks 继续使用远程 V2 的历史保留规则。

## 客户端契约

以下行为按 codeks 所基于的 Codex `rust-v0.162.1` 源码确认：

- 压缩仍然调用 `POST /responses`，输入的最后一项为 `{"type":"compaction_trigger"}`，保留当前 instructions、tools、历史消息、工具结果和 reasoning。
- 客户端等待完整的 `response.completed`，并要求恰好收到一个 `compaction` 类型的 `response.output_item.done`。bridge 只在所有必需的上游请求成功后发出这个 item。
- 成功后，客户端保留最多约 64,000 tokens 的近期用户消息，以及符合客户端规则的其他消息，再附上 compaction item。这个预算由客户端执行，bridge 不裁剪或重复拼装保留历史。图片保留还受客户端 feature 与预算控制。
- 本地 prompt 压缩路径的用户消息预算约为 20,000 tokens。本项目通过 V2 协议让非原生压缩也使用前一条规则。

配置时显式声明：

```toml
[model_providers.bridge.capabilities]
remote_compaction = "v2"
```

这里没有独立的 `/responses/compact` 端点。对于 Responses 上游，必须支持上述 V2 trigger；原生请求失败时不会静默降级为只保留文本摘要。

源码入口：Codex 的 `codex-rs/core/src/compact_remote_v2_attempt.rs`、`compact_remote_v2.rs` 与 `codex-rs/protocol/src/models.rs`。升级客户端时应重新检查 trigger、输出类型和历史保留规则。

## 双表示如何生成

Responses 上游并行接收两条请求，二者都从原始历史出发：

1. 原生请求保留 `compaction_trigger`，取得服务端的加密压缩 item。
2. 摘要请求把 trigger 换成完整的交接摘要提示词；保留原 instructions、历史和工具定义，设置 `tool_choice: "none"`，移除原会话的结构化输出格式，取得文本摘要。

摘要提示词集中在 [`src/prompts.ts`](../src/prompts.ts)，要求按对话顺序梳理用户意图、技术决策、相关文件与代码、错误修复、待办和当前工作，并原样保留用户提出的安全约束。它明确区分真实 user 消息与 assistant 引用的“用户话语”，避免把模型生成的内容记成用户授权。输出为 `<analysis>` 和 `<summary>` 两个文本块，完整文本一并保存在 checkpoint 中。GPT 双压缩的文字摘要、Anthropic Messages 和 Chat Completions 的单次摘要共用这份提示词。

恢复前缀仍逐字取自 Codex `rust-v0.162.1` 的 `codex-rs/prompts/templates/compact/summary_prefix.md`，许可证归属见 `NOTICE`。更详细的交接内容可能增加摘要长度与输出用量；输出被上游截断时，仍按失败处理，不替换原历史。

两条请求共享很长的输入前缀，可能利用上游已有的 prompt cache；是否命中由上游决定，并行请求也不保证互相建立缓存。这是两次实际推理，可能增加延迟和费用。返回的 usage 是两条请求的实际用量之和，包含 cache read、cache write 与 reasoning 用量中可得的部分。

Anthropic Messages 和 Chat Completions 只执行摘要请求。Anthropic 的普通请求使用一小时缓存策略，压缩请求的消息断点使用五分钟策略；保留工具定义是为了维护历史中签名 thinking 所需的前缀。

## 成功、失败和取消

`compact()` 在内存里收集上游结果，调用方在完成之前只能发 keepalive，不会收到半成品 checkpoint。

- Responses 的原生结果必须包含且仅包含一个非空 compaction item。
- 文本摘要必须非空；工具调用、拒绝、未完成的响应都算失败。
- 任一请求失败，就取消另一个请求并保留原错误，包括可用的 Retry-After。客户端仍持有完整的旧历史，可以按其重试策略重新发起压缩。
- 客户端断开或取消时，两条请求一起取消。上游已经完成的部分仍可能计费。
- 重试会重新执行整次压缩；bridge 不维护半成功缓存或后台重试任务。

这样避免成功的加密结果丢失文本备份，也避免文本成功时丢失必须保留的原生压缩能力。

## 保存和恢复

返回的 `encrypted_content` 是带版本的 bridge carrier：

```text
cxbc1:<base64url encoded JSON>
```

它包含文本摘要，以及可选的原生 `{key, item}`。完整状态随 codeks 的会话历史持久化，因此 bridge 重启不依赖额外数据库。这个外层 carrier 是编码，**不是加密**；其中的摘要是可读文本，原生 item 的密文仍保持原样。会话文件应按包含原始任务内容的文件对待。

恢复时按实际目标选择：

| 目标 | 发送的内容 |
| --- | --- |
| 同一实际模型、API 与端点 | 还原该 checkpoint 内保存的原生压缩 item |
| 不同模型、API 或端点，包括用不同配置表示的区域 | 用 user message 发送 Codex 恢复前缀和文本摘要 |
| 非 Responses checkpoint | 始终使用文本摘要 |

模型的显示别名不参与隔离；实际目标 identity 由路由配置确定。如果区域或 provider 的变化藏在同一个上游 URL 后面，bridge 无法自动发现，应该为不可互通的目标配置不同端点。即使某些上游能跨模型解释密文，本项目也不据此放宽隔离。

恢复是每次请求的视图转换，不会修改保存在 codeks 中的 carrier。切到另一个模型后，再切回原目标，仍可以恢复这个 checkpoint 保存的原生结果。如果在另一个目标又做了一次压缩，则新的 checkpoint 取代旧 checkpoint；它保存新目标的原生结果和新的文本摘要，不累积各模型的历史压缩版本。

## 预算与边界

保留的近期用户消息和摘要可能包含相同信息，这是客户端 V2 历史策略的一部分。bridge 既不再保留整个压缩前的历史，也不把它藏进 carrier。

codeks 在刚压缩后会按 `encrypted_content` 的长度粗略估算 token。carrier 同时包含两种表示，估算可能偏保守；下一次正常请求拿到真实 usage 后，会使用上游报告的上下文用量。这里没有伪造 usage 或改客户端估算公式。

原生加密结果的质量来自支持 V2 的上游；文本摘要的质量来自当前模型。文本摘要不是原生压缩的可逆解码，跨模型恢复依赖摘要保留了足够的任务信息。测试验证协议、持久化与切换行为，不把它们等同于摘要质量评测。

相关实现：[`src/compaction.ts`](../src/compaction.ts)、[`src/carrier.ts`](../src/carrier.ts)、[`src/history.ts`](../src/history.ts)。失败与取消测试见 [`test/compaction.test.ts`](../test/compaction.test.ts)。
