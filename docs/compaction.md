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
2. 摘要请求把 trigger 换成 Codex 自带的 checkpoint summary prompt；保留原 instructions、历史和工具定义，设置 `tool_choice: "none"`，移除原会话的结构化输出格式，取得文本摘要。

摘要提示词和恢复前缀逐字取自 Codex `rust-v0.162.1` 的 `codex-rs/prompts/templates/compact/`，集中在 [`src/prompts.ts`](../src/prompts.ts)，许可证归属见 `NOTICE`。没有附加项目专用的摘要要求。

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
| GPT Responses，checkpoint 包含原生结果 | 优先还原原生 item，包括切换模型、provider 或区域后的请求 |
| 原生密文被当前目标明确拒绝 | 用已有的文本摘要替换 checkpoint，重新请求一次 |
| Anthropic Messages、Chat Completions，或 checkpoint 只有文本 | 用 user message 发送 Codex 恢复前缀和文本摘要 |

原生压缩与 reasoning 的策略不同：GPT 模型之间优先共享压缩结果；reasoning 始终按模型和连接身份隔离。密文能否复用取决于实际上游，不能仅凭模型名字、provider 或区域推断。

恢复是每次请求的视图转换，不会修改保存在 codeks 中的 carrier。一次降级后，原生结果仍可供后续请求重试。如果又做了一次压缩，则新的 checkpoint 取代旧 checkpoint；它保存当前目标的原生结果和新的文本摘要，不累积各模型的历史压缩版本。

## 拒绝后何时重新尝试

自动降级仅用于请求中确实包含原生 checkpoint，并收到明确的密文校验拒绝：HTTP 400 或对应的流内输入错误，例如 `invalid_encrypted_content`、无法校验或解密的 encrypted content、无效的 encrypted summary。也识别兼容网关嵌在错误消息中的原始错误码。普通 400、限流、容量不足、网络错误和断流继续交给客户端处理。已经产生正文、reasoning 或其他输出时，不在同一响应里重新生成。

降级直接使用 checkpoint 已有的摘要，不额外调用模型做摘要，也不删除匹配的 reasoning。如果同一连接背后的区域变化还使 reasoning 本身失效，替换 compaction 仍可能失败，此时返回错误；没有第二次降级。只有摘要请求完整成功后，才保存一条临时记录，避免每次工具回环都先触发同样的拒绝。

记录由以下三部分共同确定：

1. codeks 请求中的 `client_metadata.thread_id` 与 `turn_id`。
2. 当前实际模型和连接身份，以及可能影响路由的静态 headers、上游 options、模型 options。显示别名不参与。
3. 本次输入中原生 checkpoint 密文的有序集合；忽略 item ID。

同一 turn、同一目标、同一组 checkpoint 的后续请求直接用摘要。新 turn、切换目标或生成新 checkpoint 都重新尝试原生结果；同一 turn 内 A → B → A 时，A 可继续使用先前成功降级的记录。客户端确实可能在同一 turn 内切换模型，因此不能仅按 turn 标记。

这只是每个服务实例内最多 256 条的 FIFO 哈希记录，不持久化密文、header 或历史，不维护永久兼容性表。服务重启或记录被逐出后会重新尝试。缺少完整 thread/turn 标识时，只在当前请求内记录，不根据 `session-id` 或缓存 key 猜测 turn。隐藏在同一连接后面的临时路由变化最迟在下个 turn 重新探测。

再次压缩时，两条并行请求都可能携带旧 checkpoint。每条请求可独立完成一次拒绝后的降级；已经发出的并行请求不等待彼此。旧 checkpoint 的恢复由后端先处理，仍失败才触发双压缩协调层的取消。**生成新的 GPT checkpoint 仍要求原生压缩与文本摘要都成功**，不能因为旧密文不兼容而只发布新摘要。

## 预算与边界

保留的近期用户消息和摘要可能包含相同信息，这是客户端 V2 历史策略的一部分。bridge 既不再保留整个压缩前的历史，也不把它藏进 carrier。

codeks 在刚压缩后会按 `encrypted_content` 的长度粗略估算 token。carrier 同时包含两种表示，估算可能偏保守；下一次正常请求拿到真实 usage 后，会使用上游报告的上下文用量。这里没有伪造 usage 或改客户端估算公式。

原生加密结果的质量来自支持 V2 的上游；文本摘要的质量来自当前模型。文本摘要不是原生压缩的可逆解码，跨模型恢复依赖摘要保留了足够的任务信息。测试验证协议、持久化与切换行为，不把它们等同于摘要质量评测。

相关实现：[`src/compaction.ts`](../src/compaction.ts)、[`src/carrier.ts`](../src/carrier.ts)、[`src/history.ts`](../src/history.ts)、[`src/compaction-replay.ts`](../src/compaction-replay.ts)。失败与取消测试见 [`test/compaction.test.ts`](../test/compaction.test.ts)；拒绝、降级与 turn 隔离见 [`test/compaction-replay-http.test.ts`](../test/compaction-replay-http.test.ts)。
