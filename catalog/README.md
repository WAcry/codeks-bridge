# 已审阅模型目录

这里保存运行时使用的完整模型条目。每个文件对应一个受支持的 catalog key；显示别名、连接和实际发给上游的模型名由用户配置。未知 key 直接报错，不使用通用模板猜测模型能力。

GPT 优先使用已审阅的 ChatGPT 订阅 `/models` 快照。当前快照日期为 2026-11-25（UTC），客户端版本为 `0.172.0`。快照缺少 GPT-5.5 和 Daybreak Red，因此这两项使用 Codex [rust-v0.172.0 的公开目录](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/models-manager/models.json)，commit 为 `3d86e43b075adeba2193ec5c22ac92f55afd82e6`。每份 JSON 的 `source` 记录实际来源。运行时使用随 bridge 发布的目录文件。

| Catalog key | 来源条目 | Adapter |
| --- | --- | --- |
| `gpt-6.2-sol` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-6.2-astra` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-6-astra` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-6.1-sol` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-6.1-terra` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-6-sol` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-6-luna` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-5.6-sol` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-5.6-terra` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-5.6-luna` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-5.5` | Codex 公开源码同名条目 | `gpt-responses` |
| `gpt-daybreak-blue-latest` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-daybreak-red-latest` | Codex 公开源码同名条目 | `gpt-responses` |
| `codex-auto-review` | 订阅端点同名条目 | `gpt-responses` |
| `gpt-reserve` | 订阅端点同名条目 | `gpt-responses` |
| `claude-fable-5-2` | `gpt-6.2-sol` 订阅条目，经精调 | `claude-messages` |
| `claude-opus-5-5` | `gpt-6.2-sol` 订阅条目，经精调 | `claude-messages` |
| `claude-sonnet-5-5` | `gpt-6.2-sol` 订阅条目，经精调 | `claude-messages` |
| `claude-haiku-5-5` | `gpt-6.2-sol` 订阅条目，经精调 | `claude-messages` |
| `deepseek-flash` | `gpt-6.2-sol` 订阅条目，经精调 | `deepseek-chat` |
| `gemini-3.8-flash` | `gpt-6.2-sol` 订阅条目，经精调 | `gemini-native` |
| `gemini-4-argon` | `gpt-6.2-sol` 订阅条目，经精调 | `gemini-native` |
| `gemini-4-carbon` | `gpt-6.2-sol` 订阅条目，经精调 | `gemini-native` |
| `gemini-4-hydrogen` | `gpt-6.2-sol` 订阅条目，经精调 | `gemini-native` |
| `gemini-4-neon` | `gpt-6.2-sol` 订阅条目，经精调 | `gemini-native` |

每份 JSON 包含：

- `source`：上游仓库、tag、commit、文件路径和源模型名；订阅快照改为记录端点、客户端版本、取得日期和源模型名。
- `adjustments`：相对于源条目的精调说明，供审阅和更新时核对。
- `adapter`：协议转换实现。
- `effort_map`：第三方模型显式提供的客户端档位到原生参数映射；GPT 从原始模型条目推导，不重复填写。
- `max_output_tokens`：为上游必填输出参数提供的默认预算；配置和请求可以覆盖。
- `model`：完整的 Codex 模型条目，包括提示词和工具元数据。

`model` 是运行时的唯一模板来源。运行时只展开别名与用户的明确覆盖，不重新生成这些精调内容，也不维护第二套完整上游副本。

## GPT 条目

每个模型采用所选来源的完整条目，保留提示词、默认与可选 effort、摘要、窗口、输入模态、服务档位、工具和多代理配置。`adjustments` 记录公开审查及相对来源的改动。本地缓存文件的身份标识等外层元数据不会进入目录。订阅条目采用下发的 `unified_exec`。GPT-6.2 Sol、GPT-6.1 Sol 和 GPT-6.1 Terra 的默认工作窗口为 `500000`，最大窗口为 `872000`。GPT-6.2 Astra 的默认工作窗口为 `272000`，最大窗口为 `872000`。GPT-6.2 Sol 和 Astra 的输入声明为文本和图片。

GPT-5.5 保留公开源码的窗口、工具模式、多代理和 `comp_hash`，并按项目约定启用 Responses Lite。两个 Daybreak key 各自有独立条目和路由。GPT-Reserve 使用订阅目录里的回退模型条目。别名的显示名、排序和可见性由配置决定，将 `visibility` 设为 `"hide"` 可在选择器中隐藏它。

运行时根据 `supported_reasoning_levels` 推导普通档位。客户端的 `ultra` 优先采用条目的 `multi_agent_reasoning_effort`，未设置时选择 `max` 或目录中最后一个普通档位。GPT-6.2 Sol 保留订阅的 Fast 与 Ultrafast，GPT-6.2 Astra 保留 Fast。当前订阅条目省略 `default_service_tier`，包括 GPT-6 Sol 和 GPT-6 Luna。具体服务档位的可用性由部署端点决定。配置示例见 [ChatGPT＋Claude](../examples/chatgpt-claude.json)。

## 第三方条目

Claude、DeepSeek 和 Gemini 使用同一份已审阅的 GPT-6.2 Sol 订阅条目作为模板，按各自 JSON 中的 `adjustments` 调整。提示词首句的底层模型身份改为 `Claude model`、`DeepSeek model` 或 `Gemini model`，保留 Codex 的代理角色和其余客户端指令。沿用 `unified_exec`、Responses Lite、Code Mode Only、多代理元数据和 `default_reasoning_summary: "none"`。输入声明保留文本和图片，服务档位仅用标准档。

| 家族 | 默认工作窗口 | 最大窗口 | 默认值的考虑 |
| --- | ---: | ---: | --- |
| Claude | 400000 | 1000000 | 同一任务通常比 GPT 消耗更多 token，预留 400K，兼顾上下文与单任务成本 |
| DeepSeek | 400000 | 1000000 | 分词效率比 Claude 更接近 GPT，单任务成本较低，采用 400K 保留更多历史 |
| Gemini | 272000 | 1048576 | 分词效率与 GPT 接近，沿用常用的 272K 工作预算以控制单任务成本 |

模板省略了 `auto_compact_token_limit`，第三方条目沿用这一设置。客户端按窗口计算压缩阈值。Claude Messages 要求 `max_tokens`，目录为此提供 `128000` 的默认输出预算。GPT、DeepSeek 和 Gemini 根据请求、模型配置或上游默认值确定输出预算。

依据：[Sonnet 模型规格](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、[Haiku 模型规格](https://platform.claude.com/docs/en/models/haiku-5-5/overview)、[Messages 必填参数](https://platform.claude.com/docs/en/api/messages/create)、[DeepSeek 模型规格](https://api-docs.deepseek.com/quick_start/pricing/)。这些是第三方精调的依据，`source` 仍记录 Codex 模板来源。

Fable 5.2 按 Claude API 默认使用 `high`，其余 Claude 条目默认使用 `medium`。Claude 目录提供 `low`、`medium`、`high`、`xhigh`、`max` 和客户端 `ultra`。DeepSeek 默认 `high`，目录提供原生 `low`、`high`、`max` 和客户端 `ultra`。[Fable 5.2 规格](https://platform.claude.com/docs/en/models/fable-5-2/overview)、[DeepSeek thinking 参数](https://api-docs.deepseek.com/guides/thinking_mode/)

第三方条目的档位说明沿用 GPT-6.2 Sol 同名档位对速度、推理深度和自动分工的描述。说明文字与 `effort_map` 分开维护，实际推理参数按对应上游的原生档位确定。

Fable 5.2 与 Opus 5.5 始终启用 adaptive thinking。Sonnet 5.5 的最低模式 `between_tools` 仍保留工具之间的思考，因此这些目录从 `low` 开始。需要 Sonnet 的这一模式时，使用 [Messages 原生 options](../docs/backends-anthropic.md#历史与-thinking) 显式配置。目录列出的档位应与已审阅模型匹配；未列出的显式请求值仍交给上游裁决。[Claude thinking 规则](https://platform.claude.com/docs/en/build-with-claude/thinking)

`ultra` 保留 Codex 的自动分工提示词和档位说明：Fable 5.2 与 Opus 5.5 使用原生 `xhigh`，Sonnet 5.5、Haiku 5.5 与 DeepSeek Flash 使用 `max`；各条目的 `multi_agent_reasoning_effort` 与映射一致。

Gemini 共用原生 `streamGenerateContent` 转换。3.8 Flash、4 Argon 和 4 Carbon 默认 `medium`，普通档位为 `low`、`medium`、`high`，`ultra` 映射到原生 `HIGH`。4 Hydrogen 和 4 Neon 默认 `high`，普通档位另含 `xhigh`，`ultra` 映射到原生 `XHIGH`。Gemini 4 各条目的最大窗口由输入和输出共用。3.8 Flash 的最大窗口对应输入上限。所有 Gemini 条目默认使用文字压缩。 [原生 thinking 档位](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking#supported-thinking-levels-by-model) · [Hydrogen 规格](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Neon 规格](https://aistudio.google.com/docs/models/gemini-4-neon) · [适配说明](../docs/backends-gemini.md)

这些源模型都明确设置 `supports_search_tool: true`，本目录保持原值。Code Mode Only 如何暴露工具由客户端源码决定，不能因为没有独立的外层 `tool_search` 就把此字段改为 false。网页搜索和图片生成有各自的客户端设置，不通过这个字段控制。

`comp_hash` 与 WebSocket 偏好也保留源条目的值及省略状态。前者标记客户端压缩兼容组，GPT-5.5 为 `"2911"`，其余当前条目为 `"3000"`；bridge 检查点的文字表示使跨目标恢复可行，原生密文是否复用仍由独立策略决定。后者是模型偏好，实际传输受 provider 的 WebSocket 能力开关控制。详见[压缩兼容组](../docs/compaction.md#comp_hash-与原生状态兼容性)和[客户端配置](../docs/config.md#http-发现)。

## 更新流程

先从已取得的 ChatGPT 订阅缓存中提取同名模型条目，在仓库外生成候选，记录端点、客户端版本和日期。审查全部字段和提示词是否适合公开，订阅账号、设备和缓存标识不写入候选。若订阅快照缺少该模型，取得明确版本的 Codex 源码，用导入脚本将同名条目写到独立候选文件。

```sh
node scripts/import-catalog.ts \
  --source /path/to/codex/codex-rs/models-manager/models.json \
  --tag rust-v0.172.0 \
  --model gpt-5.5 \
  --output /path/to/review/gpt-5.5.candidate.json
```

脚本验证源文件与指定 tag 的内容一致，并记录实际 commit。输出文件必须尚不存在，因此不会覆盖已审阅文件。导入结果默认使用 `gpt-responses`，保留源条目自身的 reasoning 设置，不添加独立的 `effort_map`；第三方条目仍需人工或 Agent 根据模板变化重新精调。

比较候选文件与现有条目，重点审查提示词、Code Mode、Responses Lite、多代理、reasoning、窗口、`comp_hash` 和工具元数据。字段含义或客户端传输行为变化时，应同时核对对应源码。决定采用新版本后，将调整落实到完整条目、更新 `source` 与 `adjustments`，运行项目检查并提交审阅。新增 key 时还需加入 `src/model-catalog.ts` 的有限目录。不要只改生成给客户端的 `models.json`，否则下次展开配置会丢失修改。

所有源文本遵循 OpenAI Codex 的 Apache-2.0 许可，归属说明见根目录 `NOTICE`。
