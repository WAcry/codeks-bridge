# 已审阅模型目录

这里保存运行时使用的完整模型条目。每个文件对应一个受支持的 catalog key；显示别名、连接和实际发给上游的模型名由用户配置。未知 key 直接报错，不使用通用模板猜测模型能力。

当前来源是 OpenAI Codex 的 [`rust-v0.163.0`](https://github.com/openai/codex/tree/rust-v0.163.0)，commit `83086188ae0614bd882818ff1aa23f3194962012`，文件 `codex-rs/models-manager/models.json`。不从订阅账号请求远端目录，也不在用户启动时读取本机 codeks 的最新模板。

| Catalog key | 来源条目 | Adapter |
| --- | --- | --- |
| `gpt-6-astra` | 同名条目 | `gpt-responses` |
| `gpt-6.1-sol` | 同名条目 | `gpt-responses` |
| `gpt-6-sol` | 同名条目 | `gpt-responses` |
| `gpt-6-luna` | 同名条目 | `gpt-responses` |
| `gpt-5.6-sol` | 同名条目 | `gpt-responses` |
| `claude-opus-5-5` | `gpt-6.1-sol`，经精调 | `claude-messages` |
| `claude-sonnet-5-5` | `gpt-6.1-sol`，经精调 | `claude-messages` |
| `deepseek-flash` | `gpt-6.1-sol`，经精调 | `deepseek-chat` |

每份 JSON 包含：

- `source`：上游仓库、tag、commit、文件路径和源模型名。
- `adjustments`：相对于源条目的精调说明，供审阅和更新时核对。
- `adapter`：协议转换实现。
- `effort_map`：第三方模型显式提供的客户端档位到原生参数映射；GPT 从原始模型条目推导，不重复填写。
- `max_output_tokens`：上游生成请求的默认输出预算；配置和请求可以覆盖，不是 bridge 强制执行的上限。
- `model`：完整的 Codex 模型条目，包括提示词和工具元数据。

`model` 是运行时的唯一模板来源。运行时只展开别名与用户的明确覆盖，不重新生成这些精调内容，也不维护第二套完整上游副本。

## 当前精调

五个 GPT 的 `model` 对象分别完整保留对应上游条目，包括各自的提示词、默认 effort、摘要设置、服务档位和多代理设置。运行时从各自的 `supported_reasoning_levels` 推导普通档位；`ultra` 是客户端模式，按 `multi_agent_reasoning_effort` 解析，源条目未指定时使用 `max`，不会把 `ultra` 直接作为 GPT 原生 effort。不能用 GPT-6.1 Sol 的默认值覆盖 Luna 或其他 GPT 的差异。

Claude 和 DeepSeek 从 GPT-6.1 Sol 的完整条目开始，只做各自 JSON 中列出的修改：底层模型与展示信息、工作窗口、reasoning 档位，以及当前 adapter 尚未转换的参数和 GPT 专属的服务展示信息。提示词仅将首句的 `based on GPT-6` 换成 `based on Claude` 或 `based on DeepSeek`；`You are Codex`、`As Codex` 和其余客户端指令保留。`default_reasoning_summary` 保持源条目的 `none`，由用户在 codeks 中选择摘要展示方式。

三个第三方条目的 `context_window` 与 `max_context_window` 均为 `1000000`。Claude Opus 5.5 与 Sonnet 5.5 的默认输出预算为 `128000`，DeepSeek Flash 为 `393216`。这些值依据模型的标准容量设置，部署配置和请求可以覆盖；bridge 不据此拒绝更大的显式请求。

容量依据：[Claude Sonnet 5.5 官方概览](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) 列出 Opus 5.5 与 Sonnet 5.5 的 1M 上下文和 128K 标准输出；[Claude 官方请求示例](https://platform.claude.com/docs/en/build-with-claude/task-budgets) 使用 `max_tokens=128000`；[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/) 明确将 384K 输出记为 `393216`。这些是第三方精调的依据，`source` 仍记录 Codex 模板来源。

Claude 的默认 effort 为 `medium`，DeepSeek 为 `high`；`none` 用于请求关闭 thinking，具体支持由上游裁决。`ultra` 保留 Codex 的自动分工提示词和档位说明：Opus 5.5 使用原生 `xhigh`，Sonnet 5.5 与 DeepSeek Flash 使用 `max`；各条目的 `multi_agent_reasoning_effort` 与映射一致。

这些源模型都明确设置 `supports_search_tool: true`，本目录保持原值。Code Mode Only 如何暴露工具由客户端源码决定，不能因为没有独立的外层 `tool_search` 就把此字段改为 false。网页搜索和图片生成有各自的客户端设置，不通过这个字段控制。

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

比较候选文件与现有条目，重点审查提示词、Code Mode、Responses Lite、多代理、reasoning、窗口和工具元数据。决定采用新版本后，将调整落实到完整条目、更新 `source` 与 `adjustments`，运行项目检查并提交审阅。新增 key 时还需加入 `src/model-catalog.ts` 的有限目录。不要只改生成给客户端的 `models.json`，否则下次展开配置会丢失修改。

所有源文本遵循 OpenAI Codex 的 Apache-2.0 许可，归属说明见根目录 `NOTICE`。
