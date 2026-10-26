# GPT Responses

模型选择 GPT 目录 key，例如 `catalog: "gpt-6.1-sol"`，条目指定 `gpt-responses` adapter，bridge 向连接的 `/responses` 发请求。`base_url` 包含版本前缀，例如 `https://api.openai.com/v1`。实际模型名可以是任意部署别名，转换不依赖名称前缀。

## 订阅凭据与续期

连接设置 `auth: { "type": "chatgpt" }` 时，默认使用 `https://chatgpt.com/backend-api/codex`；请求体、Lite、原生压缩与 handoff 继续使用同一个 Responses adapter。登录与目录选择见[订阅配置](config.md#chatgpt-订阅)。

凭据处理以 Codex `rust-v0.164.0` 的 [AuthManager](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/auth/manager.rs) 和 [TokenData](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/token_data.rs) 为依据：每请求重新读取文件，token 与 `tokens.account_id` 来自同一快照。JWT 的 `exp` 只用于决定刷新时机：剩余不超过 5 分钟时刷新；没有可用 `exp` 时，参考 `last_refresh` 的 8 天周期。账号 ID 不从 access token 推断。

刷新使用保存的 `oauth_provenance.issuer` 和 `client_id`，旧记录使用 Codex 默认 OAuth 来源。成功后保留原记录及未知字段，更新返回的 token 和 `last_refresh`，通过权限为 `0600` 的临时文件原子替换原文件。轮换后的 refresh token 必须成功写回，写入失败会报错。刷新错误不会把 OAuth 响应正文或凭据回传客户端。

同一 bridge 进程按登录文件串行处理刷新，拿锁后重新读文件，其他请求已经更新 token 时直接复用。保存前核对登录记录，避免覆盖刷新期间发生的重新登录或账号切换。这不是与所有 codeks 或 bridge 进程共享的刷新锁；不要把进程内去重理解为跨进程互斥。

模型请求收到 HTTP 401 时，bridge 允许一次鉴权恢复：先重新读取凭据，仍是被拒绝的 token 才刷新，再重发相同请求。此时下游 SSE 尚未开始；再次 401 原样交给 codeks，不循环刷新。其他 HTTP、流内或传输错误继续交给客户端处理。

OAuth 刷新发出后使用独立的 30 秒超时，即使原推理请求取消，也继续接收并保存轮换结果，避免丢失下一代 refresh token；取消的模型请求不会继续重发。OAuth 交换不进入 inspector 的请求正文捕获，模型的 401 与重发仍分别记录，鉴权 header 沿用现有脱敏。

## 请求与参数

普通 Responses 参数、namespace 和 custom grammar 工具保留原始格式，包括未知扩展字段；请求及响应 header 按 [HTTP 边界](responses-stream.md#header-与转发边界) 默认透传。模型名替换为配置的实际名称，reasoning effort 使用 profile 默认值和配置映射。`max_output_tokens` 优先使用请求值，再使用模型默认值。

客户端默认发送 Responses Lite：工具声明保留在 `input[].additional_tools` 的原位置，不提升到顶层 `tools`。保留 `reasoning.context: "all_turns"` 和 `parallel_tool_calls: false`，并向对应 GPT 上游发送 Lite header。GPT-5.5 条目也显式启用 Lite，其余模型能力不随之升级。入口从客户端 header 或 `additional_tools` 识别 Lite；只有 header、没有工具的请求也能保持标记。非 Lite 请求仍保留普通工具声明。后端不通过模型名称或云厂商猜测协议。

随后浅层合并上游和模型 `options`，后者覆盖前者，也可覆盖推导出的普通参数。最后由 bridge 固定 `model`、`input`、`tools`、`store: false`、`stream: true`，`include` 至少包含 `reasoning.encrypted_content`。上游状态由完整历史承载，不依赖服务器保存的会话。

bridge 能识别的历史 reasoning 按允许来源选择，将 `responses.reasoning.v1` 的 data 还原为原生密文；原生压缩按独立策略选择。未识别状态由 `replay.unrecognized` 决定处理方式，默认保留整项，包括其 `id`。其余输入项移除顶层 `id`，工具配对的 `call_id` 保留，避免引用已过滤的 reasoning。图片、普通消息、工具结果和明文 agent message 保留原格式。[状态规则](reasoning.md)

## 流与工具交付

桥接器消费 SSE，也接受完整 JSON response。原生事件和 response envelope 保留 ID、时间、usage 和未知元数据，只修改桥接所需字段。完整 JSON 或仅在终止事件提供的输出会补齐 item added/done，供客户端持久化。保留上游消息的 `phase`，包括 `partial_answer`；只有缺失时才按后续输出、工具和 `end_turn` 推断。摘要保留同一 item 内的分段索引及完整 summary 数组，不把多段压成一段。

第一个工具之前的文字和摘要流式交付；从第一个工具起，所有事件作为有序后缀缓存，完整成功后释放。function call 保留 namespace，custom tool 保留原始输入。失败、截断和连接中断丢弃整个后缀，不让客户端执行未完成的工具调用，也不改变工具与后续消息的相对顺序。

`end_turn` 有显式值时遵从上游，否则有工具调用时返回 false。成功响应的 input/output usage 必须是有效计数，cache read/write、reasoning 分项有则记录；reasoning 不重复叠加到 input。无效 usage 作为错误返回，避免影响 codeks 压缩判断。`response.incomplete` 原样保留原因与可用 usage，由客户端处理继续生成、内容过滤或截断，不统一改成可重试错误。

上游成功响应头到达前，不建立下游 SSE。除上述订阅 401 鉴权恢复外，HTTP 失败保留原始 status、body 和诊断 header；流内错误保留完整 error 对象，不维护 GPT code 白名单。被允许的密文遭拒也直接返回，不自动过滤后重试。[错误结构](responses-stream.md)

## 原生压缩

默认 `compaction.mode: "native"` 向 `/responses` 发送保留 `compaction_trigger` 的请求，保存原生检查点及复述配方。目标需要文字表示时，原来源读取后续请求中实际保留的历史与原生检查点，使用 handoff prompt 复述，并缓存成功结果。若端点只适合文字压缩，显式设置 `mode: "summary"`，使用标准 prompt 汇总原历史。

原生请求移除普通回答的 `max_output_tokens`，包括配置和 options 中的值，由上游管理压缩输出预算。摘要仍使用普通预算，保留工具定义和工具选择，移除结构化输出格式；工具调用的失败语义见 [压缩](compaction.md#工具选择与缓存)。

是否生成原生压缩与是否恢复原生检查点独立。配置 `native_replay` 和 `native_compaction_from` 后，格式可读且来源允许的原生状态优先发送；上游拒绝即报错。[压缩配置](compaction.md)

实现与测试：[`src/backends/responses.ts`](https://github.com/WAcry/codeks-bridge/blob/main/src/backends/responses.ts)、[`test/responses.test.ts`](https://github.com/WAcry/codeks-bridge/blob/main/test/responses.test.ts)。
