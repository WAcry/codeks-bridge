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

## 失配策略与故障续接

默认 `adapters.claude-messages.thinking_mismatch: "drop_block"`，在 `adaptive`、`enabled` 模式的 `thinking.block_binding.prefix_mismatch_behavior` 中声明。服务端可以丢弃前缀失配的块，继续使用其余可接受的 thinking；bridge 不自行验签或删除已保存的载荷。可配置 `error` 或 `upstream_default`，原生 options 中明确的绑定策略仍优先，完整配置与优先级见 [Adapter 专用行为](config.md#adapter-专用行为)。

所有 Messages 请求都附带 `thinking-binding-controls-2026-08-01` beta，与现有 beta header 合并，以取得 `input_transformations` 诊断；声明诊断 beta 本身不等于选择某种失配策略。服务端报告与实际支持取决于端点，未知能力或请求错误直接返回，不自动更换策略。[官方 preserved thinking 规则](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)

流式响应可能已交付完整 thinking 或文字项，随后才过载或断流。codeks 保存这些已完成项并负责重试，因此重试历史可能以 assistant 结束。若最后的 assistant 不含 `tool_use`，bridge 在出站请求追加 user `Continue.`，提供合法续接边界；含工具调用时不补这一句，以免掩盖缺失工具结果。

若这个 assistant 后紧跟持久化的增量工具声明，同样在声明前补续接边界；后续回放时，声明的位置让 bridge 能重新构造相同边界，不需要另存隐藏会话状态。

对于没有增量工具声明锚定的尾部 `Continue.`，若本次响应的第一个原生内容块是 `thinking` 或 `redacted_thinking`，bridge 在该块的 `cxbr1:` 外层记录可选字段 `continuation_before`，值为实际补入的文本。原生 thinking、签名和隐藏数据保持不变；字段随原 reasoning item 的 `output_item.done` 进入 codeks 历史，不产生独立的控制项或用户消息。

以后恢复这块 reasoning 时，先在同一位置补回记录的 user 文本。假设失败前已保存 T1，重试的首块为 T2：

```text
重试请求：H → assistant[T1] → user[Continue.]
重试输出：T2{continuation_before: "Continue."} → 正文
下轮请求：H → assistant[T1] → user[Continue.] → assistant[T2, 正文] → user[新问题]
```

这样 T2 不会仅因续接边界消失而失配。同一响应只标记首块，后续 thinking、正文和工具继续保持原顺序；如果 T2 完整交付后又发生故障，这个边界已随 T2 保存，下一次重试可恢复它并记录新的续接边界。首块尚未完整交付时没有新载荷，下次仍按已有历史重试。字段跟随 reasoning 的来源与格式筛选：本次不恢复该载荷时，也不恢复其中的边界；以后允许恢复时，两者一起生效。

覆盖范围按实际输出顺序决定。Adaptive thinking 不保证第一个内容块就是 thinking；若先输出正文或工具，再输出 thinking，bridge 不给后来的块添加这个字段，否则会把 `Continue.` 恢复到错误的位置。这类响应及没有字段的既有历史仍沿用当前失配策略；没有 thinking 的响应则没有新签名需要通过这个字段保护。由增量工具声明锚定的边界不重复记录。[官方 thinking 规则](https://platform.claude.com/docs/en/build-with-claude/thinking)

用户选择保留正常 thinking、正文的流式显示，并用少量自包含状态恢复边界。因此只记录位置确定的首块，不缓存整轮正文，也不引入会话索引、独立控制载荷或向前查找历史位置的规则。工具调用仍按现有规则等完整成功后交付。`continuation_before` 记录已发生的请求事实，不改变来源复用配置，也不替代 `thinking_mismatch`。

工具定义等其他前缀变化仍可能导致失配，未覆盖的续接次序也可能丢失 thinking。默认 `drop_block` 让服务端报告并丢弃失配块；`error` 或 `upstream_default` 下，服务端仍可能拒绝请求。丢失推理上下文可能影响质量或增加重新推理成本，不能把边界恢复视为所有签名和输入均可接受的保证。具体发生了什么以[检查器中的服务端报告](inspect.md#claude-服务端输入处理)为准。

一次失配不会令今后生成的 thinking 永久失效。后续请求保持前缀稳定时，新生成的块仍可正常复用；原始历史里的旧失配块可能在多轮请求中被重复报告，重复报告不代表每轮都丢弃新的 thinking。实际保留与丢弃以各次上游报告为准。

## 输出格式、工具与图片

Responses `text.format: {type: "json_schema", schema: ...}` 转为 `output_config.format: {type: "json_schema", schema: ...}`；name/strict 不转发。schema 内容直接交给上游，随后 options 仍可覆盖原生格式。普通 `text` 不添加约束；无法表达为 Messages 的未知格式报错。

namespace 和 custom tool 使用共享映射。自由文本工具转换成 `{input: string}`，Lark/regex 放入描述，返回时恢复原始字符串；不添加工具专属提示词。指定工具必须能在当前工具表中解析，`tool_choice: "required"` 转为原生 `any`，不会改成 `auto`。显式 `temperature`、`top_p` 也继续发送；这些参数与具体模型、thinking 的组合是否受支持由上游判断。静默删除参数或关闭 thinking 会改变用户请求，bridge 不做这类修正。

工具更新默认使用完整 inline 定义，保持已有顶部工具与历史前缀稳定；仅实际包含中途工具更新的请求添加 `inline-tools-2026-09-15` beta。初始声明、更新位置与兼容模式见 [Lite 工具声明](tools.md#lite-工具声明)。端点不支持时可在连接配置中显式选择 `tool_updates: "top_level"`；不会在错误后自动探测或降级。

从 `0.0.1` 的顶部合并方式切到默认 inline 时，已有增量声明历史会改变出站工具前缀，可能触发旧 thinking 丢弃或缓存重建；可显式设为 `top_level` 保持原工具策略。切换模式不改变状态来源身份，也不改写客户端保存的历史。

有工具且未选择 `none` 时，显式 `parallel_tool_calls: false` 转为 `tool_choice.disable_parallel_tool_use: true`，显式 `true` 则转为 `false`；未指定 choice 时采用 `auto`，原生 options 仍可覆盖。这保留 Codex Lite 的外层工具调用限制，不限制一次 `exec` 内 JavaScript 的并发执行。[Claude 并行工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)

用户与工具结果都可带图片。HTTP(S) URL 和 JPEG、PNG、GIF、WebP 的 base64 data URL 转为原生 image block，bridge 不下载图片。图片能力、尺寸和 schema 限制交给上游，不能转换的内容类型明确报错。空工具结果仍发送 `tool_result` 及原调用 ID，只省略空的 `content` 数组，不添加占位文字。

工具参数分片先拼接、解析，在对应 `content_block_stop` 按原顺序交给 writer 缓存，完整 `message_stop` 后才交付客户端。工具之后的 thinking 和文字一起缓冲，保留签名所依赖的块顺序。`tool_use`、`pause_turn` 返回 `end_turn: false`；输出截断或 refusal 返回失败，不交付部分工具调用。`model_context_window_exceeded` 转为 `context_length_exceeded`，同样不交付工具调用；后续是否压缩或重试由 codeks 决定。

## 缓存与压缩

最多四个显式缓存断点：最后一个顶层工具、最后一段顶层 system、最近两条 user 消息的末块。普通请求 TTL 为 `1h`。压缩保留公共前缀的 `1h`，只将最后的摘要请求末块设为 `5m`，使长 TTL 位于短 TTL 之前。thinking 块不直接设置缓存断点。inline 模式不为新增定义重写顶部 tools；兼容模式修改顶部定义可能导致缓存未命中及 thinking 前缀失配，两者最终由上游判断。

压缩只生成文字摘要，保留工具定义及普通请求的工具选择，移除 `output_config.format`，其他参数保留。摘要封装为客户端 V2 compaction item，可供其他模型恢复。保留工具选择的缓存依据及意外工具调用的处理见 [压缩](compaction.md#工具选择与缓存)。

## Usage 与错误

input 为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，output 使用最终累计值，不累加流事件；可得的 thinking 用量记录到 reasoning 分项。缺失或无效的计数返回错误，不伪造零值。

HTTP 与流内错误经共享层分类，同时保留上游原始错误体；未完整结束的流返回错误。bridge 不改参数重试，容量与限流退避由 codeks 决定。[错误结构](responses-stream.md)

实现与测试：[`src/backends/anthropic.ts`](https://github.com/WAcry/codeks-bridge/blob/main/src/backends/anthropic.ts)、[`test/anthropic.test.ts`](https://github.com/WAcry/codeks-bridge/blob/main/test/anthropic.test.ts)。协议参考：[thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)、[缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。
