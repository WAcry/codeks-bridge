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
- 流：跨字节分块的 UTF-8、CR/LF、SSE 多行数据、结束标记、非法 JSON。
- Responses 输出：先 added 后 delta/done、完整历史项、usage、reasoning carrier、消息 phase、明文多代理参数、重试提示、失败时不执行尚未提交的工具。
- 后端与历史：各 API 的消息、工具、图片、reasoning、压缩及错误转换。专项测试与转换实现放在同一轮审查。

这些测试检查协议和客户端行为；假上游不会验证模型是否理解提示词，也不会验证真实服务的缓存命中率、容量和区域之间的密文兼容性。

## 使用真实 codeks 二进制

可选集成测试启动已经安装的 codeks，并让它通过桥接器访问本地假 Chat 上游。指定要验证的二进制即可，测试不会下载或编译 codeks：

```sh
CODEKS_BIN=/absolute/path/to/codex node --test test/codeks-e2e.test.ts
```

未设置 `CODEKS_BIN` 时，这些测试自动跳过。它们为每个场景创建独立的 `CODEX_HOME` 和工作目录，监听随机的回环端口。临时目录路径会写入测试输出，保留会话和进程输出便于复查。退出时关闭本轮创建的服务器。

以 `@wacry/codeks@0.162.1-codeks.10` 的现成 Linux 二进制验证了以下场景：

| 场景 | 实际检查 |
| --- | --- |
| 普通工具与图片 | codeks 执行 shell 和 `apply_patch`；文件内容正确；用户附图与 `view_image` 结果都进入 Chat 图片字段 |
| Code Mode 与多代理 V2 | 自定义 `exec` 执行；namespace 工具回传；明文 `spawn_agent` 创建真实子代理；子代理收到任务，父代理收到最终答复 |
| 远程压缩 V2 | 高 usage 触发 `compaction_trigger`；桥接器生成可回放摘要；codeks 替换旧工具历史；退出后 resume 仍读到摘要 |

模型目录来自被测二进制的 `debug models --bundled`。测试将 `use_responses_lite` 设为 `false`，让请求携带可转换的工具 schema；Code Mode 与多代理 V2 属性继续由原目录提供。测试不依赖固定的 namespace 拼写。

## 真实上游验证

真实端点的配置、鉴权、请求与响应只保存在仓库外。公开测试数据必须是合成内容，不能复制真实密钥、端点、签名、密文、对话或账号信息。

真实验证应区分：单次请求、工具回环、图片、切换模型后 reasoning 隔离、压缩后续接。Responses 的双重压缩还需要检查两个分支都成功后才提交结果；换端点或模型时使用可读摘要，同端点同模型时才恢复原生压缩内容。某一服务上的成功不代表另一服务也支持同样的字段。

### 本轮实测结果

2026-10-17（America/Los_Angeles）最终检查通过：90 个测试全部通过（含 3 个真实 codeks 进程测试，无跳过），TypeScript 检查、构建和公开内容检查通过。完成了下列真实端点验证。结果是协议互操作证据，不是模型任务质量排名，也不代表其他端点默认兼容。

| 后端 | 已通过 |
| --- | --- |
| GPT Responses（两个云端连接） | reasoning 回放、跨连接切换、namespace 工具及结果、自定义 Lark 工具、图片识别、双压缩、同连接 native 与跨连接 summary 回放 |
| Claude Messages（Opus / Sonnet） | namespace 工具、工具图片、custom regex 工具、Opus → Sonnet → Opus reasoning 隔离与恢复、带签名 reasoning 的压缩及续接、Responses JSON Schema 转 Messages 结构化 JSON 输出 |
| DeepSeek 官方 `deepseek-flash` | namespace 和 custom 工具、同模型 reasoning 工具循环、跨模型历史配空 reasoning 字段、用户/工具图片、完整文字 reasoning 重放 |

Claude 一次压缩输入 19,778 tokens，其中 19,541 命中缓存，约 98.8%；`1h` 前缀与 `5m` 末块参数被上游接受。这只验证即时命中，没有等待 1 小时测到期。DeepSeek 一次 reasoning 回放输入 1,488 tokens，其中 1,280 命中缓存。

HTTP 集成测试另外覆盖入口鉴权、响应校验、429/503/配额分类、`Retry-After`、失败时不释放工具、客户端断开取消上游，以及下游 keepalive 持续时上游依然会触发空闲超时。使用合成 checkpoint 验证过服务重启、跨后端与跨区域恢复。

完整的真实 HTTP 路径也已验证：经 bridge 生成 GPT 双压缩 checkpoint，序列化后交给 Claude 和 DeepSeek 续聊，再切回原 GPT。跨模型请求实际使用文字摘要且不含原生密文；切回请求恢复原生 checkpoint 并过滤外来 reasoning。原 GPT 正确回答了只存在于 checkpoint、此前续聊明文未出现的第二个标记，原始 carrier 保持不变。
