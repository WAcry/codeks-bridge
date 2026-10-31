# 配置

`serve --config FILE` 在启动时读取 JSON。配置文件和凭据放在仓库外，完整起点见 [examples/config.json](../examples/config.json)。

## 目录、别名与连接

`upstreams` 描述连接、鉴权及该连接共用的 adapter 设置。`models` 的键是 codeks 显示和请求的别名，每个别名由三项配置组成：

| 字段 | 示例 | 用途 |
| --- | --- | --- |
| `catalog` | `gpt-6.1-sol` | 选择已审阅的模型条目，包括提示词、能力、默认参数与 adapter |
| `upstream` | `primary` | 选择连接、鉴权和区域 |
| `model` | `deployment-a` | 实际发给上游的模型或部署名 |

当前支持的 key 见[模型目录](../catalog/README.md)。没有通用兜底条目，未知 key 在加载配置时报错。实际部署名无需与 key 相同，也不用于推断协议。

| 目录模型 | 条目指定的 adapter | 上游路径 |
| --- | --- | --- |
| GPT 系列 | [`gpt-responses`](backends-responses.md) | `/responses` |
| Claude Opus / Sonnet / Haiku | [`claude-messages`](backends-anthropic.md) | `/messages` |
| DeepSeek Flash | [`deepseek-chat`](backends-deepseek-chat.md) | `/chat/completions` |
| Gemini 3.8 Flash / 4 Argon | [`gemini-native`](backends-gemini.md) | `/models/{model}:streamGenerateContent?alt=sse` |

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
| `request_max_mib` | 模型、独立搜索及图片 POST 请求体上限，单位 MiB，默认 `512`；必须是正整数且换算后的字节数可安全表示 |
| `compaction_cache_dir` | 按需复述缓存目录；默认 `$XDG_CACHE_HOME/codeks-bridge/compaction`，未设置 XDG 时为 `~/.cache/codeks-bridge/compaction` |
| `upstreams` | 上游连接配置表 |
| `models` | 模型别名表，是否进入客户端目录由各自的 `expose` 控制 |
| `web_search` | 可选；`{"upstream":"chatgpt"}` 让所有模型共用指定的订阅搜索连接，省略时关闭 |
| `image_generation` | 可选；`{"upstream":"chatgpt"}` 为支持图片输入的工作模型提供订阅图片生成与编辑，省略时关闭 |
| `inspect` | 可选；`capture` 决定启动时是否捕获，`max_mib` 是内存软上限，见[调试检查器](inspect.md) |

监听非 loopback 地址时必须配置 `token_env`，客户端也要设置同一个变量。它是 bridge 入口鉴权，不是上游 API key。入口没有 CORS。携带 `Origin` 的请求必须使用配置好的 bridge token，即使监听 loopback 也一样，避免网页的简单 POST 在无法读取响应时仍触发上游调用。没有 `Origin` 的 codeks 请求保持原行为。`GET /health`、`GET /v1/models`、`POST /v1/responses` 以及启用后的 `/v1/alpha/search`、`/v1/images/generations`、`/v1/images/edits` POST 路由使用同一鉴权。`/inspect/` 页面与接口使用[自己的规则](inspect.md#访问与鉴权)。

请求体上限按实际收到的字节计算，包含 JSON 和图片编码，不按字符数或声明的 `Content-Length` 判断。恰好达到上限的请求可接受，超限立即返回 HTTP 413 并关闭连接，不调用上游。默认 `512` MiB 为长截图历史留出空间；可按会话需要及可用内存调高或调低。保留上限是为了约束完整缓冲、JSON 解析和转换的内存开销，启用检查器时还会保留捕获副本；它不是进程总内存上限，也不等于模型 token 窗口。

## 上游连接

| 字段 | 含义 |
| --- | --- |
| `base_url` | 包含版本前缀的 HTTP(S) URL；adapter 在其后追加请求路径；ChatGPT 订阅鉴权可省略，使用订阅端点 |
| `auth` | `{"type":"chatgpt"}` 使用 codeks 的文件登录凭据；可选 `codex_home` 指定登录目录 |
| `api_key_env` | API key 环境变量名称 |
| `api_key_command` | 与 `api_key_env` 二选一；argv 数组，程序 stdout 返回当前凭据 |
| `auth_header` | 覆盖鉴权 header 名；默认 GPT/DeepSeek 用 `authorization: Bearer …`，Claude 用 `x-api-key`，Gemini 用 `x-goog-api-key`；OAuth Bearer 连接可显式选择 `authorization` |
| `headers_timeout_ms` | 等待上游响应头的最长时间；省略时沿用 `stream_idle_timeout_ms`，`null` 表示禁用 |
| `stream_idle_timeout_ms` | 收到上游响应头后，等待下一批字节的最长空闲时间，默认 300000 ms；`null` 表示禁用 |
| `headers` | 静态 header，覆盖同名客户端 header，例如 API 版本 |
| `options` | 原生请求参数，覆盖 adapter 推导出的参数 |
| `adapters` | 按 adapter ID 分组的桥接行为；供使用该连接的模型继承 |

`api_key_command` 不经过 shell，每条上游请求执行一次，最多 30 秒，适合短期凭据。命令错误不会把 stdout/stderr 回传客户端。连接无需 key 的服务时可省略凭据设置。Claude 默认版本 header 为 `anthropic-version: 2023-06-01`。客户端 metadata 默认透传，鉴权使用上游配置；覆盖顺序及必要过滤见 [header 边界](responses-stream.md#header-与转发边界)。

### ChatGPT 订阅

先用 codeks 登录 ChatGPT，默认使用文件存储：

```sh
codex login
```

远程或无浏览器的机器可使用 `login --device-auth`。已有有效的文件登录可以直接复用。bridge 读取 `auth.codex_home` 指定目录中的 `auth.json`；省略时依次使用 bridge 进程的 `CODEX_HOME`、`~/.codex`。自定义目录须与登录时的 `CODEX_HOME` 一致，例如：

```json
{
  "upstreams": {
    "chatgpt": {
      "auth": { "type": "chatgpt", "codex_home": "/absolute/path/to/codex-home" }
    }
  },
  "models": {
    "gpt": { "upstream": "chatgpt", "catalog": "gpt-6.1-sol", "model": "gpt-6.1-sol" }
  }
}
```

使用默认登录目录时只需 `"auth": { "type": "chatgpt" }`。默认 `base_url` 为 `https://chatgpt.com/backend-api/codex`，显式值可覆盖。`auth` 与 `api_key_env`、`api_key_command`、`auth_header` 互斥；API key 连接继续使用原有配置。完整的[ChatGPT＋Claude 示例](../examples/chatgpt-claude.json)可同时使用订阅和 Anthropic API key。

无需复制 access token、refresh token 或账号 ID。每次请求从同一份登录记录读取 token 与所选账号，写入 `Authorization` 和 `ChatGPT-Account-ID`，覆盖同名客户端及静态 header。登录文件中的 `tokens.account_id` 是权威值，不能用 JWT 中的账号声明代替用户选择的 workspace。重新登录或切换账号后，后续请求会读取新记录；显式换账号也可能改变上游对已有历史密文的接受范围。

bridge 使用文件存储，不读取系统 keyring。如果曾将 `cli_auth_credentials_store` 改为 `keyring` 或 `auto`，可运行 `codex -c 'cli_auth_credentials_store="file"' login` 明确保存文件登录；默认配置不需要这个参数。缺少登录、凭据失效或刷新写回失败会明确报错。它不会从 API key 登录或其他存储中猜测一份备用凭据。

token 临近过期时自动续期并写回原文件；HTTP 401 可触发一次鉴权恢复，再重发尚未被接受的请求。普通模型错误的重试仍由 codeks 控制。具体刷新、并发与取消边界见 [GPT 订阅鉴权](backends-responses.md#订阅凭据与续期)。

## 订阅搜索

独立搜索需要显式指定一个使用 `auth.type: "chatgpt"` 的连接：

```json
{
  "web_search": { "upstream": "chatgpt" },
  "upstreams": {
    "chatgpt": { "auth": { "type": "chatgpt" } }
  }
}
```

将这段配置合并到已有模型配置即可。它供全部工作模型使用，不要求另建 GPT 搜索模型，也不要求工作模型使用订阅推理；完整示例见 [ChatGPT＋Claude](../examples/chatgpt-claude.json)。没有 `web_search` 时搜索路由返回 HTTP 404，生成的客户端片段保持 `web_search = "disabled"`。

配置后，`config-snippet` 生成 `web_search = "live"` 和 provider 级 `supports_standalone_web_search = true`；合并片段并重载客户端即可启用。工作模型与搜索连接独立，搜索请求的 `model` 原样传递。请求、结果、引用和鉴权边界见[订阅搜索](web-search.md)。

## 订阅图片生成与编辑

指定使用 `auth.type: "chatgpt"` 的连接，与 `web_search` 分别启用：

```json
{
  "image_generation": { "upstream": "chatgpt" },
  "upstreams": {
    "chatgpt": { "auth": { "type": "chatgpt" } }
  }
}
```

合并到已有模型配置后，重新生成客户端片段。它开启 `features.image_generation` 和 provider 的 `requires_openai_auth`，保留 bridge token 配置。每个 codeks 客户端需要 `codex login`，且当前模型支持图片输入；只有 bridge 服务端持有登录还不足以显示工具。实际图片请求仍由 bridge 所选订阅连接鉴权，无需添加图片模型目录条目。完整用法、登录边界和协议见[图片生成与编辑](image-generation.md)。

## 模型

| 字段 | 含义 |
| --- | --- |
| `upstream` | 连接表中的 ID；不同区域或凭据域使用不同 ID |
| `model` | 实际上游模型名；可以是部署别名 |
| `catalog` | 必填，已审阅条目的 key；条目决定 adapter |
| `expose` | 默认 `true`；设为 `false` 时不进入客户端 HTTP 目录和 CLI 导出的静态目录 |
| `visibility` | 默认 `"list"`；`"hide"` 在客户端选择器中隐藏，仍保留完整目录条目；`expose: false` 时不输出条目 |
| `context_window` | 可选窗口预算；设置时同时覆盖客户端的 `context_window` 和 `max_context_window` |
| `max_output_tokens` | 覆盖目录的默认回答输出预算；请求中的显式值优先于模型配置 |
| `input_modalities` | 可选，覆盖条目中的 `text`/`image` 能力声明 |
| `reasoning` | 默认 effort 及其到原生值的映射 |
| `replay` | reasoning、原生压缩的允许来源，以及未识别历史状态的处理方式 |
| `compaction` | 压缩方式、执行模型，以及本目标是否接收原生压缩 |
| `options` | 原生请求参数，覆盖上游级 options |
| `adapters` | 当前模型的桥接行为；逐字段覆盖上游级同名 adapter 设置 |

`visibility: "hide"` 适合 Memory、已有会话等仍需完整模型元数据的用途。它保留提示词、窗口和工具能力，仅设置客户端的选择器可见性。`expose: false` 则完全省略目录条目，适合只由 bridge 内部调用的压缩预设。

两个字段都不改变别名的路由、来源身份或访问权限。显式按别名发送请求仍可调用，也可用于压缩、handoff 和状态复用；inspector 保留诊断记录。`config-snippet` 选择首个进入目录且 `visibility` 为 `"list"` 的别名作为默认模型；没有可见别名时该命令明确报错，服务和目录导出仍可使用。

```json
"memory": {
  "catalog": "gpt-5.6-luna", "upstream": "primary", "model": "gpt-5.6-luna",
  "visibility": "hide"
}
```

不设置窗口时，原条目的两个窗口字段各自保留。多数 GPT 条目为 `context_window: 272000`、`max_context_window: 872000`；GPT-6.1 Terra 为 `500000` / `872000`，GPT-5.5 的两个字段均为 `272000`，Daybreak Red 均为 `372000`。Claude、DeepSeek 和 Gemini 默认 `context_window: 400000`，作为统一工作预算；`max_context_window` 保留各自能力上限，Claude 和 DeepSeek 为 `1000000`，Gemini 为 `1048576`。压缩阈值沿用模板的 `auto_compact_token_limit: null`，由客户端按窗口计算。Claude Messages 必须提供 `max_tokens`，对应目录外层默认预算为 `128000`；GPT、DeepSeek 和 Gemini 使用请求、模型配置或上游提供的默认值。原生 options 也可调整预算，实际限制由部署端点裁决。

请求先由 adapter 转换，再浅层合并 `upstream.options`、`model.options`；后者优先，嵌套对象整体替换。例如模型 `options.output_config` 会替换推导值和上游同名对象。由此可以显式调整 thinking budget、原生 effort 或端点专有字段。

最终由 bridge 固定模型路由、转换后的历史、工具定义、流模式和必要协议字段。摘要请求保留普通工具选择并移除结构化输出约束；原生压缩移除普通回答的输出上限。必须重建的字段承载桥接契约，不由 options 改写。详见上表链接的后端文档，以及[摘要的工具选择](compaction.md#工具选择与缓存)。

## Adapter 专用行为

`adapters` 与 `options` 分工不同：前者控制 bridge 怎样转换协议，后者是发送给上游的原生请求参数。命名空间使用目录已有的 adapter ID；以后新增协议专用行为时，在对应命名空间增加字段，无需向模型目录或连接顶层添加协议特例。`claude-messages` 的设置：

| 字段 | 值与默认行为 |
| --- | --- |
| `thinking_mismatch` | 默认 `drop_block`，请服务端丢弃前缀失配的 thinking；`error` 请求报错；`upstream_default` 不补充该策略 |

连接级设置适合端点差异，模型级设置适合同一连接下的模型差异。每个叶字段依次取模型设置、连接设置、adapter 默认值；模型只覆盖一个字段时，仍继承连接里的其他字段。下面的连接显式使用默认失配策略，模型再单独选择报错：

```json
{
  "upstreams": {
    "compatible": {
      "base_url": "https://example.com/v1",
      "adapters": { "claude-messages": { "thinking_mismatch": "drop_block" } }
    }
  },
  "models": {
    "sonnet": {
      "upstream": "compatible", "catalog": "claude-sonnet-5-5", "model": "deployment-a",
      "adapters": { "claude-messages": { "thinking_mismatch": "error" } }
    }
  }
}
```

省略 `thinking_mismatch` 表示 bridge 默认的 `drop_block`，与显式 `upstream_default` 不同。对最终 `thinking.type` 为 `adaptive` 或 `enabled` 的请求，bridge 补充 `block_binding.prefix_mismatch_behavior`；原生 `options.thinking.block_binding` 中明确设置的同名值优先。`between_tools` 等不支持该字段的模式不补充策略，不擅自换 thinking 模式。`options` 本身仍按前述浅层规则合并，不进行通用递归合并。

专用设置不作为请求参数发给上游，不改变状态来源身份或客户端目录。共享连接可以配置供不同模型使用的 adapter；模型级只接受自身 adapter 的设置。未知命名空间、字段及枚举会报配置错误；尚无专用字段的 adapter 无需配置空对象。恢复代价及端点行为见 [Claude Messages](backends-anthropic.md#失配策略与故障续接)。

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

`effort_map` 的键是 codeks 可选档位，值是发给上游的原生值。第三方目录的档位说明参考 GPT-6.1 Sol 同名档位对速度、推理深度和自动分工的描述，与原生参数映射分别维护。提供映射时完整替换目录条目的默认映射；`default_effort` 必须出现在映射中。未指定默认档位时，保留映射中仍存在的条目默认值，否则选映射第一项。Sonnet 的 `between_tools` 模式可通过显式 options 选择，含义和配置见 [Messages](backends-anthropic.md)。

请求没有 effort 时使用配置默认值；有映射则转换，未列出的显式 effort 直接透传，交给上游判断。catalog 与实际请求使用同一份配置；通过原生 `options` 再覆盖 thinking/effort 时，应同时调整这里的展示设置。

codeks 的 `ultra` 是客户端特殊档位：注入多代理提示词，并优先使用条目的 `multi_agent_reasoning_effort`，未配置时按客户端规则选择 `max` 或其他可用普通档位。GPT 条目保留各自原值；GPT-6.1 Sol 和 Opus 5.5 使用 `xhigh`，Sonnet 5.5、Haiku 5.5 和 DeepSeek Flash 使用 `max`。若显式覆盖 `effort_map` 并提供 `ultra`，映射中还须有一个非 `ultra`/`persistent` 档位指向相同原生值；bridge 据此填写客户端字段，不能表达时明确报错。例如 `ultra: "max"` 与 `max: "max"` 配对。直接 HTTP 请求中的未知 effort 仍按上述规则透传。

摘要显示由 codeks 的顶层配置控制，bridge 不强制打开：

```toml
model_reasoning_summary = "auto"
```

也可选择 `concise`、`detailed` 或 `none`。Claude 和 DeepSeek 目录沿用 GPT-6.1 Sol 的 `default_reasoning_summary: "none"`；客户端配置为 `none` 时省略请求的 summary 字段。bridge 对缺省或 `none` 不展示可见摘要，对其他上述值请求或展示可用内容；Claude 使用原生 summarized 显示，DeepSeek 展示原生 reasoning 文本。它不承诺所有模型区分摘要长度，也不因此关闭实际推理或历史载荷回放。

`input_modalities` 用于客户端能力声明，不是 bridge 的模型能力预检。bridge 负责转换能表达的输入，具体模型能否处理由上游裁决。

## 压缩模式与执行模型

`models.<别名>.compaction.mode` 可选择 `summary` 或 `native`。默认值取自工作模型：GPT 默认 `native`，Claude/DeepSeek/Gemini 默认 `summary`。`compaction.model` 可引用另一个已配置的模型别名，让它执行压缩；省略时由工作模型自己执行。两项独立，仅设置执行模型不会改变模式。

GPT 的默认配置等价于：

```json
{ "compaction": { "mode": "native", "native_replay": true } }
```

`native` 初始只生成原生检查点；目标无法按来源策略回放它时，先向生成检查点的模型和连接复述为文字。原来源须继续在配置中可用。成功摘要及辅助 usage 存入顶层 `compaction_cache_dir`，重启后可复用；它不是上游 prompt cache。`summary` 继续使用标准 prompt 直接压缩原历史。

经常在 GPT 与 Claude 之间切换时，建议直接复用日常使用的 GPT 别名执行压缩。只需两个模型，Claude 的历史由同一个 GPT 原生压缩，再按需复述给 Claude。以下为模型部分，含连接的完整配置见 [examples/gpt-claude.json](../examples/gpt-claude.json)：

```json
{
  "models": {
    "gpt": {
      "catalog": "gpt-6.1-sol", "upstream": "openai", "model": "gpt-6.1-sol"
    },
    "claude": {
      "catalog": "claude-opus-5-5", "upstream": "anthropic", "model": "claude-opus-5-5",
      "compaction": { "mode": "native", "model": "gpt" }
    }
  }
}
```

这里的 `anthropic` 和 `openai` 使用已有 `upstreams` 连接，客户端目录只展示 `gpt` 和 `claude`。Claude 必须同时设置 `mode: "native"`；只设置 `model: "gpt"` 会让 GPT 执行 Claude 默认的标准文字压缩。

两条压缩路径都由 `gpt` 执行，因此生成的原生检查点与日常 GPT 的来源身份相同。GPT 默认就能恢复它们及历史中仍保存的自身 reasoning，无需添加 `replay.reasoning_from` 或 `replay.native_compaction_from`。Claude 使用文字 handoff；切换到 Claude 不会改写客户端保存的 GPT 原生状态。具体切换时序见[委托压缩与切换模型](compaction.md#委托压缩与切换模型)。

只有需要独立的压缩参数或不同部署时，才有必要增加专用模型别名；可用 `expose: false` 隐藏于客户端目录。同一 upstream ID、URL、adapter 和实际部署的别名本就共享来源身份，即使别名不同也不需要额外的 replay 配置。

压缩只跟随一次 `compaction.model`，不继续读取执行模型自己的委托配置或生成模式。工作模型的窗口与压缩阈值仍决定何时压缩，执行模型须能接收实际历史；超限由上游报错。

未设置 `compaction.model` 或显式引用自身别名时，沿用请求的 reasoning effort；引用其他别名时使用执行别名的 `reasoning.default_effort`，未设置则使用它的目录默认值，再按该模型的映射转换。即使两个别名指向同一部署，也可用专用压缩别名选择不同默认 effort。复述配方保留选定的请求 effort，后续切换工作模型不改变它。显式原生 options 仍按普通请求的规则覆盖推导参数；后续修改原来源的 options 也会作用于复述，它们不作为快照固化。

因此，Claude 委托 `gpt` 压缩不会记住之前 GPT 轮次在客户端临时选择的 effort。若希望受托压缩固定使用某档位，直接在现有 `gpt` 条目设置 `reasoning.default_effort`；它也会成为该别名的普通请求默认值，普通请求仍可显式覆盖。

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

bridge 能识别的自身状态默认允许恢复；两份列表增加其他允许来源，关系有方向且不传递。若也要接受 A 的 reasoning，把 A 加入 B 的 `reasoning_from`。这个例子的 B 自己只生成文字摘要，但仍可读取 A 的原生检查点：生成和恢复是独立能力。设置 `native_replay: false` 则已识别的压缩都使用文字表示，包括自身生成的检查点。

引用按连接、实际模型和 adapter 解析为来源身份，不绑定显示别名。加载配置时检查来源是否存在、源与目标的格式标识是否一致；每条请求恢复时再检查实际载荷。bridge 不探测密文是否被上游接受。上游拒绝被允许的状态时直接报错，不删掉状态再试。详见 [reasoning](reasoning.md) 和[压缩](compaction.md)。

连接身份包含 upstream ID 和去掉末尾斜杠的 URL，来源身份再包含 adapter 与实际模型。密钥、header 和 options 不参与身份。如果同一 URL 通过 header 或凭据切换到不兼容区域，使用不同 upstream ID；改显示别名不影响已保存状态。

### 未识别的历史状态

历史会话可能带有其他工具或旧版本保存的状态。模型级 `replay.unrecognized` 统一处理 `encrypted_content` 无法解码为相应 bridge carrier 的 `reasoning`、`compaction` 和 `compaction_summary` 项，包括未知前缀、缺少载荷或无法解析的封装：

| 值 | 行为 |
| --- | --- |
| `passthrough`（默认） | 保留整项及原始字段，交给上游解释 |
| `drop` | 仅从本次出站历史中过滤这些项 |
| `error` | 在发送上游请求前报错 |

例如，在需要明确拒绝此类历史的模型中配置：

```json
{ "replay": { "unrecognized": "error" } }
```

GPT 将透传项保留在 Responses `input` 中，包括其 `id`；Claude/DeepSeek 将原项放入 assistant 消息的 content 数组，Gemini 放入 model 的 parts，不把未知密文猜解为 thinking 或文字。这保留了原始数据，但不保证跨协议或跨模型兼容，上游可以拒绝；bridge 不自动重试或改用其他策略。

这些项没有可确认的来源与复述配方，因此不套用来源允许列表、不创建来源身份，也不触发按需复述。能解码的 bridge carrier 仍遵循原有来源、格式和压缩表示规则。三个选项都不改写客户端已保存的历史；`drop` 会减少本次请求的 reasoning 上下文，丢弃压缩检查点还可能失去早期对话的唯一表示。普通请求取工作模型的策略，委托压缩取实际执行模型的策略。

## 客户端目录

bridge 的 `GET /v1/models` 返回 Codex 专用的 `{"models": [...]}`，每项包含完整提示词、窗口、工具、多代理和 reasoning 元数据。它与经典 OpenAI 的 `{"object":"list","data":[...]}` 格式不同。仅列出配置中的别名，不暴露上游连接、实际部署名或凭据设置。

这些条目来自仓库内已审阅的 [catalog](../catalog/README.md)，运行时只展开别名和显式配置覆盖。GPT 优先使用自己的 Codex 源码条目，源码尚未收录的模型使用已审阅订阅快照；Claude、DeepSeek 和 Gemini 使用经过精调的 GPT-6.1 Sol 模板。不会启动 codeks 导出模板，也不请求订阅账号的模型目录。目录版本随 bridge 代码更新，升级客户端不会自动改写它。

### HTTP 发现

```sh
codeks-bridge config-snippet --config /absolute/path/bridge.json
```

默认输出 `model_providers.bridge.model_catalog_url`，指向 bridge 的 `/v1/models`。只设置 `base_url` 不足以让自定义 provider 使用这份目录。codeks 的 API key 模型发现功能默认启用；若用户配置关闭了 `api_key_model_discovery`，需要重新启用。

配置了 `token_env` 时，片段用 `env_key` 传递 bridge 入口凭据。匿名 loopback 服务使用公开标记 `experimental_bearer_token = "codeks-bridge-local"`，让 codeks 进入 API key 目录发现流程。这个固定字符串不是密钥，也不为服务提供鉴权；需要入口鉴权时应配置 `token_env`。

provider 显示名为 `Local bridge`，并显式声明 `[model_providers.bridge.capabilities] remote_compaction = "v2"`，无需借用 Azure 或 OpenAI 名称触发能力。图片生成随 `image_generation` 配置启用，并同时声明 `requires_openai_auth = true`；省略配置时 `features.image_generation = false`，图片输入仍然支持。未配置订阅搜索时关闭 `web_search`；配置后启用 `web_search = "live"` 与 provider 的 `supports_standalone_web_search = true`，模型目录保持原样。

片段还设置 `[features.multi_agent_v2] tool_namespace = "agents"`。在默认的保留 namespace `collaboration` 下，`spawn_agent`、`send_message` 和 `followup_task` 的 `message` 带 `encrypted` 标记，GPT 上游会把子代理任务写成密文。GPT 父代理创建的 Claude 或 DeepSeek 子代理只能收到读不懂的密文，会话记录和请求日志里也看不到任务内容。改用其他 namespace 后，codeks 去掉这个标记并按明文投递消息（见 [codeks patch 0005](https://github.com/WAcry/codeks/blob/main/fork/patches/0005-plaintext-agent-messages.md)），任何模型的子代理都能读懂任务，日志中也能看到原始 prompt。没有这个补丁的 Codex 只会改变工具名，消息仍然加密。

这张表不写 `enabled`，只修改 namespace；多代理 V2 是否启用仍由目录的 `multi_agent_version` 和已有配置决定。若已有配置在 `[features]` 下写了 `multi_agent_v2 = true`，合并时改为在 `[features.multi_agent_v2]` 中写 `enabled = true`，因为同一个 TOML 文件不能把同一个键同时写成值和表。

bridge 使用 HTTP/SSE。已核对 Codex `0.163.0` 的 `codex-rs/model-provider-info/src/lib.rs` 与 `codex-rs/core/src/client.rs`：自定义 provider 的 `supports_websockets` 默认为 `false`，生成的片段沿用该默认值；目录中的 `prefer_websockets: true` 保留源条目原值，不会越过 provider 的能力开关。若将片段合并到已有 provider 配置，应确认没有遗留的 `supports_websockets = true`。今后接入 WebSocket 时需实现相应传输契约，而不只是修改目录偏好。

目录响应带 `ETag`，普通响应带同值的 `x-models-etag`。服务配置修改后重启 bridge，新内容的标记会让客户端刷新模型目录；客户端也有定时缓存刷新。HTTP 和静态导出都提供完整目录，每个别名包含完整提示词，窗口或部署别名较多时响应也会增大。目录下载的大小与超时边界由客户端控制；codeks 的显式 HTTP 目录上限为 32 MiB，超时为 5 秒且不跟随重定向。需要固定本地快照时可使用下方的静态 `model_catalog_json` 方案。

顶层 `model_catalog_json` 的优先级高于 HTTP 目录。若已有该配置，迁移时移除它，再重载客户端配置。

### 静态文件

需要固定本地快照时，可导出相同的完整目录：

```sh
codeks-bridge catalog --config /absolute/path/bridge.json \
  --output /absolute/path/models.json
codeks-bridge config-snippet --config /absolute/path/bridge.json \
  --catalog /absolute/path/models.json
```

这种模式通过顶层 `model_catalog_json` 读取文件。模型列表或参数修改后，需要重新导出并重载客户端配置。

维护者更新源模板、审查差异和新增受支持 key 的步骤见[目录更新流程](../catalog/README.md#更新流程)。
