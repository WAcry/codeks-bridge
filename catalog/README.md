# 已审阅模型目录

这里保存运行时使用的完整模型条目。每个文件对应一个受支持的 catalog key；显示别名、连接和实际发给上游的模型名由用户配置。未知 key 直接报错，不使用通用模板猜测模型能力。

来源是 OpenAI Codex 的 `codex-rs/models-manager/models.json`，每份 JSON 独立记录版本。原有条目来自 [`rust-v0.163.0`](https://github.com/openai/codex/tree/rust-v0.163.0)，commit `83086188ae0614bd882818ff1aa23f3194962012`；GPT-5.5、两个 Daybreak 条目及 Codex Auto Review 来自 [`rust-v0.164.0`](https://github.com/openai/codex/tree/rust-v0.164.0)，commit `6aaac694803004a63c6f393d153c96d22521a6b9`。源码尚未收录的 GPT-6.1 Terra、GPT-Reserve 使用订阅快照，见下文。运行时不从订阅账号请求远端目录，也不在用户启动时读取本机 codeks 的最新模板。

| Catalog key | 来源条目 | Adapter |
| --- | --- | --- |
| `gpt-6-astra` | 同名条目 | `gpt-responses` |
| `gpt-6.1-sol` | 同名条目 | `gpt-responses` |
| `gpt-6.1-terra` | 订阅目录同名条目 | `gpt-responses` |
| `gpt-6-sol` | 同名条目 | `gpt-responses` |
| `gpt-6-luna` | 同名条目 | `gpt-responses` |
| `gpt-5.6-sol` | 同名条目 | `gpt-responses` |
| `gpt-5.6-terra` | 同名条目 | `gpt-responses` |
| `gpt-5.6-luna` | 同名条目 | `gpt-responses` |
| `gpt-5.5` | 同名条目 | `gpt-responses` |
| `gpt-daybreak-blue-latest` | 同名条目 | `gpt-responses` |
| `gpt-daybreak-red-latest` | 同名条目 | `gpt-responses` |
| `codex-auto-review` | 同名条目 | `gpt-responses` |
| `gpt-reserve` | 订阅端点同名条目 | `gpt-responses` |
| `claude-opus-5-5` | `gpt-6.1-sol`，经精调 | `claude-messages` |
| `claude-sonnet-5-5` | `gpt-6.1-sol`，经精调 | `claude-messages` |
| `claude-haiku-5-5` | `gpt-6.1-sol`，经精调 | `claude-messages` |
| `deepseek-flash` | `gpt-6.1-sol`，经精调 | `deepseek-chat` |

每份 JSON 包含：

- `source`：上游仓库、tag、commit、文件路径和源模型名；订阅快照改为记录端点、客户端版本、取得日期和源模型名。
- `adjustments`：相对于源条目的精调说明，供审阅和更新时核对。
- `adapter`：协议转换实现。
- `effort_map`：第三方模型显式提供的客户端档位到原生参数映射；GPT 从原始模型条目推导，不重复填写。
- `max_output_tokens`：为上游必填输出参数提供的默认预算；配置和请求可以覆盖。
- `model`：完整的 Codex 模型条目，包括提示词和工具元数据。

`model` 是运行时的唯一模板来源。运行时只展开别名与用户的明确覆盖，不重新生成这些精调内容，也不维护第二套完整上游副本。

## 当前精调

GPT 的 `model` 对象以对应源码或订阅目录的完整条目为基础，包括各自的提示词、默认 effort、摘要设置、服务档位和多代理设置；所有 GPT 的 `shell_type` 按用户选择统一为 `unified_exec`，对应旧写法的转换记在各自的 `adjustments` 中；当前 codeks 将 `shell_command` 解析为同一类型，因此这是目录表达的统一。GPT-5.5 另有下述 Lite 调整。GPT-5.6 Terra 保留原生多代理 v2；GPT-5.6 Luna 按用户选择跟随上游保留 v1，不额外添加 `ultra` 档位。运行时从各自的 `supported_reasoning_levels` 推导普通档位；`ultra` 是客户端模式，按 `multi_agent_reasoning_effort` 解析，源条目未指定时使用 `max`，不会把 `ultra` 直接作为 GPT 原生 effort。不能用 GPT-6.1 Sol 的默认值覆盖 Luna 或其他 GPT 的差异。

GPT-5.5 按用户选择将 `use_responses_lite` 从 `false` 改为 `true`，统一工具声明传输；除上述 shell 类型规范化外，其他字段完整保留上游值，包括未指定的工具模式与多代理版本、272K 窗口和 `comp_hash: "2911"`，不套用 GPT-5.6 的整份配置。多代理版本由客户端配置和 feature 决定，不强制 v2。Daybreak Blue 保留 Lite、多代理 v2 和 272K/872K 窗口；Daybreak Red 为 Lite、多代理 v2 和 372K 窗口。Codex Auto Review 保留 Lite、多代理 v1 和 272K/872K 窗口。两个旧 Daybreak key 继续按独立模型路由；新版 Codex 的 `access_programs.cyber` 请求参数也由 Responses adapter 原样转发，不把二者自动互换。模型、Lite 或访问模式是否可用由具体上游和账号决定，错误直接返回。

GPT-6.1 Terra 取自 2026-10-26（America/Los_Angeles）由 Codex 0.164.0 取得的订阅目录缓存，当时公开源码目录尚未收录。按用户选择将默认工作窗口从订阅条目的 `500000` 调整为 `272000`，最大窗口保留 `872000`，记录在 `adjustments` 中；其余字段和专属提示词完整保留，没有从 Sol 模板补齐省略字段或推断额外默认值。默认 effort 为 `low`，支持 `low` 到 `max` 及客户端 `ultra`（原生 `xhigh`）；保留 Responses Lite、Code Mode Only、多代理 v2、`shell_type: "unified_exec"`、`default_reasoning_summary: "none"`、图片 `original` 能力和 `comp_hash: "3000"`。codeks 通过远端 `/models` 读取新条目，已有客户端协议即可处理，不依赖二进制内置同名模型。配置 `catalog: "gpt-6.1-terra"` 并指定实际部署名即可使用；具体端点和账号的可用性由上游决定。

订阅缓存是客户端解析后的目录表示，缺省字段按当前客户端语义处理。Terra 已使用规范化的 `unified_exec` 名称，与其他 GPT 条目一致。条目只记录模型内容与来源，不包含整个缓存的账号标识、ETag 或本机路径。未来公开 release 收录同名模型时，按下方更新流程对比完整提示词与能力，再将来源切回固定 tag；不能仅因名字相同就用别的 GPT 条目替换。

GPT-Reserve 是客户端在普通额度用尽、后端授权后切换的回退模型。Codex 源码目录没有 `gpt-reserve` 条目，客户端只在 TUI 中按这个模型名处理额度回退和模型选择器。因此该条目取自 ChatGPT 订阅端点 `/models` 的同名条目，`source` 记录端点、请求时的客户端版本和取得日期，不记录 tag 与 commit。除上述 shell 类型规范化外，字段顺序和取值原样保留，包括 `visibility: "hide"`、`upgrade: null`、`model_messages.auto_review: null`、`base_instructions` 和 `available_access_programs`；提示词、Lite、多代理 v1、272K/872K 窗口、reasoning 和 `comp_hash` 与 GPT-5.6 Luna 一致。只删除公开源码未出现的名称：两个值为 `false` 的布尔字段，以及 `available_in_plans` 中的两个方案名；客户端不读取这些字段。导入脚本不处理订阅端点，更新时需手动取得条目并重新审阅。与其他条目一样，客户端目录中的 slug、展示名、排序和可见性由别名配置决定；要在选择器中隐藏，需在别名上设置 `visibility: "hide"`。

Claude 和 DeepSeek 从 GPT-6.1 Sol 的完整条目开始，只做各自 JSON 中列出的修改：底层模型与展示信息、工作窗口、reasoning 档位，以及当前 adapter 尚未转换的参数和 GPT 专属的服务展示信息。提示词仅将首句的 `based on GPT-6` 换成 `based on Claude` 或 `based on DeepSeek`；`You are Codex`、`As Codex` 和其余客户端指令保留。`default_reasoning_summary` 保持源条目的 `none`，由用户在 codeks 中选择摘要展示方式。

预算默认值遵循与 GPT-6.1 Sol 模板对齐的维护原则：仅保留模板已有字段，或为上游必填参数补充默认值；公布的能力上限本身不要求新增默认配置。窗口字段沿用模板结构：按用户选择，三个 Claude 条目的默认 `context_window` 为 `400000`，`max_context_window` 保留 `1000000`；400K 是项目的工作预算，不是官方能力上限。DeepSeek Flash 的两个字段均为 `1000000`。压缩阈值保留模板的 `auto_compact_token_limit: null`，由客户端按窗口计算。Claude Messages 要求 `max_tokens`，因此三个 Claude 条目提供 `128000` 默认预算；GPT 和 DeepSeek 的输出预算由请求、用户配置或上游默认值决定。

依据：[Sonnet 模型规格](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、[Haiku 模型规格](https://platform.claude.com/docs/en/models/haiku-5-5/overview)、[Messages 必填参数](https://platform.claude.com/docs/en/api/messages/create)、[DeepSeek 模型规格](https://api-docs.deepseek.com/quick_start/pricing/)。这些是第三方精调的依据，`source` 仍记录 Codex 模板来源。

Claude 的默认 effort 为 `medium`，DeepSeek 为 `high`。DeepSeek 和 Haiku 5.5 的 `none` 请求关闭 thinking；Haiku 省略原生 effort，使用上游默认 `medium`，符合 disabled 仅允许 `high` 或以下的约束。[Haiku thinking 规则](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5)

Opus / Sonnet 两个条目从 `low` 开始：Opus 5.5 始终启用 thinking，Sonnet 5.5 的最低模式 `between_tools` 仍保留工具之间的思考，因此不能用 `none` 表示。需要 Sonnet 的这一模式时，使用 [Messages 原生 options](../docs/backends-anthropic.md#历史与-thinking) 显式配置。目录列出的档位应与已审阅模型匹配；未列出的显式请求值仍交给上游裁决。[Claude thinking 规则](https://platform.claude.com/docs/en/build-with-claude/thinking)

`ultra` 保留 Codex 的自动分工提示词和档位说明：Opus 5.5 使用原生 `xhigh`，Sonnet 5.5、Haiku 5.5 与 DeepSeek Flash 使用 `max`；各条目的 `multi_agent_reasoning_effort` 与映射一致。

这些源模型都明确设置 `supports_search_tool: true`，本目录保持原值。Code Mode Only 如何暴露工具由客户端源码决定，不能因为没有独立的外层 `tool_search` 就把此字段改为 false。网页搜索和图片生成有各自的客户端设置，不通过这个字段控制。

`comp_hash` 与 WebSocket 偏好也保留源条目的值及省略状态。前者标记客户端压缩兼容组，GPT-5.5 为 `"2911"`，其余当前条目为 `"3000"`；bridge 检查点的文字表示使跨目标恢复可行，原生密文是否复用仍由独立策略决定。后者是模型偏好，实际传输受 provider 的 WebSocket 能力开关控制。详见[压缩兼容组](../docs/compaction.md#comp_hash-与原生状态兼容性)和[客户端配置](../docs/config.md#http-发现)。

## 更新流程

先取得明确版本的 Codex 源码，再导入需要检查的单个模型，输出到独立候选文件：

```sh
node scripts/import-catalog.ts \
  --source /path/to/codex/codex-rs/models-manager/models.json \
  --tag rust-v0.163.0 \
  --model gpt-6.1-sol \
  --output /path/to/review/gpt-6.1-sol.candidate.json
```

脚本验证源文件与指定 tag 的内容一致，并记录实际 commit。输出文件必须尚不存在，因此不会覆盖已审阅文件。导入结果默认使用 `gpt-responses`，保留源条目自身的 reasoning 设置，不添加独立的 `effort_map`；第三方条目仍需人工或 Agent 根据模板变化重新精调。

比较候选文件与现有条目，重点审查提示词、Code Mode、Responses Lite、多代理、reasoning、窗口、`comp_hash` 和工具元数据。字段含义或客户端传输行为变化时，应同时核对对应源码。决定采用新版本后，将调整落实到完整条目、更新 `source` 与 `adjustments`，运行项目检查并提交审阅。新增 key 时还需加入 `src/model-catalog.ts` 的有限目录。不要只改生成给客户端的 `models.json`，否则下次展开配置会丢失修改。

所有源文本遵循 OpenAI Codex 的 Apache-2.0 许可，归属说明见根目录 `NOTICE`。
