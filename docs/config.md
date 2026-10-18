# 配置

`serve --config FILE` 在启动时读取 JSON。配置文件和凭据放在仓库外，完整起点见 [examples/config.json](../examples/config.json)。

## 目录、别名与连接

`upstreams` 只描述连接。`models` 的键是 codeks 显示和请求的别名，每个别名由三项配置组成：

| 字段 | 示例 | 用途 |
| --- | --- | --- |
| `catalog` | `gpt-6.1-sol` | 选择已审阅的模型条目，包括提示词、能力、默认参数与 adapter |
| `upstream` | `primary` | 选择连接、鉴权和区域 |
| `model` | `deployment-a` | 实际发给上游的模型或部署名 |

当前支持的八个 key 见[模型目录](../catalog/README.md)。没有通用兜底条目，未知 key 在加载配置时报错。实际部署名无需与 key 相同，也不用于推断协议。

| 目录模型 | 条目指定的 adapter | 上游路径 |
| --- | --- | --- |
| GPT 系列 | [`gpt-responses`](backends-responses.md) | `/responses` |
| Claude Opus / Sonnet | [`claude-messages`](backends-anthropic.md) | `/messages` |
| DeepSeek Flash | [`deepseek-chat`](backends-deepseek-chat.md) | `/chat/completions` |

同一个兼容网关的连接可供不同条目使用。服务按每条请求的别名独立选路，因此父代理、子代理和并行会话可以同时使用不同上游。别名固定对应一个目标，不做上游模型发现或自动负载均衡。

多个别名也可选择同一目录条目和部署，仅设置不同的窗口预算：

```json
{
  "gpt-small": {
    "catalog": "gpt-6.1-sol", "upstream": "primary", "model": "deployment-a",
    "context_window": 272000
  },
  "gpt-large": {
    "catalog": "gpt-6.1-sol", "upstream": "primary", "model": "deployment-a",
    "context_window": 872000
  }
}
```

窗口值只是客户端预算，实际部署必须支持该值。同一连接、adapter 和部署的状态身份相同，不因别名或窗口预设而变化。

## 服务

| 字段 | 含义 |
| --- | --- |
| `host` | 默认 `127.0.0.1` |
| `port` | 默认 `8787`；程序集成测试可用 `0` 分配端口 |
| `token_env` | 保存 bridge 入口 Bearer token 的环境变量名称 |
| `upstreams` | 上游连接配置表 |
| `models` | 客户端模型别名表 |

监听非 loopback 地址时必须配置 `token_env`，客户端也要设置同一个变量。它是 bridge 入口鉴权，不是上游 API key。HTTP 请求体最多 64 MiB，包含所有图片编码；入口没有 CORS。`GET /health`、`GET /v1/models` 和 `POST /v1/responses` 使用同一鉴权。

## 上游连接

| 字段 | 含义 |
| --- | --- |
| `base_url` | 包含版本前缀的 HTTP(S) URL；adapter 在其后追加请求路径 |
| `api_key_env` | API key 环境变量名称 |
| `api_key_command` | 与 `api_key_env` 二选一；argv 数组，程序 stdout 返回当前凭据 |
| `auth_header` | 覆盖鉴权 header 名；默认 GPT/DeepSeek 用 `authorization: Bearer …`，Claude 用 `x-api-key` |
| `stream_idle_timeout_ms` | 等待上游 headers 或后续字节的最长空闲时间，默认 300000 ms |
| `headers` | 静态额外 header，例如 API 版本 |
| `options` | 原生请求参数，覆盖 adapter 推导出的参数 |

`api_key_command` 不经过 shell，每条上游请求执行一次，最多 30 秒，适合短期凭据。命令错误不会把 stdout/stderr 回传客户端。连接无需 key 的服务时可省略凭据设置。Claude 默认版本 header 为 `anthropic-version: 2023-06-01`。

## 模型

| 字段 | 含义 |
| --- | --- |
| `upstream` | 连接表中的 ID；不同区域或凭据域使用不同 ID |
| `model` | 实际上游模型名；可以是部署别名 |
| `catalog` | 必填，已审阅条目的 key；条目决定 adapter |
| `context_window` | 可选窗口预算；设置时同时覆盖客户端的 `context_window` 和 `max_context_window` |
| `max_output_tokens` | 默认回答输出上限；请求中的显式值优先于此默认值 |
| `input_modalities` | 可选，覆盖条目中的 `text`/`image` 能力声明 |
| `reasoning` | 默认 effort 及其到原生值的映射 |
| `replay` | 分别允许哪些来源的 reasoning、原生压缩 |
| `compaction` | 本目标如何生成压缩，以及是否接收原生压缩 |
| `options` | 原生请求参数，覆盖上游级 options |

不设置窗口时，原条目的两个窗口字段各自保留。当前 GPT 条目为 `context_window: 272000`、`max_context_window: 872000`；第三方条目默认工作预算为 `131072`，并非上游容量上限。

请求先由 adapter 转换，再浅层合并 `upstream.options`、`model.options`；后者优先，嵌套对象整体替换。例如模型 `options.output_config` 会替换推导值和上游同名对象。由此可以显式调整 thinking budget、原生 effort 或端点专有字段。

最终由 bridge 固定模型路由、转换后的历史、工具定义、流模式和必要协议字段。摘要请求固定禁止调用工具并移除结构化输出约束；原生压缩移除普通回答的输出上限。这些字段承载桥接契约，不由 options 改写。详见上表链接的后端文档。

## Reasoning 与模型目录

```json
{
  "reasoning": {
    "default_effort": "high",
    "effort_map": { "low": "low", "high": "high", "max": "max" }
  },
  "input_modalities": ["text", "image"]
}
```

`effort_map` 的键是 codeks 可选档位，值是发给上游的原生值。提供映射时完整替换目录条目的默认映射；`default_effort` 必须出现在映射中。未指定默认档位时，保留映射中仍存在的条目默认值，否则选映射第一项。`none` 映射为原生 `none` 时，Claude/DeepSeek 关闭 thinking。

请求没有 effort 时使用配置默认值；有映射则转换，未列出的显式 effort 直接透传，交给上游判断。catalog 与实际请求使用同一份配置；通过原生 `options` 再覆盖 thinking/effort 时，应同时调整这里的展示设置。

codeks 的 `ultra` 是客户端特殊档位：优先使用条目的 `multi_agent_reasoning_effort`，未配置时按客户端规则选择 `max` 或其他可用普通档位。GPT 条目保留各自原值；例如 GPT-6.1 Sol 使用 `xhigh`，不会统一改为 `max`。若显式覆盖 `effort_map` 并提供 `ultra`，映射中还须有一个非 `ultra`/`persistent` 档位指向相同原生值；bridge 据此填写客户端字段，不能表达时明确报错。例如 `ultra: "max"` 与 `max: "max"` 配对。直接 HTTP 请求中的未知 effort 仍按上述规则透传。

`input_modalities` 用于客户端能力声明，不是 bridge 的模型能力预检。bridge 负责转换能表达的输入，具体模型能否处理由上游裁决。

## 状态复用

以下模型片段演示 B 接受 A 的原生压缩，但仍隔离 reasoning。实际部署名是占位示例，配对是否可用须由真实端点验证。

```json
{
  "gpt-a": {
    "upstream": "primary",
    "model": "deployment-a",
    "catalog": "gpt-6.1-sol",
    "context_window": 272000
  },
  "gpt-b": {
    "upstream": "secondary",
    "model": "deployment-b",
    "catalog": "gpt-6.1-sol",
    "context_window": 272000,
    "replay": {
      "reasoning_from": [],
      "native_compaction_from": ["gpt-a"]
    },
    "compaction": { "mode": "summary", "native_replay": true }
  }
}
```

自身状态默认允许恢复；两份列表增加其他允许来源，关系有方向且不传递。若也要接受 A 的 reasoning，把 A 加入 B 的 `reasoning_from`。这个例子的 B 自己只生成文字摘要，但仍可读取 A 的原生检查点：生成和恢复是独立能力。设置 `native_replay: false` 则所有压缩都使用文字表示，包括自身生成的检查点。

引用在加载配置时解析为来源身份，按连接、实际模型和 adapter 比较，不绑定显示别名。bridge 检查来源是否存在、载荷格式是否可解码，不探测密文是否被上游接受。上游拒绝被允许的状态时直接报错，不删掉状态再试。详见 [reasoning](reasoning.md) 和[压缩](compaction.md)。

连接身份包含 upstream ID 和去掉末尾斜杠的 URL，来源身份再包含 adapter 与实际模型。密钥、header 和 options 不参与身份。如果同一 URL 通过 header 或凭据切换到不兼容区域，使用不同 upstream ID；改显示别名不影响已保存状态。

## 客户端目录

bridge 的 `GET /v1/models` 返回 Codex 专用的 `{"models": [...]}`，每项包含完整提示词、窗口、工具、多代理和 reasoning 元数据。它与经典 OpenAI 的 `{"object":"list","data":[...]}` 格式不同。仅列出配置中的别名，不暴露上游连接、实际部署名或凭据设置。

这些条目来自仓库内已审阅的 [catalog](../catalog/README.md)，运行时只展开别名和显式配置覆盖。GPT 分别使用自己的 Codex 源码条目；Claude 和 DeepSeek 使用经过精调的 GPT-6.1 Sol 模板。不会启动 codeks 导出模板，也不请求订阅账号的模型目录。目录版本随 bridge 代码更新，升级客户端不会自动改写它。

### HTTP 发现

```sh
node dist/cli.js config-snippet --config /absolute/path/bridge.json
```

默认输出 `model_providers.bridge.model_catalog_url`，指向 bridge 的 `/v1/models`。只设置 `base_url` 不足以让自定义 provider 使用这份目录。codeks 的 API key 模型发现功能默认启用；若用户配置关闭了 `api_key_model_discovery`，需要重新启用。

配置了 `token_env` 时，片段用 `env_key` 传递 bridge 入口凭据。匿名 loopback 服务使用公开标记 `experimental_bearer_token = "codeks-bridge-local"`，让 codeks 进入 API key 目录发现流程。这个固定字符串不是密钥，也不为服务提供鉴权；需要入口鉴权时应配置 `token_env`。

provider 显示名为 `Local bridge`，并显式声明 `[model_providers.bridge.capabilities] remote_compaction = "v2"`，无需借用 Azure 或 OpenAI 名称触发能力。片段关闭 `web_search` 和 `features.image_generation`，图片输入仍然支持。

目录响应带 `ETag`，普通响应带同值的 `x-models-etag`。服务配置修改后重启 bridge，新内容的标记会让客户端刷新模型目录；客户端也有定时缓存刷新。当前 Codex 的目录请求限制为 1 MiB、5 秒且不跟随重定向。每个别名都包含完整提示词，大量窗口或部署别名会增大响应。

顶层 `model_catalog_json` 的优先级高于 HTTP 目录。若已有该配置，迁移时移除它，再重载客户端配置。

### 静态文件

需要固定本地快照时，可导出相同的完整目录：

```sh
node dist/cli.js catalog --config /absolute/path/bridge.json \
  --output /absolute/path/models.json
node dist/cli.js config-snippet --config /absolute/path/bridge.json \
  --catalog /absolute/path/models.json
```

这种模式通过顶层 `model_catalog_json` 读取文件。模型列表或参数修改后，需要重新导出并重载客户端配置。

维护者更新源模板、审查差异和新增受支持 key 的步骤见[目录更新流程](../catalog/README.md#更新流程)。
