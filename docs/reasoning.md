# Reasoning 与状态复用

Reasoning 默认只恢复给产生它的目标，配置可以允许其他来源。是否允许复用和如何解码是两件事：来源策略由 `replay.reasoning_from` 决定，载荷的 `format` 告诉 adapter 如何还原内容。

## 显示与推理分开

目录的 `default_reasoning_summary`、客户端的 `model_reasoning_summary` 和请求的 `reasoning.summary` 控制可见摘要，不决定是否进行推理。Claude / DeepSeek 沿用 GPT-6.1 Sol 的摘要默认值 `none`；在 codeks 配置 `model_reasoning_summary = "auto"` 可打开显示，也可使用 `concise` 或 `detailed`。Codex `0.163.0` 在 `codex-rs/core/src/client.rs` 的 `build_reasoning` 中将有效配置 `none` 表达为省略请求的 summary 字段，因此这两个 adapter 对缺省和 `none` 都不输出可见摘要，仍保存完整原生载荷，并按来源策略回放。GPT 直接保留原生参数和上游摘要事件，由上游响应请求中的显示选择，不在桥接层再次改写摘要。

启用显示时，Claude 请求 summarized thinking，DeepSeek 展示上游 reasoning 文本，不另外调用模型生成摘要。`auto`、`concise` 和 `detailed` 在这两个 adapter 中都表示请求可见内容，不承诺复现 GPT 的摘要长度差异。隐藏摘要也不意味着丢弃签名、密文或明文 reasoning；这些数据仍由 carrier 持久化。

## 保存格式

Responses reasoning item 的 `encrypted_content` 保存：

```text
cxbr1:<base64url(JSON)>
```

JSON 的结构如下，示例指纹为占位值：

```json
{
  "source": {
    "id": "source-fingerprint",
    "connection": "connection-fingerprint",
    "model": "deployment-name",
    "adapter": "gpt-responses"
  },
  "format": "responses.reasoning.v1",
  "data": "original-encrypted-content"
}
```

| adapter | format | data |
| --- | --- | --- |
| `gpt-responses` | `responses.reasoning.v1` | 上游原始 `encrypted_content` 字符串 |
| `claude-messages` | `anthropic.thinking.v1` | 完整 `thinking` 或 `redacted_thinking` block，包含签名或隐藏数据 |
| `deepseek-chat` | `reasoning.text.v1` | 明文 reasoning 字符串 |

一个 carrier 对应一项 reasoning；格式可以保存字符串或结构化数据，不限于可见文字。外层只是编码，不是加密。GPT 密文本身不变；Claude 可见 thinking 和 DeepSeek 文本仍可解码。

Claude 的外层还可包含 `continuation_before: "Continue."`，记录生成该块前实际补入的 user 续接边界。它只用于响应首块为 thinking/redacted 的情况，原生 `data` 和签名不变，前缀仍为 `cxbr1:`。字段随载荷保存、筛选和恢复，不改变复用策略；具体时序与覆盖范围见 [Claude 故障续接](backends-anthropic.md#失配策略与故障续接)。

codeks 会再次发送 `encrypted_content`，因此载荷可以跨请求、会话恢复、服务重启和子代理 fork 保留。只放在 reasoning 的可见 `content` 中不足以完成这种回放。

## 来源身份

连接指纹是 `SHA256(JSON.stringify([upstream ID, 去除末尾斜杠的 base_url]))`。来源指纹再对 `[连接指纹, adapter, 实际模型]` 做同样的 SHA256。两个指纹用十六进制表示。

载荷保留实际模型名和 adapter，端点和凭据不进入历史。显示别名及 replay 配置不参与身份，所以改显示名称或允许范围不需要重写历史。若同一 URL 背后通过 header/凭据区分不兼容目标，应使用不同 upstream ID。

## 定向允许来源

例如在 B 的配置中设置：

```json
{ "replay": { "reasoning_from": ["a"] } }
```

B 可以接收自身及 A 的 reasoning；A 不会因此接收 B。A 接受 C 也不会让 B 自动接受 C。别名按连接、adapter 和实际部署解析为来源身份。

加载配置检查引用存在且源与目标的格式标识一致。两个 GPT 模型的 reasoning、同一 DeepSeek 模型的不同部署均可配置复用；每次请求恢复实际载荷，上游是否真正接受，交给实际请求验证。失败按上游错误返回，不删掉 reasoning 再发送。

`prepareHistory` 每次复制输入，恢复来源允许且格式匹配的 carrier，其他 reasoning 只在本次请求中过滤。普通消息、工具调用、结果和图片继续保留。没有来源包装的 reasoning 不归属到当前目标。

例如默认 A → B → A 时，B 不接收 A 的 reasoning，切回 A 后仍可恢复。若后来配置 B 接受 A，无需重写历史，后续请求即可使用其中 A 的载荷。被新的压缩检查点取代的旧历史则不再可恢复。

## 消息与工具历史

codeks 的明文 `agent_message` 在 GPT Responses 中保持原格式；Claude/DeepSeek 将其转成 user 消息，在内容开头标明 author、recipient，后面保留文本和图片。它不是 reasoning，不受 reasoning 来源列表控制。

GPT 出站请求移除 item 顶层 `id`，保留工具配对的 `call_id`，使用 `store: false`。这样消息不会继续通过服务器 item ID 引用已过滤的 reasoning。请求必须包含完整历史，不能只带 `item_reference` 或 `previous_response_id`。

压缩另用 `cxbc1:`，有独立的允许来源，保存文字摘要或按需复述配方。详见[压缩](compaction.md)。
