# Chat Completions 与 DeepSeek

`api: "chat"` 使用经典 `/chat/completions` 端点。本轮实际验证的模型是 DeepSeek 官方的 `deepseek-flash`。其他 OpenAI 兼容服务可以配置，但兼容性取决于它们是否实现下述字段和流式事件；不能仅凭接口名称保证兼容。

```json
{
  "upstreams": {
    "deepseek": {
      "api": "chat",
      "base_url": "https://api.deepseek.com",
      "api_key_env": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "flash": {
      "upstream": "deepseek",
      "model": "deepseek-flash",
      "context_window": 1048576,
      "max_output_tokens": 16384
    }
  }
}
```

`base_url` 可以包含 `/v1` 等路径前缀，bridge 在其后追加 `/chat/completions`。`max_output_tokens` 转成 Chat 的 `max_tokens`，限制同时包含思考和可见输出。大任务需要给思考留足空间；达到上限时 bridge 报错，不执行可能只有一半的工具调用。

## 消息和工具

Responses 的 `instructions` 成为最前面的 system 消息。历史中的 developer 消息在原位置转换成 system 消息，保留执行过程中更新的指令。user 消息、assistant 文本、工具调用和结果保留原来的顺序。

同一次 assistant 输出的 reasoning、可见文本和并行工具调用合并到一条 Chat assistant 消息。工具结果是对应的 `role: "tool"` 消息，`tool_call_id` 与调用匹配。工具名通过共享工具映射恢复 namespace；custom 工具使用 `{ "input": "..." }` 形式的普通 function，语法放进说明。详见 [工具转换](tools.md)。

Chat 不提供 Responses 托管的 web search、image generation 等工具。这些定义不会传给 Chat；显式用 `tool_choice` 选择不支持的工具会报错。`auto`、`none`、`required` 和指定 function/custom 工具可以转换，但上游本身仍可能有限制。

DeepSeek 思考模式只支持 `auto` 与 `none`。要求强制调用工具时，调用方须明确设 `reasoning.effort: "none"`，bridge 不会为满足工具选择而暗中关闭思考。压缩使用 `tool_choice: "none"`。

## Reasoning 与模型切换

默认从 Chat 流的 `delta.reasoning_content` 读取纯文本思考，并把它保存在带来源标识的 reasoning carrier 中。下次请求同一个实际模型和端点时，恢复到 assistant 的 `reasoning_content`。切到别的模型或端点时，只过滤当前请求里的思考，原历史仍保留；切回来就能恢复。carrier 是编码，不是加密。

DeepSeek 带工具的思考模式要求回传历史 reasoning；只依赖它有时能通过原生 tool call ID 恢复思考不可靠。其他模型生成的 assistant 历史没有可兼容的思考，bridge 发送 `reasoning_content: ""`，不复制其他模型的内容，也不编造思考。真实测试验证了非原生调用 ID 加空字段可继续工具循环；省略该字段则可能返回 400。

其他 Chat 服务如果使用同级纯文本字段，例如 `reasoning`，可以设置：

```json
{ "options": { "reasoning_field": "reasoning" } }
```

该选项同时控制读取和重放，且不会作为请求参数发送给上游。数组式 reasoning、嵌套对象、不同字段分别读写等格式本轮不支持；遇到非文本思考会明确报错。普通 `options` 项作为 Chat 请求参数；bridge 生成的 model、messages、stream、工具等协议字段优先。

DeepSeek 的 effort 映射遵循其当前文档：

| 请求 effort | DeepSeek 行为 |
| --- | --- |
| `none` | `thinking.type: "disabled"` |
| `minimal`、`low` | 开启思考，`reasoning_effort: "low"` |
| `medium`、`high`、`xhigh` | 开启思考，`reasoning_effort: "high"` |
| `max`、`ultra` | 开启思考，`reasoning_effort: "max"` |

未指定 effort 时保留配置里的参数和上游默认值。其他模型的 effort 原样发送，不套用 DeepSeek 的映射。

## 图片

user 消息里的 `input_image` 转成 Chat 的 `image_url` 内容块，支持 HTTP(S) 图片地址和 `data:image/...;base64,...`。`detail: "original"` 转成 Chat 的 `high`；其他 detail 原样传递。

为了兼容只允许 user 消息带图片的 Chat 服务，工具结果中的文本仍放在 tool 消息，图片移到紧跟在这一组 tool 结果之后的 user 消息，并标明来源 `call_id`。即使有并行调用，也先完成所有 tool 结果，再发图片；不会在调用和结果之间插入 user 消息。这会增加一个 user 边界，是协议转换的取舍。

assistant 图片、system/developer 图片、上传文件 ID、音频和视频本轮不支持，并会明确报错。图片是否可读、可用格式和尺寸上限由上游决定。测试验证了 `deepseek-flash` 可以识别 user 图片和转换后的工具图片。

## 流、结束与用量

请求始终开启流式输出和 `stream_options.include_usage`。文本与 reasoning 实时写入 Responses SSE，工具参数按索引拼接；只有流完整结束、所有工具调用都合法后，才把调用交给 codeks 执行。未结束的连接、无 usage、无 `finish_reason`、未知工具和无效参数都不能形成一次成功响应。

`stop` 表示完成；`tool_calls` 表示还需处理工具。`length` 和内容过滤返回明确错误。DeepSeek 的 `insufficient_system_resource`、`aborted` 转成可重试的 `server_is_overloaded`。HTTP 限流、容量、配额和鉴权错误由共享错误映射处理；bridge 不另加重试循环。

| Chat 用量 | Responses 用量 |
| --- | --- |
| `prompt_tokens` | `input_tokens` |
| `completion_tokens` | `output_tokens` |
| `prompt_cache_hit_tokens`，否则 `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
| `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |

总量直接取上游统计，不额外叠加历史 reasoning。缺少完整的 input/output 用量时失败，避免以零用量悄悄影响上下文压缩判断。

## 压缩与验证范围

Chat 通过 prompt 生成可移植摘要，作为 bridge 的 compaction carrier 返回，详见 [压缩](compaction.md)。DeepSeek 实测 `tool_choice: "none"` 会影响工具上下文和输入 token 数，即使请求保留工具定义，也不能保证这一部分缓存命中。压缩正确性不依赖缓存。

合成测试覆盖历史合并、来源过滤后切回、命名空间、自定义语法工具、并行工具结果与图片顺序、effort、流截断和失败保护。DeepSeek 官方端点的实测覆盖工具循环、异模型历史、图片和 custom 工具；真实请求、签名和完整响应不放进公开仓库。

接口依据：[Chat API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)、[图片](https://api-docs.deepseek.com/zh-cn/guides/vision)。这些规则可能随上游更新；变更时应同时更新转换和测试。
