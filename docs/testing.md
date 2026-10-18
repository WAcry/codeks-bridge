# 验证

桥接器的测试只使用 Node 内置测试器和本地假上游，不需要模型密钥。普通测试不启动 codeks，也不编译其 Rust 项目。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run check
```

## 测试覆盖什么

- 工具：普通函数、namespace、自定义工具的原始字符串、Lark/regex 描述、名称冲突与超长名称、加密 schema 关键字的清理。
- Lite：工具声明原位传给 GPT；Claude/DeepSeek 提取增量 schema，保留原历史与默认 namespace 身份；header、all-turns 和双压缩前缀保持。
- 流：跨字节分块的 UTF-8、CR/LF、SSE 多行数据、结束标记、非法 JSON。
- Responses 输出：先 added 后 delta/done、完整历史项、usage、reasoning carrier、原生消息 phase（含 `partial_answer`）、缺省 phase 与 `end_turn` 的关系、摘要分段索引和最终数组一致、明文多代理参数、失败时不执行尚未提交的工具。
- 配置与目录：有限 key、原始 GPT 条目保留、第三方精调、别名与部署名分离、窗口覆盖、effort 映射及默认值、catalog 与出站参数一致、options 覆盖顺序。
- 目录发现：Codex 专用 `/models` 响应、入口鉴权、ETag 与响应版本标记、连接及凭据配置不进入目录。
- 状态：reasoning 与原生压缩的独立允许来源、定向非传递关系、配置改变后恢复已有 carrier、身份与显示别名分离、输入历史不变。
- 压缩：生成模式与 native replay 独立、双分支接受后才建立流、双分支成功才交付、首个失败取消另一分支、HTTP 与早期 SSE 失败的路径保留。
- 后端与历史：各 API 的消息、工具、图片、schema、thinking、usage 与错误转换；Claude 空工具结果、上下文边界停止及不完整工具不交付。
- 错误：等待上游响应头时不发送 200；GPT HTTP status/body、诊断 header 与原生 SSE error 字段保留；移除不适用的传输 header；Claude/DeepSeek 继续转换协议；验证没有额外请求或自动降级。

这些测试检查协议和客户端行为；假上游不会验证模型是否理解提示词，也不会验证真实服务的缓存命中率、容量和区域之间的密文兼容性。

## 使用真实 codeks 二进制

可选集成测试启动已经安装的 codeks，并让它通过桥接器访问本地假上游。指定要验证的二进制即可，测试不会下载或编译 codeks：

```sh
CODEKS_BIN=/absolute/path/to/codex node --test test/codeks-e2e.test.ts test/catalog-e2e.test.ts test/reasoning-e2e.test.ts test/errors-e2e.test.ts
```

未设置 `CODEKS_BIN` 时，这些测试自动跳过。它们为每个场景创建独立的 `CODEX_HOME` 和工作目录，监听随机的回环端口。临时目录路径会写入测试输出，保留会话和进程输出便于复查。退出时关闭本轮创建的服务器。

以 `@wacry/codeks@0.162.1-codeks.10` 的现成 Linux 二进制验证了以下场景：

| 场景 | 实际检查 |
| --- | --- |
| 普通工具与图片 | codeks 执行 shell 和 `apply_patch`；文件内容正确；用户附图与 `view_image` 结果都进入 Chat 图片字段 |
| Code Mode 与多代理 V2 | 自定义 `exec` 执行；namespace 工具回传；明文 `spawn_agent` 创建真实子代理；子代理收到任务，父代理收到最终答复 |
| 远程压缩 V2 | 高 usage 触发 `compaction_trigger`；桥接器生成可回放摘要；codeks 替换旧工具历史；退出后 resume 仍读到摘要 |

当前测试使用仓库内已审阅目录。协议测试检查 Lite header、`additional_tools` 中的完整 schema、`reasoning.context: "all_turns"`、`parallel_tool_calls: false` 和省略顶层 tools；普通工具测试可显式覆盖工具模式，以单独检查直接调用契约。目录集成测试通过 HTTP 发现目录，检查默认 Code Mode Only 下的 `exec`、`ALL_TOOLS` 和 MCP 调用，不依赖其他 namespace 的固定拼写。

最新正式版 `@openai/codex@0.163.0` 的现成二进制另外通过普通工具/图片及压缩/resume 两项测试。它用于核对最新客户端 Lite 契约；明文多代理由上述 codeks fork 二进制验证，不将原生客户端验证等同于 fork 补丁验证。

### 已审阅目录与 HTTP 发现验证

2026-10-18（America/Los_Angeles），`@wacry/codeks@0.162.1-codeks.10` 与 `@openai/codex@0.163.0` 的现成二进制分别通过新增目录场景。客户端是真实进程，模型上游与 MCP 服务是本地测试服务器：

- 从 bridge 的 HTTP 目录发现两个窗口别名，保留各自窗口、提示词和工具元数据，并把目录与 ETag 写入客户端缓存。
- 使用配置片段中的公开鉴权标记进入 API key 发现流程；模型别名与实际部署名不同，出站路由仍正确。
- 保持 `supports_search_tool: true` 和 Code Mode Only。外层没有独立 `tool_search` 或 MCP 工具，`exec` 描述也没有内嵌延迟 MCP 的 schema。
- 模型通过 `ALL_TOOLS` 按描述找到延迟 MCP 工具，再调用 `tools[name]`。真实客户端执行 MCP 请求并把结果回传模型上游。

同轮 codeks 二进制还重新通过了上表中的普通工具/图片、明文多代理 V2、远程压缩/resume 三个场景。TypeScript 检查、普通测试、构建与打包解包后的 CLI 检查通过；包中包含全部八个目录文件。这里验证客户端协议与包的完整性，不代表新增了真实模型端点或缓存时长的实测。

### 摘要显示与 Ultra

2026-10-18（America/Los_Angeles），两个上述客户端版本均通过 `test/reasoning-e2e.test.ts` 的四个新增场景：

- 默认配置及显式 `model_reasoning_summary = "none"` 都省略出站 summary 字段，Claude 请求 `display: "omitted"`。
- 显式 `auto`、`detailed` 请求可见摘要，bridge 返回客户端可识别的 reasoning 事件。
- 关闭显示仍保存载荷，包括只有签名、thinking 文本为空的块，并在后续请求中回放。
- `ultra` 的多代理提示词由真实客户端注入一次；Opus 使用 `xhigh`，Sonnet 与 DeepSeek 使用 `max`。

TypeScript 检查和普通测试通过，客户端场景各在两个现成二进制上单独运行。这些结果验证协议与客户端行为，不作为真实模型规格的验证。

### 最终审计与构建产物

2026-10-18（America/Los_Angeles），补充 Claude 的 `parallel_tool_calls` 转换回归测试，覆盖客户端显式选择、原生 options 覆盖优先级，以及压缩时的 `tool_choice: none`。普通测试、类型检查与构建通过。

构建后实际打包并在独立目录解包，确认八份目录、文档和示例完整，CLI 与 HTTP 目录可用，包内文档相对链接及私有内容扫描通过。

### 错误路径与客户端重试

2026-10-18（America/Los_Angeles），`@openai/codex@0.163.0` 的现成二进制通过 `test/errors-e2e.test.ts` 的八个场景，上游均为本地测试服务器：

- SSE 策略拦截、预算超限、`usage_not_included`、`flex_unavailable` 保留客户端专用分类和提示，各请求一次即停止。
- HTTP 429 用量限制保留 `plan_type`、`resets_at`，客户端显示对应升级和恢复时间提示；HTTP 429 预算限制停止。
- HTTP 400 的未知错误码保留原响应体，不变成流内未知错误而触发重试。
- 未知 SSE 错误按客户端配置重试一次，bridge 收到和转发的请求均为两次，没有额外重试。

普通 HTTP 测试另覆盖双压缩接受协调、失败取消、错误体解压后的 header 清理、凭据失败的终止语义，以及原生错误附加字段的完整保留。这里验证客户端协议，不代表真实服务产生过上述合成错误。

## 真实上游验证

真实端点的配置、鉴权、请求与响应只保存在仓库外。公开测试数据必须是合成内容，不能复制真实密钥、端点、签名、密文、对话或账号信息。

真实验证应区分：单次请求、工具回环、图片、切换模型后 reasoning 隔离、压缩后续接。Responses 的双重压缩还需要检查两个分支都成功后才提交结果；未允许的端点或模型使用可读摘要，允许来源且目标开启 native replay 时恢复原生压缩内容；分别测允许与不允许的配对。某一服务上的成功不代表另一服务也支持同样的字段。

### Responses Lite 验证

2026-10-18（America/Los_Angeles）通过实际 bridge HTTP 入口完成以下验证：

- AWS GPT-6.1 Sol、Azure GPT-5.6 Sol、Claude Sonnet 5.5、DeepSeek Flash 均通过 Lite 工具往返与 reasoning 载荷回放。
- GPT 出站请求实际保留 Lite header、原位 `additional_tools`、`reasoning.context: "all_turns"` 和 `parallel_tool_calls: false`，没有增加顶层 `tools` 或改用其他协议重试。
- Claude/DeepSeek 提取完整工具声明，返回调用的身份可供客户端继续执行。
- AWS GPT 双压缩及同目标原生检查点续聊成功。

上述场景包含 11 次成功上游请求。原生 OpenAI 订阅端点未实测；官方 Codex 二进制与假上游的协议测试不能替代该端点验证。

### 配置重构验证

2026-10-18（America/Los_Angeles）通过实际 bridge HTTP 入口发送了 10 次真实上游请求：

- GPT-6.1 Sol、Claude Sonnet 5.5、DeepSeek Flash 均生成了新的 reasoning carrier，并成功完成同源 reasoning 回放。
- GPT-6.1 Sol 双压缩成功，检查点同时包含原生压缩与文字摘要。
- 显式允许另一连接上的 GPT-5.6 恢复该原生检查点后，bridge 确实发送了原密文；目标返回 HTTP 400 解密不兼容。原始错误完整传回，没有额外重试或改用文字摘要。

这验证配置能控制尝试的配对，不能让上游原本不兼容的密文变得兼容。Claude 对简单任务可以不生成 thinking；本次改用需要推理的任务验证载荷回放，没有把普通成功回答算作 reasoning 回放成功。

### 既有真实端点证据

2026-10-17（America/Los_Angeles）在当时的默认隔离策略下完成以下真实端点验证。这些是既有协议互操作证据，不代表新的共享配对已得到验证；每次配置共享来源仍需验证具体目标。当前代码的验证以本次运行的测试结果为准。

| 后端 | 已通过 |
| --- | --- |
| GPT Responses（两个云端连接） | reasoning 回放、跨连接切换、namespace 工具及结果、自定义 Lark 工具、图片识别、双压缩、同连接 native 与跨连接 summary 回放 |
| Claude Messages（Opus / Sonnet） | namespace 工具、工具图片、custom regex 工具、Opus → Sonnet → Opus reasoning 隔离与恢复、带签名 reasoning 的压缩及续接、Responses JSON Schema 转 Messages 结构化 JSON 输出 |
| DeepSeek 官方 `deepseek-flash` | namespace 和 custom 工具、同模型 reasoning 工具循环、跨模型历史配空 reasoning 字段、用户/工具图片、完整文字 reasoning 重放 |

Claude 一次压缩输入 19,778 tokens，其中 19,541 命中缓存，约 98.8%；`1h` 前缀与 `5m` 末块参数被上游接受。这只验证即时命中，没有等待 1 小时测到期。DeepSeek 一次 reasoning 回放输入 1,488 tokens，其中 1,280 命中缓存。

HTTP 集成测试另外覆盖入口鉴权、响应校验、429/503/配额分类、`Retry-After`、失败时不释放工具、客户端断开取消上游，以及下游 keepalive 持续时上游依然会触发空闲超时。使用合成 checkpoint 验证过服务重启、跨后端与跨区域恢复。

完整的真实 HTTP 路径也已验证：经 bridge 生成 GPT 双压缩 checkpoint，序列化后交给 Claude 和 DeepSeek 续聊，再切回原 GPT。跨模型请求实际使用文字摘要且不含原生密文；切回请求恢复原生 checkpoint 并过滤外来 reasoning。原 GPT 正确回答了只存在于 checkpoint、此前续聊明文未出现的第二个标记，原始 carrier 保持不变。
