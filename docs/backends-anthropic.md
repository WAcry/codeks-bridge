# Claude Messages

模型选择 `catalog: "claude-opus-5-5"` 或 `"claude-sonnet-5-5"`，条目指定 `claude-messages` adapter，请求转换为 `POST <base_url>/messages`。官方端点的 `base_url` 为 `https://api.anthropic.com/v1`；默认使用 `x-api-key` 和 `anthropic-version: 2023-06-01`，可通过连接配置覆盖。

## 历史与 thinking

开头的 `instructions`、system 和 developer 消息组成顶层 `system`。会话中途的 system/developer 消息留在原位置，转换成 user 文本中的 `<system-reminder>`。新指令不会搬到会话顶部，因此已有前缀稳定；这保留时间顺序，但不具有原生 system 角色的优先级。

相邻同角色消息合并；reasoning、文本和工具调用成为 assistant 内容块，工具输出成为下一条 user 消息中的 `tool_result`。原历史不变。

默认 effort 为 `medium`，普通映射提供 `low`、`medium`、`high`、`xhigh`、`max` 并保留同名值，使用 adaptive thinking 并写入 `output_config.effort`。codeks 的 `ultra` 注入多代理提示词，并将 Opus 5.5 的原生 effort 设为 `xhigh`、Sonnet 5.5 设为 `max`。

Opus 5.5 始终启用 thinking；Sonnet 5.5 的最低模式是 `between_tools`，关闭回复前的思考，但仍在工具之间返回带签名的进度说明。两者都拒绝 `thinking.type: "disabled"`，因此目录不把 `none` 作为可选档位，也不把关闭思考的请求静默改成 `low`。Sonnet 的 `between_tools` 只接受 `high` 或以下 effort，且 `thinking` 对象中不能附带 `display`、`budget_tokens` 等字段。[官方 thinking 规则](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Sonnet 5.5 变更说明](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5)

`reasoning.summary` 缺省或为 `none` 时选择 `display: "omitted"`；`auto`、`concise`、`detailed` 选择 `summarized`，不保证上游区分摘要长度。目录默认值与 GPT-6.1 Sol 一样为 `none`；要显示摘要，在 codeks 配置中设置 `model_reasoning_summary = "auto"`。显示开关不关闭 thinking 或载荷回放。

`reasoning.effort_map` 可以替换映射，`options.thinking` 和 `options.output_config` 可以覆盖完整原生对象。例如以下 Sonnet 模型条目固定使用 `between_tools` 与 `low` effort；options 优先于客户端请求中推导的模式、effort 和 display，无需新增转换接口：

```json
{
  "catalog": "claude-sonnet-5-5",
  "upstream": "anthropic",
  "model": "claude-sonnet-5-5",
  "options": {
    "thinking": { "type": "between_tools" },
    "output_config": { "effort": "low" }
  }
}
```

未映射的显式 effort 仍交给上游判断；客户端显式请求 `none` 时，adapter 仍发送 `thinking.type: "disabled"`，由上游返回错误。目录精调不构成运行时能力预检。

Opus / Sonnet 5.5 目录的默认及最大上下文窗口为 `1000000`，Messages API 要求提供 `max_tokens`，因此目录设置默认输出预算 `128000`，对应官方标准最大输出。输出预算依次取请求 `max_output_tokens`、模型配置、目录默认值，再接受上游和模型 options 的覆盖；这是允许的上限，不要求每次生成同样长度。[模型规格](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、[配置优先级](config.md)

完整 `thinking`/`redacted_thinking` block，包括签名或隐藏数据，存入 `anthropic.thinking.v1` carrier。请求按 `replay.reasoning_from` 恢复允许来源，签名完整保留；其他来源只在当前请求过滤。允许配对不意味着上游一定接受其签名。[Reasoning 策略](reasoning.md)

## 输出格式、工具与图片

Responses `text.format: {type: "json_schema", schema: ...}` 转为 `output_config.format: {type: "json_schema", schema: ...}`；name/strict 不转发。schema 内容直接交给上游，随后 options 仍可覆盖原生格式。普通 `text` 不添加约束；无法表达为 Messages 的未知格式报错。

namespace 和 custom tool 使用共享映射。自由文本工具转换成 `{input: string}`，Lark/regex 放入描述，返回时恢复原始字符串；不添加工具专属提示词。指定工具必须能在当前工具表中解析，`tool_choice: "required"` 转为原生 `any`，不会改成 `auto`。显式 `temperature`、`top_p` 也继续发送；这些参数与具体模型、thinking 的组合是否受支持由上游判断。静默删除参数或关闭 thinking 会改变用户请求，bridge 不做这类修正。

有工具且未选择 `none` 时，显式 `parallel_tool_calls: false` 转为 `tool_choice.disable_parallel_tool_use: true`，显式 `true` 则转为 `false`；未指定 choice 时采用 `auto`，原生 options 仍可覆盖。这保留 Codex Lite 的外层工具调用限制，不限制一次 `exec` 内 JavaScript 的并发执行。[Claude 并行工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)

用户与工具结果都可带图片。HTTP(S) URL 和 JPEG、PNG、GIF、WebP 的 base64 data URL 转为原生 image block，bridge 不下载图片。图片能力、尺寸和 schema 限制交给上游，不能转换的内容类型明确报错。空工具结果仍发送 `tool_result` 及原调用 ID，只省略空的 `content` 数组，不添加占位文字。

工具参数分片先拼接、解析，在对应 `content_block_stop` 按原顺序交给 writer 缓存，完整 `message_stop` 后才交付客户端。工具之后的 thinking 和文字一起缓冲，保留签名所依赖的块顺序。`tool_use`、`pause_turn` 返回 `end_turn: false`；输出截断或 refusal 返回失败，不交付部分工具调用。`model_context_window_exceeded` 转为 `context_length_exceeded`，同样不交付工具调用；后续是否压缩或重试由 codeks 决定。

## 缓存与压缩

最多四个显式缓存断点：最后一个工具、最后一段顶层 system、最近两条 user 消息的末块。普通请求 TTL 为 `1h`。压缩保留公共前缀的 `1h`，只将最后的摘要请求末块设为 `5m`，使长 TTL 位于短 TTL 之前。thinking 块不直接设置缓存断点。

压缩只生成文字摘要，保留工具定义及普通请求的工具选择，移除 `output_config.format`，其他参数保留。摘要封装为客户端 V2 compaction item，可供其他模型恢复。保留工具选择的缓存依据及意外工具调用的处理见 [压缩](compaction.md#工具选择与缓存)。

## Usage 与错误

input 为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，output 使用最终累计值，不累加流事件；可得的 thinking 用量记录到 reasoning 分项。缺失或无效的计数返回错误，不伪造零值。

HTTP 与流内错误经共享层分类，同时保留上游原始错误体；未完整结束的流返回错误。bridge 不改参数重试，容量与限流退避由 codeks 决定。[错误结构](responses-stream.md)

实现与测试：[`src/backends/anthropic.ts`](https://github.com/WAcry/codeks-bridge/blob/main/src/backends/anthropic.ts)、[`test/anthropic.test.ts`](https://github.com/WAcry/codeks-bridge/blob/main/test/anthropic.test.ts)。协议参考：[thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)、[缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。
