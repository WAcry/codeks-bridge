# 配置

`serve --config FILE` 在启动时读取 JSON。配置文件和凭据放在仓库外，完整起点见 [examples/config.json](../examples/config.json)。

## 连接与模型分开

`upstreams` 只描述连接。`models` 的每个键是 codeks 中显示的模型别名；`upstream` 指向连接，`model` 是实际发给上游的名称，`adapter` 明确选择转换规则。

| adapter | 上游路径 | 模型方言 |
| --- | --- | --- |
| `gpt-responses` | `/responses` | GPT 的 Responses reasoning 与原生压缩 |
| `claude-messages` | `/messages` | Claude thinking、签名和 Messages 缓存 |
| `deepseek-chat` | `/chat/completions` | DeepSeek thinking 参数、`reasoning_content` 和 usage |

同一个兼容网关的连接可供不同 adapter 使用。服务按每条请求的模型别名独立选路，因此父代理、子代理和并行会话可以同时使用不同上游。别名固定对应一个目标，不做上游模型发现或自动负载均衡。

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
| `adapter` | 上表中的模型方言，不从模型名猜测 |
| `context_window` | 客户端上下文窗口，生成 catalog 时必填 |
| `max_output_tokens` | 默认回答输出上限；请求中的显式值优先于此默认值 |
| `input_modalities` | catalog 中声明的 `text`/`image`，默认两者 |
| `reasoning` | 默认 effort 及其到原生值的映射 |
| `replay` | 分别允许哪些来源的 reasoning、原生压缩 |
| `compaction` | 本目标如何生成压缩，以及是否接收原生压缩 |
| `options` | 原生请求参数，覆盖上游级 options |

请求先由 adapter 转换，再浅层合并 `upstream.options`、`model.options`；后者优先，嵌套对象整体替换。例如模型 `options.output_config` 会替换推导值和上游同名对象。由此可以显式调整 thinking budget、原生 effort 或端点专有字段。

最终由 bridge 固定模型路由、转换后的历史、工具定义、流模式和必要协议字段。摘要请求固定禁止调用工具并移除结构化输出约束；原生压缩移除普通回答的输出上限。这些字段承载桥接契约，不由 options 改写。详见各[后端文档](backends-responses.md)。

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

`effort_map` 的键是 codeks 可选档位，值是发给上游的原生值。提供映射时完整替换 adapter 的默认映射；`default_effort` 必须出现在映射中。未指定默认档位时，保留映射中仍存在的 adapter 默认值，否则选映射第一项。`none` 映射为原生 `none` 时，Claude/DeepSeek 关闭 thinking。

请求没有 effort 时使用配置默认值；有映射则转换，未列出的显式 effort 直接透传，交给上游判断。catalog 与实际请求使用同一份配置；通过原生 `options` 再覆盖 thinking/effort 时，应同时调整这里的展示设置。

codeks 的 `ultra` 是客户端特殊档位，会先按 catalog 的 `multi_agent_reasoning_effort` 归一化。若配置提供 `ultra`，映射中还须有一个非 `ultra`/`persistent` 档位指向相同原生值；生成器据此填写客户端字段，不能表达时明确报错。例如 `ultra: "max"` 与 `max: "max"` 配对。直接 HTTP 请求中的未知 effort 仍按上述规则透传。

`input_modalities` 用于客户端能力声明，不是 bridge 的模型能力预检。bridge 负责转换能表达的输入，具体模型能否处理由上游裁决。

## 状态复用

以下模型片段演示 B 接受 A 的原生压缩，但仍隔离 reasoning。实际部署名是占位示例，配对是否可用须由真实端点验证。

```json
{
  "gpt-a": {
    "upstream": "primary",
    "model": "deployment-a",
    "adapter": "gpt-responses",
    "context_window": 272000
  },
  "gpt-b": {
    "upstream": "secondary",
    "model": "deployment-b",
    "adapter": "gpt-responses",
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

`catalog` 从指定 codeks 的 `debug models --bundled` 取模板；可通过 `--codeks PATH` 指定二进制，或 `--bundled FILE` 读取已导出的 JSON。`--template SLUG` 选择模板，默认选第一个可见的 V2 多代理模型。

模板提供客户端指令和工具元数据；各模型的别名、窗口、reasoning 档位与输入模态来自 bridge 配置。生成时关闭 Responses Lite，让工具 schema 完整传入；关闭 web search 宣告和服务优先级。输出只包含配置中的别名，不自动合并其他 provider 的模型。`GET /v1/models` 只是别名列表，不是这份完整 catalog。

`config-snippet --catalog ABSOLUTE_PATH` 输出 TOML。顶层设置放在表定义前，并声明 `[model_providers.bridge.capabilities] remote_compaction = "v2"`。bridge 走 V2 `/responses` 压缩协议。

修改服务配置后重启 bridge；更改模型列表、窗口、reasoning 或图片声明后重新生成 catalog 并重载客户端。升级 codeks 后也重新生成，以使用新版本的客户端元数据。
