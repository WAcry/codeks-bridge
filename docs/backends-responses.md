# GPT Responses

模型选择 GPT 目录 key，例如 `catalog: "gpt-6.1-sol"`，条目指定 `gpt-responses` adapter，bridge 向连接的 `/responses` 发请求。`base_url` 包含版本前缀，例如 `https://api.openai.com/v1`。实际模型名可以是任意部署别名，转换不依赖名称前缀。

## 请求与参数

普通 Responses 参数、namespace 和 custom grammar 工具保留原始格式。模型名替换为配置的实际名称，reasoning effort 使用 profile 默认值和配置映射。`max_output_tokens` 优先使用请求值，再使用模型默认值。

客户端默认发送 Responses Lite：工具声明保留在 `input[].additional_tools` 的原位置，不提升到顶层 `tools`。保留 `reasoning.context: "all_turns"` 和 `parallel_tool_calls: false`，并向所有 GPT 上游发送 Lite header。入口从客户端 header 或 `additional_tools` 识别 Lite；只有 header、没有工具的请求也能保持标记。后端不通过模型名称或云厂商猜测协议。

随后浅层合并上游和模型 `options`，后者覆盖前者，也可覆盖推导出的普通参数。最后由 bridge 固定 `model`、`input`、`tools`、`store: false`、`stream: true`，`include` 至少包含 `reasoning.encrypted_content`。上游状态由完整历史承载，不依赖服务器保存的会话。

历史 reasoning 按允许来源选择，将 `responses.reasoning.v1` 的 data 还原为原生密文；原生压缩按独立策略选择。每条输入项移除顶层 `id`，工具配对的 `call_id` 保留，避免引用已过滤的 reasoning。图片、普通消息、工具结果和明文 agent message 保留原格式。[状态规则](reasoning.md)

## 流与工具交付

桥接器消费 SSE，也接受完整 JSON response。文本和 reasoning summary 随到随发；reasoning 完成时附带载荷。后端不直接关闭客户端响应，服务层统一写 `response.completed` 和 usage。

工具调用仅在上游 `response.completed` 后交给 writer，并在完整成功时释放。function call 保留 namespace，custom tool 保留原始输入。失败、截断和连接中断不会让客户端执行未完成的工具调用。

`end_turn` 有显式值时遵从上游，否则有工具调用时返回 false。input/output usage 必须是有效计数，cache/reasoning 分项有则记录；reasoning 不重复叠加到 input。无效 usage 作为错误返回，避免影响 codeks 压缩判断。

HTTP 和流内错误保留原始上游内容，并映射为客户端可识别的分类。被允许的密文遭拒也直接返回，不自动过滤后重试。[错误结构](responses-stream.md)

## 原生压缩

`compaction.mode: "dual"` 默认向 `/responses` 发送保留 `compaction_trigger` 的请求，并行生成文字摘要。原生结果交给压缩协调层，两条都成功才生成 carrier。若端点只适合文字压缩，显式设置 `mode: "summary"`。

原生请求移除普通回答的 `max_output_tokens`，包括配置和 options 中的值，由上游管理压缩输出预算。摘要仍使用普通预算，固定 `tool_choice: "none"` 并移除结构化输出格式。

是否生成原生压缩与是否恢复原生检查点独立。配置 `native_replay` 和 `native_compaction_from` 后，格式可读且来源允许的原生状态优先发送；上游拒绝即报错。[压缩配置](compaction.md)

实现与测试：[`src/backends/responses.ts`](../src/backends/responses.ts)、[`test/responses.test.ts`](../test/responses.test.ts)。
