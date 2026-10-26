# 订阅搜索

`web_search: { "upstream": "chatgpt" }` 显式启用独立搜索，引用已有的 `auth.type: "chatgpt"` 连接。省略配置时关闭。登录沿用 `codex login`，token 与账号 ID 的读取、续期和 HTTP 401 恢复复用[订阅鉴权](backends-responses.md#订阅凭据与续期)。完整配置见 [ChatGPT＋Claude 示例](../examples/chatgpt-claude.json)。

## 客户端与路由

配置搜索后，重新运行 `config-snippet`，将输出合并到客户端配置。关键项为：

```toml
web_search = "live"

[model_providers.bridge]
supports_standalone_web_search = true
```

片段还包含原有的端点、目录与其他能力设置。`supports_standalone_web_search` 是 provider 级能力，不是模型目录字段；当前 Lite 模型可直接使用，bridge 不修改目录中的 `supports_search_tool`。搜索模式可由客户端另行选择 `cached` 或 `indexed`，对应的设置仍原样转发；上述生成片段默认使用 `live`。

工作模型调用 `web.run` 后，codeks 将命令发送到 `POST /v1/alpha/search`。bridge 用指定订阅连接调用 `<base_url>/alpha/search`，所有工作模型共享该连接。请求里的 `model` 保持原值，不据此切换搜索连接，也不需要配置额外的 GPT 模型。

bridge 保留请求的 `id`、`commands`、`input`、`settings`、输出预算及未知字段，保留响应正文、HTTP 状态与诊断 header；传输和鉴权字段使用已有的[边界规则](responses-stream.md#header-与转发边界)。搜索不经过模型 adapter 的历史转换、reasoning 筛选或压缩。失败直接交回客户端，不自动换搜索来源。

## 返回内容与上下文

订阅端点返回 JSON，其中 `output` 是可读结果，`results` 是结构化结果，另可带 `encrypted_output`。bridge 原样传回这些字段。当前 codeks 将 `output` 写入普通工具结果，`results` 用于搜索事件；这条客户端路径没有使用 `encrypted_output`。因此 GPT、Claude 和 DeepSeek 都能通过现有工具结果路径读取搜索内容，不需要解密或额外生成摘要。Code Mode 中同样可以使用 `text(await tools.web__run(...))`。

搜索请求不只有关键词。当前 codeks 的 `input` 保留最近两条真实用户文字消息，以及其间最多约 1K tokens 的 assistant 文字，不包含完整 reasoning、compaction 或工具历史。这部分正文随搜索请求发送到所选订阅连接。

上述客户端契约依据 Codex `rust-v0.164.0` 的 [WebSearchTool](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/web-search/src/tool.rs)、[SearchOutput](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/web-search/src/output.rs) 和[搜索上下文选择](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/web-search/src/history.rs)。升级客户端时应复核这些边界。

## 引用与命令

`search_query` 返回的 `ref_id` 可用于后续 `open`、`find`；打开页面中的编号链接可用于 `click`。bridge 不维护网页或引用映射，保留客户端的 `id`，让订阅端点处理搜索会话。工作模型切换时搜索连接保持不变，已返回的明文继续留在客户端历史中。

服务端引用的有效期，以及变更账号或端点后的兼容性由上游决定，不能保证旧引用永久可用。失败保留上游反馈，不能通过换账号或换来源假定引用仍然有效。

工具 schema 来自 codeks，bridge 不另写命令白名单。图片搜索、PDF 截图、天气等客户端已有命令也按同一路径转发；具体是否可用由订阅端点裁决。

## 验证范围

2026-10-25（America/Los_Angeles），使用订阅端点与公开 Python asyncio 文档查询完成直接 API 探测：

| 请求中的 model | 操作 | 结果 |
| --- | --- | --- |
| `gpt-6.1-sol` | `search_query` → `open` → `find` | 全部 HTTP 200，返回明文 |
| `claude-sonnet-5-5` | `search_query` → `open` → `click` → `find` | 全部 HTTP 200，返回明文 |
| `deepseek-flash` | `search_query` | HTTP 200 |
| 一个合成模型别名 | `search_query` | HTTP 200 |

连续操作保留同一个搜索 `id`，直接使用前次结果的引用，没有先调用 `/responses`、重放搜索密文或传回前次搜索正文。结果支持原样透传 `model`，没有理由强制替换为固定 GPT 名称；不表示服务端承诺接受任意未来值。

随后通过本次 bridge 实现再次执行 `click`：保留原搜索 `id`，把请求模型改为客户端别名 `claude`，成功从 asyncio 首页进入另一篇 Coroutines and Tasks 文档，HTTP 200。订阅登录文件未改变。

[真实客户端测试](../test/search-e2e.test.ts)另用 codeks 二进制、模拟 Claude 推理和模拟搜索端点，验证 Code Mode 连续 search/open/click、稳定的搜索 `id`、模型别名透传，以及明文结果进入 Claude 工具历史而密文不进入。该测试不调用真实模型。

这些验证没有调用真实 Claude 或 DeepSeek 推理，也没有验证全部命令、长期引用有效期、跨账号引用或 OpenAI 公开 API 的 `/v1/alpha/search`。真实凭据、密文与原始响应保存在仓库外，公开仓库只记录可复核的结论与边界。
