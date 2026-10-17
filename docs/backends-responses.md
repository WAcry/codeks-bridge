# OpenAI Responses 后端

`src/backends/responses.ts` 向配置端点的 `/responses` 发请求。`base_url` 包含版本前缀，例如 `https://api.openai.com/v1`。

## 请求

普通 Responses 参数、namespace 和 custom grammar 工具保留原始格式。路由将显示模型名替换为实际模型名；上游及模型的 `options` 可以补充或覆盖参数。

模型配置的 `max_output_tokens` 是默认值，请求中有显式值时优先使用请求值。生成通用压缩摘要时，工具选择固定为 `none`，并移除结构化输出格式，防止配置覆盖摘要的文本协议。

以下字段由桥接器控制：

- `input` 使用当前模型可接收的完整历史。
- `store: false`，不依赖上游保存会话。
- `stream: true`。
- `include` 至少包含 `reasoning.encrypted_content`。

每条输入项移除顶层 `id`，工具配对的 `call_id` 保留。当前路由的 reasoning carrier 解包为上游原生密文；其他路由的 reasoning 不发送。图片、普通消息和工具结果保留。完整身份选择规则见 [reasoning.md](reasoning.md)。

## 流与错误

桥接器消费 SSE，也兼容上游返回完整 JSON response。文本和 reasoning summary 随到随发；reasoning 完成时附带可重放的 carrier。后端不直接关闭客户端响应，服务层统一写 `response.completed` 和 usage。

工具调用仅在上游 `response.completed` 后交给响应 writer，并由 writer 在响应成功结束时释放。失败、截断和连接中断都不会让客户端执行未确认完成的工具调用。function call 保留 namespace；custom tool 保留原始输入。

上游 usage 中的 input、cached、output 和 reasoning tokens 直接映射到 Responses 结构。reasoning token 不再次加进 input。`end_turn` 有显式值时遵从上游；否则存在工具调用时返回 false。

input 和 output token 数必须存在且为非负安全整数；cached 和 reasoning 可省略，但出现时也必须满足同样条件。缺少或无效的 usage 返回可重试上游错误，不伪造为零，并且不会释放已缓存的工具调用。

HTTP 错误由共用请求层映射。流内 `response.failed` 保留错误码和重试提示；缺少完成事件的断流返回可重试错误。截断或 refusal 返回 `invalid_prompt`，避免把同一不可完成的请求反复执行。

原生 checkpoint 跨 GPT 模型与连接优先复用。如果上游明确拒绝其密文，而且尚未产生输出，后端以 checkpoint 内已有摘要替换原生 item，再请求一次。只替换压缩项，匹配的 reasoning 继续保留。成功后的短期记录避免同一 turn、目标与 checkpoint 的重复拒绝；新 turn 或目标会重新尝试。限流、服务错误和普通输入错误不触发此路径。详见 [压缩恢复](compaction.md#拒绝后何时重新尝试)。

## 原生压缩

带有尾项 `compaction_trigger` 的请求仍发送到 `/responses`，不改走独立的 compact 端点。原生输出 `compaction` item 直接交给压缩协调层。协调层等待原生压缩和通用摘要均成功后，再生成一个包含两者的 carrier；后端不会递归触发新的压缩。

原生压缩的输出预算由上游管理，不发送普通回答的 `max_output_tokens`，包括请求、默认值和 `options` 中的限制。部分上游对压缩有更高的最小输出预算，直接沿用回答限制会使合法压缩失败。通用文本摘要继续使用普通输出预算。

`test/responses.test.ts` 使用合成 SSE 和 JSON 响应验证正文流、reasoning、namespace 工具、grammar 工具、原生压缩、usage、失败与中断。
