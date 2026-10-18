# 压缩与跨模型恢复

压缩不是普通 reasoning：检查点可能是早期对话的唯一剩余表示。每个 bridge 检查点始终保存文字摘要，可选保存上游原生压缩。模型如何生成新检查点、如何恢复已有检查点分别配置。

## 配置

| 配置 | 含义 | 默认 |
| --- | --- | --- |
| `compaction.mode: "dual"` | 并行生成原生压缩和文字摘要，都成功才交付 | GPT Responses |
| `compaction.mode: "summary"` | 只生成文字摘要 | Claude / DeepSeek |
| `compaction.native_replay` | 恢复时是否使用允许来源的原生表示 | GPT 为 true，其他为 false |
| `replay.native_compaction_from` | 除自身外，允许的原生来源模型别名 | 空列表 |

例如 GPT 目标可以设 `mode: "summary"`、`native_replay: true`：它自己只生成文字摘要，但仍可读取允许来源的原生检查点。另一目标可以支持双压缩，却通过 `native_replay: false` 始终使用文字表示。Claude/DeepSeek adapter 没有原生压缩格式，只使用文字摘要。

允许来源是定向、非传递的关系，与 reasoning 的列表互不影响。bridge 只检查格式能否还原，兼容配对由配置明确选择。原生压缩生成失败或原生检查点被拒绝都按上游错误返回，不自动改成文字压缩重试。

## 客户端契约

codeks 的远程压缩 V2 仍调用 `POST /responses`，输入末项为 `{"type":"compaction_trigger"}`，保留 instructions、tools 和完整历史。bridge 等待所有必需请求成功后，在 `response.completed` 前交付恰好一个 `compaction` item。

```toml
[model_providers.bridge.capabilities]
remote_compaction = "v2"
```

两种生成模式都使用这条路径，客户端继续执行远程 V2 的历史保留规则。bridge 不自行裁剪或重复拼装近期消息，也不提供独立的 `/responses/compact` 接口。

已核对的 codeks `0.162.1` 行为是成功后保留最多约 64,000 tokens 的近期用户消息及其他符合规则的消息，再附检查点；本地 prompt 压缩路径约为 20,000 tokens。这些预算属于客户端，升级时应复核 `codex-rs/core/src/compact_remote_v2_attempt.rs`、`compact_remote_v2.rs` 和 `codex-rs/protocol/src/models.rs`。

## 生成

文字摘要请求将 trigger 换成共享的 checkpoint prompt，保留原 instructions、历史和工具定义，设置 `tool_choice: "none"`，移除结构化输出格式。提示词和恢复前缀集中在 [`src/prompts.ts`](../src/prompts.ts)，许可归属见 `NOTICE`。

`dual` 额外并行发送一条保留 trigger 的原生请求。两个请求从相同原历史出发，互不消费对方输出。原生请求移除普通回答的输出预算，交由上游管理；文字摘要仍使用普通回答预算。

共享输入前缀可能命中已有 prompt cache，但并行请求不保证互相建立缓存；双压缩是两次推理，usage 为两条请求实际用量之和，延迟与费用由上游决定。Claude 摘要保留工具及公共前缀的 `1h` 缓存，只将最后的摘要请求末块设为 `5m`。

协调层在内存中收集结果，完成前只发送 keepalive。原生结果须恰好包含一个非空压缩项，文字摘要须非空且完整结束。任一请求失败时取消另一条并保留原错误。客户端断开也取消两条请求；已经发生的上游用量仍可能计费。bridge 不保存半成功结果，客户端重试会重新执行整次压缩。

## 保存格式

`compaction` item 的 `encrypted_content` 是：

```text
cxbc2:<base64url(JSON)>
```

双压缩解码后的结构：

```json
{
  "summary": "可供任何模型读取的文字摘要",
  "native": {
    "source": {
      "id": "source-fingerprint",
      "connection": "connection-fingerprint",
      "model": "deployment-name",
      "adapter": "gpt-responses"
    },
    "format": "responses.compaction.v1",
    "data": {
      "type": "compaction",
      "encrypted_content": "original-encrypted-content"
    }
  }
}
```

仅摘要模式省略 `native`。原生 data 保留完整上游 item；来源指纹计算见 [reasoning](reasoning.md)。载荷随 codeks 会话保存，bridge 无需数据库。外层是编码，不是加密；文字摘要可读，原生密文保持原样。

## 恢复

每次请求按当前目标选表示：

1. 有原生状态、开启 `native_replay`、来源允许、格式匹配：还原原生 item。
2. 其他情况：将恢复前缀和文字摘要作为 user message。

这发生在发送前；第一种请求被上游拒绝时直接返回错误，不自动再发第二种。两份来源列表是策略，不是声称真实密文兼容的证明。

恢复不修改历史。切换模型再切回来，仍可使用检查点中的原生结果；修改允许来源后，也可使用先前保存的原生结果。如果又压缩一次，新检查点取代旧检查点，只保存这一次生成的表示，不累积每个模型的检查点版本。

外部原生检查点若没有 bridge 文字摘要，不能保证跨目标恢复，因此明确报错。文字摘要不是密文的可逆解码，其质量取决于摘要模型；协议测试不等于摘要质量评测。

## 用量与估算

近期保留消息可能与摘要包含相同信息，这是客户端历史策略的一部分。bridge 不把整个压缩前历史藏进载荷。

客户端在压缩后可能按 `encrypted_content` 长度粗估 token，双表示会让估算偏保守；下一次正常响应的 usage 提供实际用量。bridge 不伪造 usage 或修改客户端公式。

实现见 [`src/compaction.ts`](../src/compaction.ts)、[`src/carrier.ts`](../src/carrier.ts)、[`src/history.ts`](../src/history.ts)。
