# Responses 流与错误

客户端使用 `POST /v1/responses`，也接受不带 `/v1` 的同一路径。`stream: true` 返回 SSE，其他请求返回完整 JSON response。上游统一使用流式请求，以便及时显示文字、处理取消与错误。

## Header 与转发边界

请求及成功、失败响应的 header 默认转发，包括 `session-id`、`thread-id`、`x-codex-turn-state`、请求 ID 和未知扩展字段。`prompt_cache_key` 属于 body，不能替代会话及路由 header。GPT body、事件及错误同样保留未知字段；必要转换不等于按已知字段重建整个协议。

每段 HTTP 连接独立负责传输：去掉 hop-by-hop header、`Connection` 指定的字段，以及重写或解压后失效的 `Content-Length`、`Content-Encoding`。出站请求重新生成 Host 与压缩协商，不转发客户端的 `Authorization`、API key、Cookie 或所选连接的自定义鉴权 header；上游静态 headers 覆盖同名客户端值，再由该连接的凭据配置设置鉴权。返回 body 被转换时由 bridge 设置 Content-Type，`x-models-etag` 始终属于 bridge 自己的模型目录。其余字段不按厂商或名称白名单筛选。

普通回答、原生压缩、文字摘要及按需复述统一透传客户端 metadata，包括 `session-id`、`thread-id` 和 `x-codex-turn-state`。按需复述使用本次请求的 metadata 和原来源的当前鉴权，header 不写进检查点或摘要缓存。

OpenAI 订阅端点的实测确认了 `x-codex-turn-state` 的实际使用，也观察到携带错误或合成 state 的请求被接受并收到新的 state。本项目据此选择默认透传，由上游处理；出现可复现的不兼容时再针对性调整。这项证据仅来自 OpenAI 订阅端点，不代表 Azure 或 AWS 的处理方式。

成功的辅助复述不把响应 header 混入目标响应；最终返回目标请求的 header。辅助请求发生 HTTP 或流内失败时，默认透传该失败的响应 header，包括请求 ID、路由状态和未知诊断字段。

## 事件与交付

每项输出先发 `response.output_item.added`，随后发 delta，最后发包含完整内容的 `response.output_item.done`。客户端从 done 项持久化历史，因此 reasoning carrier 必须出现在完整项中。

GPT 保留原生事件、response ID、时间、usage 分项和额外元数据，只转换模型别名、reasoning carrier 和客户端需要的缺省字段。完整 JSON 响应或仅带最终输出的流会补齐 item 事件；不把完整摘要伪造成上游曾发送的 delta。Claude/DeepSeek 由 writer 生成 Responses 事件。

从第一个工具调用开始，writer 缓存它和此后的全部输出，整个响应成功后按原顺序释放。此前的文字仍可流式显示；之后的文字和 reasoning 会延迟。这样既不提前执行工具，也不会把原本穿插在文字之间的调用挪到末尾。失败时丢弃整个未交付后缀，keepalive 不受缓冲影响。

GPT 消息优先保留原生 `phase`，包括 `partial_answer`。缺省时，后面还有输出或工具调用的文字为 `commentary`；最后一条文字在 `end_turn: false` 时也为 `commentary`，其他情况为 `final_answer`。没有工具调用不等于当前 turn 已结束。

GPT 同一 reasoning item 内的摘要保留各段 `summary_index`，对应的 part、text delta/done 与最终 `item.summary` 结构一致。Claude 和 DeepSeek 没有这种分段协议时，继续使用单段摘要；不同 reasoning item 各自从索引 0 开始。

末尾 `response.completed` 带 ID、完整 output 和 usage。`end_turn: false` 保留需要继续生成的语义，例如 Claude `pause_turn`。缺少终止信号或无效工具结果返回错误，不伪装成成功。

GPT 的 `response.incomplete` 保留原类型、原因和 usage，不改成通用错误。已核对 Codex `0.163.0`：`interrupted` 表示继续当前 turn；`content_filter` 使用内容过滤提示；`max_output_tokens` 等其他原因结束当前生成并记录已有用量。完整 JSON 与 SSE 终止事件中的 `output` 都会补齐尚未交付的 item 事件，已有 done 不重复发送，因为客户端不会从终止事件的 `output` 重建历史。未完成的工具后缀仍不交付。Claude/DeepSeek 没有同样的 Responses 事件时，继续按各自停止原因转换。

## 上游错误

### GPT 原生错误

流式入口等上游成功响应头到达后，才发送下游 HTTP 200 并开始 SSE。上游 HTTP 失败保留 status、body 内容和诊断 header，包括 `Retry-After`；不解析后重新包装错误体。fetch 已解压响应体，因此去掉原 `Content-Encoding`、`Content-Length`，以及只适用于当前连接的传输 header。

上游流内错误保留完整 error 对象，放入 `response.failed.response.error`；上游提供完整 response envelope 时也一并保留。`code`、`type`、`misalignment`、`plan_type`、`resets_at` 等字段不改写，也不按 GPT 错误码白名单分类。只有 error 中缺少 `retry-after` 而上游 HTTP header 提供了它时，才补入 `error.headers`。非流式客户端收到相同原生错误，HTTP 状态为 502；它不能恢复已经成功建立的上游流的 HTTP 错误状态。响应 header 按上述边界保留，不制造复合请求 ID。

这是保留客户端行为的协议边界。已核对 Codex `0.163.0` 的 `codex-rs/codex-api/src/api_bridge.rs` 与 `sse/responses_error.rs`：HTTP 和 SSE 使用不同的错误处理路径，部分专用提示依赖原错误字段，未知 SSE code 则会进入可重试分支。把 HTTP 400 改成 200 + SSE，或把原生策略错误改名为 `upstream_error`，都可能把原本会停止的请求变成重试。bridge 因此接受等待响应头期间没有心跳的代价，不自行维护另一套 GPT 重试分类。

### Claude 与 DeepSeek 的协议转换

非 Responses 协议仍需要转换为客户端能识别的错误。`code` 供 codeks 判断如何处理，`upstream` 记录原始错误体和可得的 HTTP 状态码。例如：

```json
{
  "code": "server_is_overloaded",
  "message": "Capacity unavailable",
  "headers": { "retry-after": "30" },
  "upstream": {
    "status": 503,
    "body": { "error": { "type": "overloaded_error", "message": "Capacity unavailable" } }
  }
}
```

HTTP 失败发生在建立下游流之前，响应体使用顶层 `error`，Retry-After 使用 HTTP header；建立流后的失败放入 `response.failed.response.error`。流内错误没有独立 HTTP 失败状态时，`upstream` 只包含原始事件内容。非 JSON 的 HTTP 错误体按原文本保存。

| 分类 | codeks 错误码 |
| --- | --- |
| 上下文过长 | `context_length_exceeded` |
| 配额或余额不足 | `insufficient_quota` |
| 速率限制 | `rate_limit_exceeded` |
| 容量不足 | `server_is_overloaded` |
| 无效输入、鉴权或权限错误 | `invalid_prompt` |
| 断流、传输等其他失败 | `stream_error` 或 `upstream_error` |

原始错误体保留厂商 code/type 和其他诊断。这个转换表只适用于非 Responses 上游，不用于改写 GPT 原生错误。网络错误保留可用的原因链。缺少凭据、凭据命令失败、输出为空或多行均返回 HTTP 400 + `invalid_prompt`，保持原本的终止语义；命令的 stdout/stderr 不外传。

bridge 不重试、不替换端点，也不因错误移除 reasoning、关闭 thinking 或改用文字压缩。客户端决定重试预算和退避。下游取消会取消当前相关上游请求，包括正在进行的原生压缩或复述；尚未开始的后续步骤不会执行。

## Usage

GPT 保留原始 usage，包括提供的 cache write 等分项；DeepSeek 使用 prompt/completion 与 cache hit；Claude 将普通 input、cache read、cache creation 相加得到完整 input。转换后的总数只计算 input + output；reasoning 作为输出分项，不重复叠加。`native` 初始只返回原生压缩用量；后续辅助复述的 usage 独立保存在本地缓存，不加入目标回答的 usage。

成功响应的必需 usage 缺失或无效时返回错误，不使用零值影响客户端压缩判断。释放工具前还会按当前客户端的终止解码要求检查 response ID、可选 `end_turn` 与 usage metadata 的类型，以及 `total_tokens` 和已提供的 usage 分项。保留原生 envelope 与未知字段，不补造缺失总数；否则工具可能已经执行，客户端才发现成功终止事件无法解码。这里核对的是 Codex `0.163.0` 的 `sse/responses.rs` 与 `protocol/src/response_usage.rs`，升级客户端时复核这些少量必需字段。原生失败或 incomplete 保留上游提供的用量，不以 usage 校验覆盖原始终止原因。

## Keepalive 与超时

等待上游响应头期间不发送下游响应头或 keepalive。上游接受请求后，每 15 秒发送 JSON `keepalive` 事件，客户端忽略内容并刷新流空闲计时。SSE 注释不能提供同样效果。

`native` 初始压缩在原生请求被接受后建立流；后续需要按需复述时，先完成并缓存文字，再等待目标请求被接受。辅助复述不提前打开下游流。

上述等待仍可能遇到上游流内失败。即使下游尚未建立流，bridge 也会以原生 SSE 错误结束请求，而非把已经发生的流内失败伪造成 HTTP 失败。HTTP 失败则保留原状态码和响应体。辅助请求的 `response.failed` 保留原 error 及其他 response 字段，但清空 output、移除 usage，避免把源请求的部分结果算成目标回答。辅助请求的 `response.incomplete` 视为压缩不完整，返回 `invalid_prompt`，原 response 留在 `upstream.body` 供诊断，不交付其部分输出。

按需复述的等待可能覆盖完整的辅助推理，客户端空闲超时应足以容纳该等待。

上游空闲超时独立控制，默认 300 秒，可设置 `upstreams.<id>.stream_idle_timeout_ms`，也覆盖等待响应头和读取错误体的阶段。只有上游字节重置它，下游 keepalive 不延长它。因此已接受的慢压缩可以保持客户端连接，卡住的上游仍会超时报错。
