# Anthropic Messages 转换

`api: "anthropic"` 把 Responses 请求转换为 `POST <base_url>/messages`。`base_url` 包含版本前缀，例如 `https://api.anthropic.com/v1`。默认发送 `x-api-key` 和 `anthropic-version: 2023-06-01`；兼容端点可用通用鉴权配置覆盖。

## 历史与思考

开头的 `instructions`、system 和 developer 消息组成顶层 `system`。会话中途的 system/developer 消息保留原位置，转换成 user 文本中的 `<system-reminder>`。这保留内容和时间顺序，但不具备原生 system 角色的优先级。当前 Messages 的中途 system 角色有位置限制，不能直接承接任意 Responses 历史；把新指令搬到顶部又会改变已有 reasoning 的签名前缀。因此这里选择固定、可回放的通用转换。[官方位置规则](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)

相邻的同角色消息合并，reasoning、文本和工具调用成为同一 assistant 消息的内容块。工具输出成为下一条 user 消息中的 `tool_result`。原始历史不会被修改。

默认使用 `thinking: {type: "adaptive", display: "summarized"}`。`reasoning.summary: "none"` 改用 `display: "omitted"`；两种情况都保留签名。effort 原样转发，只有 `minimal`/`none` 映射为 `low`。上游或模型的 `options` 可显式覆盖 `thinking`、`output_config`，以接入需要手动 budget 的旧模型。输出上限优先级为：请求 `max_output_tokens`、模型 `max_output_tokens`、模型 `options.max_tokens`、上游 `options.max_tokens`、默认 16384。不同模型接受的 effort、强制工具选择和 thinking 模式不完全一致，配置必须符合所选模型。[官方 thinking 文档](https://platform.claude.com/docs/en/build-with-claude/thinking)

`thinking` 的文本与签名、`redacted_thinking` 的数据整体放入 bridge reasoning carrier。再次请求时只恢复当前端点与模型的 carrier，其余模型的 reasoning 过滤规则见 [reasoning.md](reasoning.md)。不伪造签名，也不把可见摘要当成可回放的完整思考。

## 输出格式

Responses 的 `text.format: {type: "json_schema", schema: ...}` 转换为 Messages 的 `output_config.format: {type: "json_schema", schema: ...}`，保留其他 output_config 设置。schema 原样传递，Responses 的 name/strict 字段不转发；不支持的 schema 约束由上游明确报错。`type: "text"` 使用普通文本并清除配置中的格式限制；`json_object` 和其他未知格式明确拒绝。压缩始终移除格式限制。实际模型与端点还需支持此能力。[官方结构化输出协议](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

## 工具与图片

namespace、普通函数和 custom 工具使用共享名称映射。指定 `tool_choice` 的工具必须存在且种类匹配，否则请求在 bridge 内失败。custom 工具输入转换成 `{input: string}`，Lark/regex 约束进入描述，返回时恢复原始字符串；没有工具专属的额外提示词。

图片支持 HTTP(S) URL 和 JPEG、PNG、GIF、WebP 的 base64 data URL。图片可以出现在 user 消息或 `tool_result.content` 中。bridge 不下载 URL 图片，实际获取和校验由上游负责。不支持的内容类型会明确失败，不静默丢弃。

工具 JSON 分片先拼接、解析，直到完整 `message_stop` 才交给 Responses writer；流中断时不发出待执行工具。`tool_use`、`pause_turn` 返回 `end_turn: false`，让客户端继续。max_tokens 截断或 refusal 作为失败返回，避免把不完整调用当成成功。[流协议](https://platform.claude.com/docs/en/build-with-claude/streaming)

## 缓存、压缩与 usage

最多设置四个显式缓存断点：最后一个工具、最后一段顶层 system、最近两条 user 消息的末块。正常请求 TTL 都是 `1h`。压缩时保留公共前缀的 `1h`，仅把最后的摘要请求末块设为 `5m`；因此长 TTL 始终在短 TTL 前面，且不直接缓存 thinking 块。短于上游最低长度的请求即使设置断点也可能没有缓存命中。[缓存规则](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

压缩沿用原工具定义，强制设置 `tool_choice: none`，并移除 `output_config.format`，避免常规任务的结构化输出约束限制摘要。其他 output_config 选项保留。这保留已有 reasoning 的相关上下文；转换后的摘要作为可跨模型使用的 compaction carrier 保存，详见 [compaction.md](compaction.md)。

输入 usage 是 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，避免把缓存部分误当成不占上下文。输出 usage 使用最终累计值，不把每个增量事件相加；如果提供 `thinking_tokens`，同步记录到 reasoning usage。`message_start` 必须包含输入和输出计数，`message_delta` 必须包含累计输出计数；计数必须是非负有限整数。缺失或无效的 usage 作为上游错误返回，不伪造零用量。可选缓存计数缺省为零。

HTTP 错误经过统一分类。流内 overload 映射到 `server_is_overloaded`，限流映射到 `rate_limit_exceeded`，上下文过长映射到 `context_length_exceeded`。未完成的流是可重试的上游错误；重试由客户端控制。

## 验证

`test/anthropic.test.ts` 用合成签名和本地 HTTP 服务验证请求转换、工具 JSON 分片、图片、reasoning 回放、缓存断点、usage、结束状态和流中断。真实端点验证结果记录在 [testing.md](testing.md)；真实凭据、地址和响应样本放在仓库外。
