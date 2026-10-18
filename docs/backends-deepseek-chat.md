# DeepSeek Chat

模型设置 `catalog: "deepseek-flash"`，条目指定 `deepseek-chat` adapter，请求发送到 `<base_url>/chat/completions`。这个 adapter 明确使用 DeepSeek 方言：`reasoning_content`、thinking 参数和对应 usage。实际模型可以是 `deepseek-flash` 或第三方部署名称，bridge 不按名字猜测规则。

```json
{
  "upstreams": {
    "deepseek": {
      "base_url": "https://api.deepseek.com",
      "api_key_env": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "flash": {
      "upstream": "deepseek",
      "catalog": "deepseek-flash",
      "model": "deepseek-flash"
    }
  }
}
```

目录的默认及最大上下文窗口为 `1000000`。输出预算使用上游默认值；请求中的 `max_output_tokens` 或模型配置可指定预算，请求值优先，并转为 `max_tokens`；原生 options 仍可覆盖。上游的输出预算包含 thinking 与可见输出；达到上限返回失败，不执行不完整工具调用。`base_url` 可包含 `/v1` 等前缀。[官方参数范围](https://api-docs.deepseek.com/api/create-chat-completion/)

## Reasoning 与参数

思考从 `delta.reasoning_content` 读取，作为 `reasoning.text.v1` 的字符串 data 保存。下次请求把允许来源的文本恢复到 assistant 的 `reasoning_content`。`reasoning.summary` 为 `auto`、`concise` 或 `detailed` 时，将原生 reasoning 文本作为可见摘要输出；缺省或 `none` 时不展示，但仍保存和回放载荷，不关闭 thinking。目录沿用 GPT-6.1 Sol 的摘要默认值 `none`；可在 codeks 中设置 `model_reasoning_summary = "auto"`。是否同模型、是否同上游都由来源策略决定，不能只凭文本格式推断应该共享。[复用配置](reasoning.md)

没有可恢复 reasoning 的 assistant 历史使用 `reasoning_content: ""`，不编造思考。它使带有其他目标历史的工具循环仍具备 DeepSeek 要求的字段。

默认 effort 为 `high`，默认映射如下：

| 客户端 effort | 原生参数 |
| --- | --- |
| `none` | `thinking.type: "disabled"` |
| `minimal`、`low` | `thinking.type: "enabled"`，`reasoning_effort: "low"` |
| `medium`、`high`、`xhigh` | `thinking.type: "enabled"`，`reasoning_effort: "high"` |
| `max`、`ultra` | `thinking.type: "enabled"`，`reasoning_effort: "max"` |

codeks 的 `ultra` 由客户端注入多代理提示词，并使用原生 `max` effort。映射可由 `reasoning.effort_map` 整体替换，目录中可选档位来自同一配置。未映射的显式 effort 原样发送。上游和模型 `options` 随后覆盖推导参数，允许直接设置端点专有选项；桥接器最终固定 model、messages、工具定义、流模式和 usage 开关。

强制工具选择、JSON Schema 与 thinking 能否组合由上游判断。bridge 转换可表达的请求后直接发送，上游不支持时保留错误，不自动关闭 thinking 或改成普通文本输出。

## 消息、工具与图片

Responses instructions 成为开头的 system 消息；历史 developer 在原位置转为 system。user、assistant、工具调用和结果保留顺序。同一次 assistant 输出的 reasoning、文字和并行工具调用合并为一条 Chat assistant 消息。

工具结果使用 `role: "tool"` 和原 `tool_call_id`。namespace、自由文本工具及语法使用[共享工具转换](tools.md)。Responses JSON Schema 转为 Chat `response_format.json_schema`，JSON object 转为 `response_format: {type: "json_object"}`；schema 由上游验证。

用户图片转为 `image_url`，支持 HTTP(S) 和 image data URL，`detail: "original"` 转为 `high`。工具结果文本保持 tool 消息，图片放在同组所有 tool 结果之后的 user 消息，标注来源 call ID；这样不打断并行调用与结果的配对。这会增加一个 user 边界，是转换的代价。

assistant/system/developer 图片、文件 ID、音频和视频没有本轮转换路径，明确报错。图片的实际识别能力和尺寸限制交给模型端点。

## 流、用量与压缩

出站开启 `stream: true`、`stream_options.include_usage: true`。文字和启用展示的 reasoning 随到随发，工具参数按索引拼接，只有流结束且所有调用完整时才交给 codeks。未结束的连接、缺失 usage、未知工具或不完整参数不能构成成功响应。

`stop` 完成，`tool_calls` 要求继续执行工具。`length` 和内容过滤返回错误；DeepSeek 的 `insufficient_system_resource`、`aborted` 归为容量错误。HTTP 与流内错误保留原始上游详情，bridge 不叠加重试。[错误结构](responses-stream.md)

| DeepSeek 用量 | Responses 用量 |
| --- | --- |
| `prompt_tokens` | `input_tokens` |
| `completion_tokens` | `output_tokens` |
| `prompt_cache_hit_tokens`，或 `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
| `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |

reasoning 不重复加到总量中。压缩只生成文字摘要，仍由客户端远程 V2 通道接收；保留工具定义并固定 `tool_choice: none`，不能保证上游继续缓存所有工具上下文。

## 扩展方言

[`src/backends/chat.ts`](https://github.com/WAcry/codeks-bridge/blob/main/src/backends/chat.ts) 负责 Chat 消息、工具和流转换，定义小型 `ChatDialect` 接口；[`src/backends/deepseek.ts`](https://github.com/WAcry/codeks-bridge/blob/main/src/backends/deepseek.ts) 提供 DeepSeek 的 reasoning 字段、thinking 参数、usage 和特殊结束原因。`deepseek-flash` 目录条目选择 `deepseek-chat` adapter，由后者调用前者。

当前 Chat 转换层按单个文本字段读写 reasoning，包括为没有 reasoning 的 assistant 历史写入空字符串。这是现有 DeepSeek 路径需要的行为；接入其他模型时须按其协议决定能否复用。参数差异优先使用 profile 和 options；如果 reasoning 改为内容块或其他结构，再调整转换边界。当前没有其他 Chat 方言实现。

验证见 [`test/chat.test.ts`](https://github.com/WAcry/codeks-bridge/blob/main/test/chat.test.ts)。协议参考：[Chat API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)、[图片](https://api-docs.deepseek.com/zh-cn/guides/vision)。
