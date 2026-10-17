# 配置

`serve --config FILE` 读取 JSON；配置文件以及凭据放在仓库外。完整例子见 [examples/config.json](../examples/config.json)。

## 服务

| 字段 | 含义 |
| --- | --- |
| `host` | 默认 `127.0.0.1` |
| `port` | 默认 `8787`；程序集成测试可用 `0` 分配端口 |
| `token_env` | 可选，保存 bridge 入口 Bearer token 的环境变量名称 |
| `upstreams` | 上游连接配置表 |
| `models` | 客户端模型别名表 |

监听非 loopback 地址时必须配置 `token_env`，客户端也要设置同一个变量。它是 bridge 入口鉴权，不是上游 API key。HTTP 请求体最多 64 MiB，包含所有图片编码；入口没有 CORS。`GET /health`、`GET /v1/models` 和 `POST /v1/responses` 使用同一鉴权。

## 上游连接

| 字段 | 含义 |
| --- | --- |
| `api` | `responses`、`anthropic` 或 `chat` |
| `base_url` | 包含版本前缀的 URL；后端追加 `responses`、`messages` 或 `chat/completions` |
| `api_key_env` | API key 环境变量名称 |
| `api_key_command` | 与 `api_key_env` 二选一；argv 数组，程序 stdout 返回当前凭据 |
| `auth_header` | 默认 Responses/Chat 用 `authorization: Bearer …`，Anthropic 用 `x-api-key`；可覆盖 header 名 |
| `stream_idle_timeout_ms` | 等待上游 headers 或后续字节的最长空闲时间，默认 300000 ms；下游 keepalive 不会延长它 |
| `headers` | 静态额外 header，可设置 API 版本；秘密值优先通过凭据机制提供 |
| `options` | 后端请求选项，细节见对应后端文档 |

`api_key_command` 不经过 shell，每条上游请求执行一次，以便使用可刷新的短期凭据；命令最多执行 30 秒。命令错误不会把 stdout/stderr 回传客户端。也可省略两种凭据设置，连接本地或其他无需 key 的服务。默认 Anthropic 版本为 `2023-06-01`。

## 模型

| 字段 | 含义 |
| --- | --- |
| `upstream` | 连接表中的 ID；不同区域或凭据域应使用不同 ID |
| `model` | 实际发给上游的模型名 |
| `context_window` | 客户端模型目录的窗口大小，生成 catalog 时必填 |
| `max_output_tokens` | 默认输出上限，客户端显式值优先 |
| `options` | 覆盖上游级默认选项；模型路由、历史与流模式由 bridge 负责 |

更改连接 ID、端点或模型会改变 reasoning 身份。单纯改显示别名不会改变它。若同一 URL/模型通过 header 路由不同区域，请为每个区域建立不同 upstream ID，以隔离 reasoning。

GPT 原生压缩优先跨目标复用；密文被拒绝后，成功使用摘要的记录按 turn、当前目标和 checkpoint 隔离。目标还包括静态 headers、上游 options 和模型 options，因此用选项表示的区域变化也会重新尝试。这个策略没有额外配置项，详见 [compaction.md](compaction.md)。

## 客户端

`catalog` 调用当前客户端的 `debug models --bundled`；可通过 `--codeks PATH` 指定二进制，或用 `--bundled FILE` 读取已导出的 JSON。`--template SLUG` 选择模板；默认选第一个可见的 V2 多代理模型。目录沿用客户端指令与工具能力，设置实际别名和窗口，关闭 Lite、web search 宣告及不通用的服务优先级。升级客户端后重新生成。

`config-snippet --catalog ABSOLUTE_PATH` 输出 TOML。顶层 `model`、`model_provider`、`model_catalog_json`、`web_search` 需放在表定义前。`[model_providers.bridge.capabilities] remote_compaction = "v2"` 是必须的；没有实现旧版 `/responses/compact` 接口。

配置示例选用较保守的窗口，并非声明模型上限。应根据端点文档设置实际限制。调整运行配置后重启服务，客户端目录中的窗口需重新生成。
