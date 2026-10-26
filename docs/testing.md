# 验证

开发与直接运行 TypeScript 源码需要 Node.js ≥ 22.18；已发布 JavaScript 包支持 Node.js ≥ 20.19。

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
- Lite：工具声明原位传给 GPT；Claude/DeepSeek 将增量 schema 按历史合并为唯一的最新顶层定义，保留其他成员、原历史与默认 namespace 身份；header、all-turns 和原生压缩前缀保持。
- 流：跨字节分块的 UTF-8、CR/LF、SSE 多行数据、结束标记、非法 JSON。
- Responses 输出：先 added 后 delta/done、完整历史项、usage、reasoning carrier、原生消息 phase（含 `partial_answer`）、缺省 phase 与 `end_turn` 的关系、摘要分段索引和最终数组一致、明文多代理参数、失败时不执行尚未提交的工具。
- 配置与目录：有限 key、原始 GPT 条目保留、第三方精调、别名与部署名分离、窗口覆盖、effort 映射及默认值、catalog 与出站参数一致、options 覆盖顺序。
- 目录发现：Codex 专用 `/models` 响应、入口鉴权、ETag 与响应版本标记、连接及凭据配置不进入目录；`visibility` 隐藏时保留完整元数据和路由、`expose` 过滤、首个可见别名作为默认、没有可见别名时配置片段报错，以及省略的模型继续参与委托压缩和 handoff。
- 状态：reasoning 与原生压缩的独立允许来源、定向非传递关系、配置改变后恢复已有 carrier、身份与显示别名分离、输入历史不变。
- 压缩：生成模式与 native replay 独立；summary 保留标准 prompt；工具定义、选择及未知参数保留，意外工具调用明确失败；GPT 默认 native 生成原生检查点；所有必需步骤成功才交付；失败、截断与取消保持原路径。
- 按需复述：兼容目标不导出，其他目标向原来源导出；不包含检查点后的新工作；来源别名恢复、缓存及重启复用、同键排队与独立取消；辅助 usage 不进入目标上下文统计。
- 委托压缩：执行别名与工作模型默认模式独立、单跳引用、同部署不同别名的 effort 预设；先按执行者恢复旧原生状态，再压缩包含其他模型新增消息和工具的历史；新检查点来源、复述 effort 与执行者一致。
- 保留历史：按需复述使用客户端实际保留的历史而不再裁剪；源指令与工具声明恢复，检查点后的工作留给目标请求。
- 后端与历史：各 API 的消息、工具、图片、schema、thinking、usage 与错误转换；Claude 空工具结果、上下文边界停止及不完整工具不交付。
- 检查器：四段内容逐字节保存、只脱敏凭据 header、上游调用标签、标注与实际回放决定一致、捕获开关与结束时的软上限淘汰、清空释放数据且不打断请求、客户端断开、无 token 时的 loopback 与同源限制、token 鉴权、静态文件路径、导出格式和跨块 SSE 解析；Responses Lite 结构视图补全输出且保留原始事件。
- 嵌入：请求在路由前同步或异步变换；出站 fetch 按服务实例注入并覆盖三种 adapter、压缩及按需复述；观察器只接收主响应实际提交的 Responses 事件，流式与 JSON 保持一致，失败时未提交工具不外泄；响应头和响应体超时可分别禁用。
- Header 与错误：会话、路由及未知 header 默认透传；鉴权归所选上游，必要的传输字段移除；等待上游响应头时不发送 200；GPT HTTP status/body 与原生 SSE error 字段保留；辅助复述成功时返回目标 header，失败时返回该失败的 header；Claude/DeepSeek 继续转换协议；验证没有额外请求或自动降级。

这些测试检查协议和客户端行为；假上游不会验证模型是否理解提示词，也不会验证真实服务的缓存命中率、容量和区域之间的密文兼容性。

压缩后的信息保留与 handoff 质量另有[手动 benchmark](../benchmarks/compaction/README.md)：使用公开合成材料，对比两种文字 prompt、原生压缩和原生压缩后 handoff。它独立于 CI，提供复跑方法、输入、产物和逐题结果；真实模型请求需要显式执行。

Claude 续接边界的回归同时检查生成和下一轮回放：首块 thinking/redacted 的 `continuation_before` 只记录一次，原生载荷不变；连续失败、多个 thinking、关闭摘要显示时仍保持顺序；来源过滤与切回按同一载荷生效。正文或工具先于 thinking、没有 thinking，以及没有该字段的既有载荷，继续使用原有失配策略。`test/claude-continuation.test.ts` 检查转换，`test/claude-recovery-e2e.test.ts` 使用真实 codeks 和假上游检查持久化与重试；签名是否被真实上游接受须另行验证，不能由合成签名测试推断。

2026-10-20（America/Los_Angeles），以 `@wacry/codeks@0.163.0-codeks.5` 启用全部客户端测试，286 项通过、0 跳过，类型检查、构建和私有内容检查通过。续接场景覆盖 overload、EOF、连续两次失败及进程重启后的 resume。另复用真实 T1/T2 签名直接请求官方 Sonnet 5.5：恢复原位 `user: Continue.` 后返回 HTTP 200，`input_transformations` 明确为空数组。这验证边界恢复的协议依据；carrier 的生成、保存与重放由真实客户端加本地假上游验证，两类证据分别成立。

`test/delegated-compaction-e2e.test.ts` 通过 bridge 的真实 HTTP 入口连接本地假上游，覆盖 GPT 原生续聊 → Claude 按需复述 → Claude 委托 GPT 再压缩 → Claude 复述新检查点 → GPT 恢复新检查点。另检查 native 失败不交付部分检查点、handoff 失败不调用工作模型、工作模型失败后跨服务重启复用成功缓存，以及 inspector 的独立 handoff usage 不进入客户端响应。它不启动 codeks，也不调用真实模型；委托压缩的质量与成本不由这些测试推断。

## 使用真实 codeks 二进制

可选集成测试启动已经安装的 codeks，并让它通过桥接器访问本地假上游。指定要验证的二进制即可，测试不会下载或编译 codeks：

```sh
CODEKS_BIN=/absolute/path/to/codex node --test test/codeks-e2e.test.ts test/catalog-e2e.test.ts test/reasoning-e2e.test.ts test/errors-e2e.test.ts test/protocol-e2e.test.ts test/compaction-e2e.test.ts
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

2026-10-18（America/Los_Angeles），补充 Claude 的 `parallel_tool_calls` 转换回归测试，覆盖客户端显式选择及原生 options 覆盖优先级。普通测试、类型检查与构建通过。

构建后实际打包并在独立目录解包，确认八份目录、文档和示例完整，CLI 与 HTTP 目录可用，包内文档相对链接及私有内容扫描通过。

### 错误路径与客户端重试

2026-10-18（America/Los_Angeles），`@openai/codex@0.163.0` 的现成二进制通过 `test/errors-e2e.test.ts` 的八个场景，上游均为本地测试服务器：

- SSE 策略拦截、预算超限、`usage_not_included`、`flex_unavailable` 保留客户端专用分类和提示，各请求一次即停止。
- HTTP 429 用量限制保留 `plan_type`、`resets_at`，客户端显示对应升级和恢复时间提示；HTTP 429 预算限制停止。
- HTTP 400 的未知错误码保留原响应体，不变成流内未知错误而触发重试。
- 未知 SSE 错误按客户端配置重试一次，bridge 收到和转发的请求均为两次，没有额外重试。

当时的普通 HTTP 测试另覆盖失败取消、错误体解压后的 header 清理、凭据失败的终止语义，以及原生错误附加字段的完整保留。这里验证客户端协议，不代表真实服务产生过上述合成错误。

### 协议细节与完整客户端回归

2026-10-18（America/Los_Angeles），补充 `test/protocol-e2e.test.ts` 的三个真实客户端场景，上游均为本地测试服务器：

- 原生 `response.incomplete` 的 `interrupted` 原因使客户端自动发起下一请求，即使配置关闭重试；已经交付的文字进入下一请求历史。
- `max_output_tokens` 原因使客户端停止当前 turn，并将上游 input、output、cache 和 reasoning usage 记入会话的 token 统计。
- Code Mode `exec` 执行两次 `notify()` 和一次最终输出，客户端实际生成三个同 call ID 的结果。Chat 出站只保留一个配对结果，另外两条作为通知，三段内容全部保留。

本轮 `@openai/codex@0.163.0` 通过上述五个文件中的全部 19 个场景，包括 HTTP 目录、工具/图片、Code Mode 与明文多代理、压缩/resume、四种摘要配置及八种错误路径。`@wacry/codeks@0.162.1-codeks.10` 另外通过 `test/codeks-e2e.test.ts` 的三个场景，继续覆盖 fork 的工具、多代理及压缩行为。

这些验证使用现成二进制，没有编译 Rust，也没有新增真实模型 API 请求。原生客户端在合成明文调用上的成功不代表它能跨模型解密真实上游生成的任务。

## 真实上游验证

真实端点的配置、鉴权、请求与响应只保存在仓库外。公开测试数据必须是合成内容，不能复制真实密钥、端点、签名、密文、对话或账号信息。

真实验证应区分：单次请求、工具回环、图片、切换模型后 reasoning 隔离、压缩后续接。原生压缩模式还需要检查同源续聊没有辅助请求，跨目标首次导出与缓存复用行为正确，文字准备完成后才发送目标请求。未允许的端点或模型使用可读摘要，允许来源且目标开启 native replay 时恢复原生压缩内容；分别测允许与不允许的配对。某一服务上的成功不代表另一服务也支持同样的字段。

### 跨模型工具历史

2026-10-26（America/Los_Angeles），用公开合成历史验证 GPT-6-Luna、官方 Claude Haiku 5.5 与 DeepSeek Flash，均使用 medium effort；Claude 探测将缓存 TTL 设为 5 分钟。每次模型切换都追加新版本的 `exec` 描述，历史同时包含别名调用和失败调用的 `cxbt1_` 载体。

- Claude 的同名工具只发送最后一份顶层定义。真实 thinking 生成后改变工具定义，下一次请求仍返回 HTTP 200，并明确报告 `thinking_dropped`、原因 `prefix_binding_mismatch`。这是接受顶层更新的实际代价，不是推理上下文无损的保证。
- Claude → DeepSeek → GPT → Claude 连续请求全部成功。GPT 的两组调用与结果 ID 均为 48 字符；切回后仍可按原载体回放，客户端输入未被改写。另一次 GPT 探测确认失败调用的保留身份与诊断可被接受。
- `test/tool-alias-e2e.test.ts` 用真实 codeks 0.164 与本地假上游，分别验证 Claude、DeepSeek 的工具执行与持久化、切到 GPT 两轮、再切回。实际客户端生成了不同版本的 `exec` 声明，转换后的工具表仅含最新定义，同时覆盖 call/result 配对与稳定 ID。

真实端点测试验证请求被接受及服务端报告；工具执行和进程重启后的恢复由客户端集成测试验证。合成签名不用于推断真实签名兼容性，短请求也不用于推断通常的缓存命中率。

### 缓存实验的边界

2026-10-19（America/Los_Angeles），透传及压缩工具选择修改通过类型检查、构建和私有内容检查；普通测试 222 项通过，20 项需显式启用的真实客户端测试跳过。HTTP 假上游覆盖三种 adapter 的未知 header、鉴权覆盖、SSE/JSON、错误诊断、handoff metadata 透传，以及意外工具调用不交付、不执行、不自动重试。上述自动化测试未调用真实模型，不据此声明缓存命中率。OpenAI 订阅端点的 state 实测依据及适用范围另见 [header 边界](responses-stream.md#header-与转发边界)。

缓存实验应保留暖身请求的完整输入，再追加新内容，避免把暖身末尾的临时问题替换成压缩 trigger。保持工具定义、工具选择、会话及路由 header 等条件与真实客户端一致；不完整的合成前缀不能代表正常会话的缓存表现。

分别记录原生检查点 `K` 的生成、后续 `U + K` 复用，以及 `U + K + handoff prompt` 复述的 input、cached input、output 和请求条件，不能用其中一次高命中推断另一类请求的成本。Responses 的 `cached_tokens` 已包含在 `input_tokens` 中，不能再次相加；聚合命中率用总 cached input 除以总 input。提示词质量另看事实保留、错误和待办完整性，不把输出长度或缓存命中率当成质量证明。

### Responses Lite 验证

2026-10-18（America/Los_Angeles）通过实际 bridge HTTP 入口完成以下验证：

- AWS GPT-6.1 Sol、Azure GPT-5.6 Sol、Claude Sonnet 5.5、DeepSeek Flash 均通过 Lite 工具往返与 reasoning 载荷回放。
- GPT 出站请求实际保留 Lite header、原位 `additional_tools`、`reasoning.context: "all_turns"` 和 `parallel_tool_calls: false`，没有增加顶层 `tools` 或改用其他协议重试。
- Claude/DeepSeek 提取完整工具声明，返回调用的身份可供客户端继续执行。
- AWS GPT 原生压缩及同目标原生检查点续聊成功。

上述场景包含 11 次成功上游请求。该轮未实测原生 OpenAI 订阅端点；官方 Codex 二进制与假上游的协议测试不能替代该端点验证。

### 配置重构验证

2026-10-18（America/Los_Angeles）通过实际 bridge HTTP 入口发送了 10 次真实上游请求：

- GPT-6.1 Sol、Claude Sonnet 5.5、DeepSeek Flash 均生成了新的 reasoning carrier，并成功完成同源 reasoning 回放。
- GPT-6.1 Sol 原生压缩成功，检查点的原生内容可供后续恢复。
- 显式允许另一连接上的 GPT-5.6 恢复该原生检查点后，bridge 确实发送了原密文；目标返回 HTTP 400 解密不兼容。原始错误完整传回，没有额外重试或改用文字摘要。

这验证配置能控制尝试的配对，不能让上游原本不兼容的密文变得兼容。Claude 对简单任务可以不生成 thinking；本次改用需要推理的任务验证载荷回放，没有把普通成功回答算作 reasoning 回放成功。

### 既有真实端点证据

2026-10-17（America/Los_Angeles）在当时的默认隔离策略下完成以下真实端点验证。这些是既有协议互操作证据，不代表新的共享配对已得到验证；每次配置共享来源仍需验证具体目标。当前代码的验证以本次运行的测试结果为准。

| 后端 | 已通过 |
| --- | --- |
| GPT Responses（两个云端连接） | reasoning 回放、跨连接切换、namespace 工具及结果、自定义 Lark 工具、图片识别、原生压缩、同连接 native 与跨连接 summary 回放 |
| Claude Messages（Opus / Sonnet） | namespace 工具、工具图片、custom regex 工具、Opus → Sonnet → Opus reasoning 隔离与恢复、带签名 reasoning 的压缩及续接、Responses JSON Schema 转 Messages 结构化 JSON 输出 |
| DeepSeek 官方 `deepseek-flash` | namespace 和 custom 工具、同模型 reasoning 工具循环、跨模型历史配空 reasoning 字段、用户/工具图片、完整文字 reasoning 重放 |

Claude 一次压缩输入 19,778 tokens，其中 19,541 命中缓存，约 98.8%；`1h` 前缀与 `5m` 末块参数被上游接受。这只验证即时命中，没有等待 1 小时测到期。DeepSeek 一次 reasoning 回放输入 1,488 tokens，其中 1,280 命中缓存。

HTTP 集成测试另外覆盖入口鉴权、响应校验、429/503/配额分类、`Retry-After`、失败时不释放工具、客户端断开取消上游，以及下游 keepalive 持续时上游依然会触发空闲超时。使用合成 checkpoint 验证过服务重启、跨后端与跨区域恢复。

完整的真实 HTTP 路径也已验证：将含 GPT 原生状态与文字摘要的 bridge checkpoint 序列化后交给 Claude 和 DeepSeek 续聊，再切回原 GPT。跨模型请求实际使用文字摘要且不含原生密文；切回请求恢复原生 checkpoint 并过滤外来 reasoning。原 GPT 正确回答了只存在于 checkpoint、此前续聊明文未出现的第二个标记，原始 carrier 保持不变。

## 检查点复述 prompt 的选择

在 OpenAI 订阅端点的 GPT-6.1 Sol 上，以 Responses Lite、`xhigh` 对比了原历史直接压缩与 `U + K` 复述。候选包括 Codex 内置 prompt、现有标准 prompt、短复述、详细复述和最终用户给定的 handoff prompt。原始请求、会话与密文保存在仓库外；这些实测用于选择 prompt，不等同于按需复述 HTTP 流程的端到端验证。

最终 prompt 的一次结果如下：

| 输入 | 文字输出 tokens | 检查结果 |
| --- | ---: | --- |
| 约 31k tokens 的开发历史，经原生压缩后复述 | 5,738 | 50 个检查项中 47 个完整、3 个部分保留，没有完全遗漏或错误项 |
| 约 215k tokens 的长历史，经原生压缩后复述 | 19,240 | 150 个已知事实均命中，其中 114 个不在保留的用户消息中；5 个未知项均未编造 |

这些结果支持使用该版本作交接复述，但每类只有一个输入，长历史的其他候选也达到同一检查上限，不能据此证明统计优势或任意历史无损。其他候选曾误述精确字段名，说明复述需要检查事实，不能仅按输出长短排序。prompt 保留用户给定措辞及 Codex 的交接主题，没有额外要求逐字还原密文，也没有强制标准文字压缩的格式。

独立的短请求验证曾观察到原生检查点前缀的高 cache hit，也观察到相同前缀、变化后缀时的低命中。`U + K` 给缓存复用提供机会；是否命中不是按需复述正确性的前提，也不作为节省用量的保证。

## 按需复述的客户端验证

`test/compaction-e2e.test.ts` 使用真实 codeks `0.162.1` 与 Codex `0.163.0` 二进制，验证 `native` 模式。上游是合成 Responses/Chat 服务，凭据与用户配置隔离，不调用真实模型端点。

测试让客户端执行工具、触发远程压缩、恢复会话并切换到 DeepSeek 目标，验证 checkpoint 持久化、原生续聊、原来源复述和目标文字恢复。同源续聊不额外请求，首次切换才导出；导出排除检查点后的工作，物化不改写客户端存储的载荷。客户端重新注入的环境上下文也进入按需复述的实际保留历史。
