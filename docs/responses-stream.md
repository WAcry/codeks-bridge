# Responses 流

本项目对客户端实现 `POST /v1/responses`，也接受不带 `/v1` 的同一路径。`stream: true` 返回 SSE，其他请求返回一个完整 JSON response。上游始终使用流式请求以便及时显示文字、处理取消与错误。

## 事件与提交

每个输出项先发 `response.output_item.added`，随后发 delta，最后发包含完整内容的 `response.output_item.done`。客户端从 done 项持久化历史，因此 reasoning carrier 不能只出现在 delta 或 response 末尾。工具调用等完整响应成功才一起发送；工具前的 assistant 文字 phase 为 `commentary`，最后回答为 `final_answer`。

末尾 `response.completed` 带 ID、完整 output 和 usage。`end_turn: false` 保留需要继续生成的语义，例如 Messages `pause_turn`。失败使用 `response.failed`，错误码传给客户端决定重试：容量不足为 `server_is_overloaded`，限流为 `rate_limit_exceeded`，配额为 `insufficient_quota`，无效输入为 `invalid_prompt`，窗口超限为 `context_length_exceeded`，断流与网络问题为可重试错误。

HTTP `Retry-After` 会进入 Responses error headers。bridge 不进行第二层重试，以免放大客户端的重试预算。取消下游请求会取消所有相关上游请求，包括双压缩的两条请求。

## Usage

Responses 使用上游 input/output；Chat 使用 prompt/completion 及 cache hit；Messages 把普通 input、cache read 与 cache creation 相加得到完整 input。总数只计算 input + output；reasoning 若作为输出分项报告，不再额外叠加。GPT 双压缩 usage 是两条实际请求用量之和，不是后续上下文窗口的大小。

## Keepalive 与超时

等待期间每 15 秒发送 JSON `keepalive` 事件。客户端会忽略内容并刷新其流空闲计时；单纯 SSE 注释不能达到此效果。bridge 对上游另设空闲计时，默认 300 秒，可在 upstream 配置 `stream_idle_timeout_ms`；只收到上游字节才重置。这样慢压缩可以保持客户端连接，而卡死的上游仍会产生可重试错误。

正常返回必须出现上游的完整终止信号。缺终止信号、输出长度截断、拒绝或无效工具结果都不能伪装成正常完成。
