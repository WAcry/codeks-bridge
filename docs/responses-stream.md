# Responses 流与错误

客户端使用 `POST /v1/responses`，也接受不带 `/v1` 的同一路径。`stream: true` 返回 SSE，其他请求返回完整 JSON response。上游统一使用流式请求，以便及时显示文字、处理取消与错误。

## 事件与交付

每项输出先发 `response.output_item.added`，随后发 delta，最后发包含完整内容的 `response.output_item.done`。客户端从 done 项持久化历史，因此 reasoning carrier 必须出现在完整项中。工具调用等整个响应成功才一起交付；工具前的 assistant 文字 phase 为 `commentary`，最后回答为 `final_answer`。

末尾 `response.completed` 带 ID、完整 output 和 usage。`end_turn: false` 保留需要继续生成的语义，例如 Claude `pause_turn`。缺少完整终止信号、输出截断、拒绝或无效工具结果都返回错误，不伪装成成功。

## 上游错误

错误同时保留两层信息：`code` 供 codeks 判断如何处理，`upstream` 记录上游原始错误体和可得的 HTTP 状态码。例如：

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

SSE 中位于 `response.failed.response.error`；非流式 HTTP 响应位于顶层 `error`，Retry-After 使用 HTTP header。流内错误没有独立 HTTP 失败状态时，`upstream` 只包含原始事件内容。非 JSON 的 HTTP 错误体按原文本保存。

| 分类 | codeks 错误码 |
| --- | --- |
| 上下文过长 | `context_length_exceeded` |
| 配额或余额不足 | `insufficient_quota` |
| 速率限制 | `rate_limit_exceeded` |
| 容量不足 | `server_is_overloaded` |
| 无效输入、鉴权或权限错误 | `invalid_prompt` |
| 断流、传输等其他失败 | `stream_error` 或 `upstream_error` |

原始错误体保留厂商 code/type 和其他诊断，规范分类不覆盖这些内容。网络错误保留可用的原因链，凭据命令的 stdout/stderr 不外传。

bridge 不重试、不替换端点，也不因错误移除 reasoning、关闭 thinking 或改用文字压缩。客户端决定重试预算和退避。下游取消会取消相关上游请求，包括双压缩的两条请求。

## Usage

GPT 使用上游 input/output；DeepSeek 使用 prompt/completion 与 cache hit；Claude 将普通 input、cache read、cache creation 相加得到完整 input。总数只计算 input + output；reasoning 作为输出分项，不重复叠加。双压缩 usage 是两条实际请求之和，不是后续上下文大小。

usage 缺失或无效时返回错误，不使用零值影响客户端压缩判断。

## Keepalive 与超时

等待期间每 15 秒发送 JSON `keepalive` 事件，客户端忽略内容并刷新流空闲计时。SSE 注释不能提供同样效果。

上游空闲超时独立控制，默认 300 秒，可设置 `upstreams.<id>.stream_idle_timeout_ms`。只有上游字节重置它，下游 keepalive 不延长它。因此慢压缩可以保持客户端连接，卡住的上游仍会超时报错。
