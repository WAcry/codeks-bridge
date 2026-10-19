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
| `compaction_cache_dir` | 按需复述缓存目录；默认 `$XDG_CACHE_HOME/codeks-bridge/compaction`，未设置 XDG 时为 `~/.cache/codeks-bridge/compaction` |
| `upstreams` | 上游连接配置表 |
| `models` | 模型别名表，是否进入客户端目录由各自的 `expose` 控制 |
| `inspect` | 可选；`capture` 决定启动时是否捕获，`max_mib` 是内存软上限，见[调试检查器](inspect.md) |

监听非 loopback 地址时必须配置 `token_env`，客户端也要设置同一个变量。它是 bridge 入口鉴权，不是上游 API key。HTTP 请求体最多 64 MiB，包含所有图片编码；入口没有 CORS。携带 `Origin` 的请求必须使用配置好的 bridge token，即使监听 loopback 也一样，避免网页的简单 POST 在无法读取响应时仍触发上游调用。没有 `Origin` 的 codeks 请求保持原行为。`GET /health`、`GET /v1/models` 和 `POST /v1/responses` 使用同一鉴权。`/inspect/` 页面与接口使用[自己的规则](inspect.md#访问与鉴权)。

## 上游连接

| 字段 | 含义 |
| --- | --- |
| `base_url` | 包含版本前缀的 HTTP(S) URL；adapter 在其后追加请求路径 |
| `api_key_env` | API key 环境变量名称 |
| `api_key_command` | 与 `api_key_env` 二选一；argv 数组，程序 stdout 返回当前凭据 |
| `auth_header` | 覆盖鉴权 header 名；默认 GPT/DeepSeek 用 `authorization: Bearer …`，Claude 用 `x-api-key` |
| `stream_idle_timeout_ms` | 等待上游 headers 或后续字节的最长空闲时间，默认 300000 ms |
| `headers` | 静态 header，覆盖同名客户端 header，例如 API 版本 |
| `options` | 原生请求参数，覆盖 adapter 推导出的参数 |

`api_key_command` 不经过 shell，每条上游请求执行一次，最多 30 秒，适合短期凭据。命令错误不会把 stdout/stderr 回传客户端。连接无需 key 的服务时可省略凭据设置。Claude 默认版本 header 为 `anthropic-version: 2023-06-01`。客户端 metadata 默认透传，鉴权使用上游配置；覆盖顺序及必要过滤见 [header 边界](responses-stream.md#header-与转发边界)。

## 模型

| 字段 | 含义 |
| --- | --- |
| `upstream` | 连接表中的 ID；不同区域或凭据域使用不同 ID |
| `model` | 实际上游模型名；可以是部署别名 |
| `catalog` | 必填，已审阅条目的 key；条目决定 adapter |
| `expose` | 默认 `true`；设为 `false` 时不进入客户端 HTTP 目录和 CLI 导出的静态目录 |
| `context_window` | 可选窗口预算；设置时同时覆盖客户端的 `context_window` 和 `max_context_window` |
| `max_output_tokens` | 覆盖目录的默认回答输出预算；请求中的显式值优先于模型配置 |
| `input_modalities` | 可选，覆盖条目中的 `text`/`image` 能力声明 |
| `reasoning` | 默认 effort 及其到原生值的映射 |
| `replay` | 分别允许哪些来源的 reasoning、原生压缩 |
| `compaction` | 压缩方式、执行模型，以及本目标是否接收原生压缩 |
| `options` | 原生请求参数，覆盖上游级 options |

`expose` 控制目录展示，不改变别名的路由、来源身份或访问权限。隐藏模型仍可用于压缩、handoff 和状态复用，显式按别名发送请求也仍可调用；inspector 保留其诊断记录。`config-snippet` 选择首个公开别名作为默认模型；全部隐藏时目录为空，该命令明确报错。

不设置窗口时，原条目的两个窗口字段各自保留。当前 GPT 条目为 `context_window: 272000`、`max_context_window: 872000`；Opus 5.5、Sonnet 5.5 和 DeepSeek Flash 的两个字段均为 `1000000`。压缩阈值沿用模板的 `auto_compact_token_limit: null`，由客户端按窗口计算。Claude Messages 必须提供 `max_tokens`，对应目录外层默认预算为 `128000`；GPT 和 DeepSeek 使用请求、模型配置或上游提供的默认值。原生 options 也可调整预算，实际限制由部署端点裁决。

请求先由 adapter 转换，再浅层合并 `upstream.options`、`model.options`；后者优先，嵌套对象整体替换。例如模型 `options.output_config` 会替换推导值和上游同名对象。由此可以显式调整 thinking budget、原生 effort 或端点专有字段。

最终由 bridge 固定模型路由、转换后的历史、工具定义、流模式和必要协议字段。摘要请求保留普通工具选择并移除结构化输出约束；原生压缩移除普通回答的输出上限。必须重建的字段承载桥接契约，不由 options 改写。详见上表链接的后端文档，以及[摘要的工具选择](compaction.md#工具选择与缓存)。

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

`effort_map` 的键是 codeks 可选档位，值是发给上游的原生值。提供映射时完整替换目录条目的默认映射；`default_effort` 必须出现在映射中。未指定默认档位时，保留映射中仍存在的条目默认值，否则选映射第一项。映射为原生 `none` 时，Messages/DeepSeek adapter 发送 `thinking.type: "disabled"`，是否接受由上游决定。Claude 5.5 目录不提供这个档位；Sonnet 的 `between_tools` 模式可通过显式 options 选择，含义和配置见 [Messages](backends-anthropic.md)。

请求没有 effort 时使用配置默认值；有映射则转换，未列出的显式 effort 直接透传，交给上游判断。catalog 与实际请求使用同一份配置；通过原生 `options` 再覆盖 thinking/effort 时，应同时调整这里的展示设置。

codeks 的 `ultra` 是客户端特殊档位：注入多代理提示词，并优先使用条目的 `multi_agent_reasoning_effort`，未配置时按客户端规则选择 `max` 或其他可用普通档位。GPT 条目保留各自原值；GPT-6.1 Sol 和 Opus 5.5 使用 `xhigh`，Sonnet 5.5 和 DeepSeek Flash 使用 `max`。若显式覆盖 `effort_map` 并提供 `ultra`，映射中还须有一个非 `ultra`/`persistent` 档位指向相同原生值；bridge 据此填写客户端字段，不能表达时明确报错。例如 `ultra: "max"` 与 `max: "max"` 配对。直接 HTTP 请求中的未知 effort 仍按上述规则透传。

摘要显示由 codeks 的顶层配置控制，bridge 不强制打开：

```toml
model_reasoning_summary = "auto"
```

也可选择 `concise`、`detailed` 或 `none`。Claude 和 DeepSeek 目录沿用 GPT-6.1 Sol 的 `default_reasoning_summary: "none"`；客户端配置为 `none` 时省略请求的 summary 字段。bridge 对缺省或 `none` 不展示可见摘要，对其他上述值请求或展示可用内容；Claude 使用原生 summarized 显示，DeepSeek 展示原生 reasoning 文本。它不承诺所有模型区分摘要长度，也不因此关闭实际推理或历史载荷回放。

`input_modalities` 用于客户端能力声明，不是 bridge 的模型能力预检。bridge 负责转换能表达的输入，具体模型能否处理由上游裁决。

## 压缩模式与执行模型

`models.<别名>.compaction.mode` 可选择 `summary` 或 `native`。默认值取自工作模型：GPT 默认 `native`，Claude/DeepSeek 默认 `summary`。`compaction.model` 可引用另一个已配置的模型别名，让它执行压缩；省略时由工作模型自己执行。两项独立，仅设置执行模型不会改变模式。

GPT 的默认配置等价于：

```json
{ "compaction": { "mode": "native", "native_replay": true } }
```

`native` 初始只生成原生检查点；目标无法按来源策略回放它时，先向生成检查点的模型和连接复述为文字。原来源须继续在配置中可用。成功摘要及辅助 usage 存入顶层 `compaction_cache_dir`，重启后可复用；它不是上游 prompt cache。`summary` 继续使用标准 prompt 直接压缩原历史。

例如让 Claude 的历史由 GPT 原生压缩，再按需复述给 Claude：

```json
{
  "models": {
    "claude": {
      "catalog": "claude-opus-5-5", "upstream": "anthropic", "model": "claude-opus-5-5",
      "compaction": { "mode": "native", "model": "gpt-compactor" }
    },
    "gpt-compactor": {
      "catalog": "gpt-6.1-sol", "upstream": "openai", "model": "gpt-6.1-sol",
      "expose": false,
      "reasoning": { "default_effort": "xhigh" }
    }
  }
}
```

这里的 `anthropic` 和 `openai` 使用已有 `upstreams` 连接。`gpt-compactor` 通过 `expose: false` 隐藏于客户端目录，仍复用普通模型配置，不需要另一套压缩器注册表。压缩只跟随一次 `compaction.model`，不继续读取执行模型自己的委托配置或生成模式。工作模型的窗口与压缩阈值仍决定何时压缩，执行模型须能接收实际历史；超限由上游报错。

未设置 `compaction.model` 或显式引用自身别名时，沿用请求的 reasoning effort；引用其他别名时使用执行别名的 `reasoning.default_effort`，未设置则使用它的目录默认值，再按该模型的映射转换。即使两个别名指向同一部署，也可用专用压缩别名选择不同默认 effort。复述配方保留选定的请求 effort，后续切换工作模型不改变它。显式原生 options 仍按普通请求的规则覆盖推导参数；后续修改原来源的 options 也会作用于复述，它们不作为快照固化。

Claude 的 `native_replay` 仍默认为 `false`：委托生成不会让 Claude 获得读取 GPT 密文的能力。`native` 要求执行模型的 adapter 支持原生压缩格式；`native_replay` 则要求工作模型能恢复该格式。它们与[状态复用](#状态复用)的来源策略独立。完整时序、失败及用量规则见[压缩](compaction.md)。

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

引用按连接、实际模型和 adapter 解析为来源身份，不绑定显示别名。加载配置时检查来源是否存在、源与目标的格式标识是否一致；每条请求恢复时再检查实际载荷。bridge 不探测密文是否被上游接受。上游拒绝被允许的状态时直接报错，不删掉状态再试。详见 [reasoning](reasoning.md) 和[压缩](compaction.md)。

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

片段还设置 `[features.multi_agent_v2] tool_namespace = "agents"`。在默认的保留 namespace `collaboration` 下，`spawn_agent`、`send_message` 和 `followup_task` 的 `message` 带 `encrypted` 标记，GPT 上游会把子代理任务写成密文。GPT 父代理创建的 Claude 或 DeepSeek 子代理只能收到读不懂的密文，会话记录和请求日志里也看不到任务内容。改用其他 namespace 后，codeks 去掉这个标记并按明文投递消息（见 [codeks patch 0005](https://github.com/WAcry/codeks/blob/main/fork/patches/0005-plaintext-agent-messages.md)），任何模型的子代理都能读懂任务，日志中也能看到原始 prompt。没有这个补丁的 Codex 只会改变工具名，消息仍然加密。

这张表不写 `enabled`，只修改 namespace；多代理 V2 是否启用仍由目录的 `multi_agent_version` 和已有配置决定。若已有配置在 `[features]` 下写了 `multi_agent_v2 = true`，合并时改为在 `[features.multi_agent_v2]` 中写 `enabled = true`，因为同一个 TOML 文件不能把同一个键同时写成值和表。

bridge 使用 HTTP/SSE。已核对 Codex `0.163.0` 的 `codex-rs/model-provider-info/src/lib.rs` 与 `codex-rs/core/src/client.rs`：自定义 provider 的 `supports_websockets` 默认为 `false`，生成的片段沿用该默认值；目录中的 `prefer_websockets: true` 保留源条目原值，不会越过 provider 的能力开关。若将片段合并到已有 provider 配置，应确认没有遗留的 `supports_websockets = true`。今后接入 WebSocket 时需实现相应传输契约，而不只是修改目录偏好。

目录响应带 `ETag`，普通响应带同值的 `x-models-etag`。服务配置修改后重启 bridge，新内容的标记会让客户端刷新模型目录；客户端也有定时缓存刷新。当前 Codex 的目录请求限制为 1 MiB、5 秒且不跟随重定向。每个别名都包含完整提示词，大量窗口或部署别名会增大响应。超过 1 MiB 时，HTTP 目录返回明确的 413 错误，不删减条目；模型请求和静态目录导出仍可用。可减少别名，或使用下方的静态 `model_catalog_json` 方案。这是客户端接口的固定限制，不是上游模型能力预检。

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
