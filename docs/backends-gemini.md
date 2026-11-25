# Gemini 原生接口

可选目录条目为 `gemini-3.8-flash`、`gemini-4-argon`、`gemini-4-carbon`、`gemini-4-hydrogen` 和 `gemini-4-neon`。它们共用 `gemini-native` adapter，将 Responses 请求转为 `POST <base_url>/models/<model>:streamGenerateContent?alt=sse`，使用原生 `contents` / `parts` 协议。`model` 是实际部署名，`catalog` 选择已审阅的能力与默认值。

```json
{
  "upstreams": {
    "gemini": {
      "base_url": "https://generativelanguage.googleapis.com/v1beta",
      "api_key_env": "GEMINI_API_KEY"
    }
  },
  "models": {
    "flash": {
      "upstream": "gemini",
      "catalog": "gemini-3.8-flash",
      "model": "gemini-3.8-flash"
    },
    "argon": {
      "upstream": "gemini",
      "catalog": "gemini-4-argon",
      "model": "gemini-4-argon"
    },
    "carbon": {
      "upstream": "gemini",
      "catalog": "gemini-4-carbon",
      "model": "gemini-4-carbon"
    },
    "hydrogen": {
      "upstream": "gemini",
      "catalog": "gemini-4-hydrogen",
      "model": "gemini-4-hydrogen"
    },
    "neon": {
      "upstream": "gemini",
      "catalog": "gemini-4-neon",
      "model": "gemini-4-neon"
    }
  }
}
```

官方 Developer API 连接使用 `x-goog-api-key`。其他连接可通过 `headers`、`auth_header` 和凭据命令配置鉴权。`base_url` 包含版本及部署前缀。端点和账号需要具备对应模型的访问权限。客户端沿用 Responses Lite、Code Mode Only 和多代理工具。 [Carbon 发布说明](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/) · [Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Neon](https://aistudio.google.com/docs/models/gemini-4-neon)

## 目录与 thinking

| 条目 | 默认 effort | 普通档位对应的原生 `thinkingLevel` | `ultra` 的原生值 |
| --- | --- | --- | --- |
| 3.8 Flash、4 Argon、4 Carbon | `medium` | `LOW`、`MEDIUM`、`HIGH` | `HIGH` |
| 4 Hydrogen、4 Neon | `high` | `LOW`、`MEDIUM`、`HIGH`、`XHIGH` | `XHIGH` |

普通档位使用小写键，在请求中转换为 `generationConfig.thinkingConfig.thinkingLevel` 对应的大写值。codeks 的 `ultra` 启用自动分工提示词。目录默认值会显式写入请求，`minimal` 和 `none` 不列入目录。未映射的显式 effort 由上游裁决。 [各模型的原生 thinking 档位](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking#supported-thinking-levels-by-model)

`reasoning.summary` 为 `auto`、`concise` 或 `detailed` 时请求 `includeThoughts: true`，将上游标记 `thought: true` 的文本作为可见摘要。缺省或 `none` 时仍启用 thinking 并保存签名。目录沿用 GPT-6.2 Sol 的摘要默认值 `none`，可在 codeks 中设置 `model_reasoning_summary = "auto"` 打开显示。

默认工作窗口为 `272000`，最大窗口为 `1048576`。Flash 的最大窗口对应输入上限，Gemini 4 则在输入和输出之间共用这一窗口。标准前台生成的输出上限为 `65536` token。Gemini 4 提供更长输出的 long decode 路径，当前 adapter 实现单次前台流式响应。输出预算可从请求或模型配置显式指定，再由原生 options 覆盖。 [Flash 规格](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) · [Argon 规格](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon) · [Carbon 规格](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-carbon) · [Hydrogen 规格](https://aistudio.google.com/docs/models/gemini-4-hydrogen) · [Neon 规格](https://aistudio.google.com/docs/models/gemini-4-neon)

## 消息、工具与图片

开头的 instructions、system 和 developer 指令进入 `systemInstruction`；中途 system/developer 指令转换为原位置的 user `<system-reminder>`，不会为每条新指令重写顶部。user 与 assistant 对应原生 `user` / `model`；相邻同类内容组成 parts，但工具结果与后续的新用户指令分别保留为独立 Content。连续的并行工具结果仍在同一 Content 中按调用顺序排列。实测 Vertex AI 路由中，将结果和新指令合并会返回“Requests ending with a model turn are not supported”，保留两条相邻 user Content 则成功；不据此声称所有原生端点都禁止混合 parts。

Lite 的 `additional_tools` 按历史顺序合并，声明放入顶层 `tools.functionDeclarations`，同身份保留最新版本。namespace 名称、自由文本工具和 Lark/regex 语法沿用[共同工具转换](tools.md)，不为 Gemini 另造命名约定。工具调用成为 `functionCall`，结果成为 `functionResponse`；跨消息交错的调用与结果先使用现有工具历史配对规则整理。工具参数使用默认的完整 `functionCall.args`；原生 `streamFunctionCallArguments` 的 `partialArgs` / `willContinue` 增量模式尚未接入。

图片 data URL 转为 `inlineData`，远程 URL 使用 `fileData`；bridge 不下载远程图片，也不猜测上游是否有权限访问。模型是否接受 URI、MIME 和尺寸由上游裁决。工具输出中的图片随对应的 `functionResponse` 发送，保留与调用的关系。客户端目录不宣称 `detail: "original"`。

## 保留历史与压缩

Gemini 的 thought signature 是原生 Part 上的 `thoughtSignature`，不等同于可见思考摘要。它可能附在文本或 `functionCall` 上，也可能单独出现在流末尾的空文本 part；同源续接需要保留它与原始 part 的关系。官方要求工具调用时返回签名，并且不能把带签名与不带签名的 part 随意合并。[Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)

原生载荷保存为现有 `cxbr1:` reasoning carrier，格式为 `gemini.parts.v1`，data 保存原始 `parts`。正文或工具调用还记录对应的 Responses 投影标记：客户端仍看到正常文本和可执行调用，同源回放时恢复完整原生 parts 并替换对应投影，避免把文字或工具重复发送。工具按 `call_id` 关联，允许调用与载荷之间插入已有工具结果；名称、参数仍须匹配，重复或跨其他模型输出、用户指令、压缩边界的歧义关联会报错。正文投影继续在原位置核对可见文字。签名不编码进 call ID；原生末尾的空文本签名 part 也要保留。

新载荷用可选的 `generation` 记录本次 Responses response ID。同一次生成中，历史实际保留的 parts 先组成 model Content，再发送已有工具结果和通知；不会把并行调用拆成多轮。恢复关联先于公共工具历史整理。没有该字段的旧载荷仍可读取：按旧工具签名规则，将首个带签名调用及后续无签名调用恢复为同一并行步骤，并保留空文本尾 Part；下一个带签名调用开始另一工具步骤。

工具载荷在其可执行投影之前交付，二者都使用现有的成功后提交缓冲。这样客户端开始工具或 fork 时，已经保存对应的原生状态。快照只有载荷而没有工具项时，不凭载荷构造调用；快照只包含并行组的首个调用时，只恢复已继承的部分，不要求后续调用到齐，也不补造结果。此前 `call → aborted → carrier` 的旧顺序继续兼容。字段与封装保持向后读取兼容；回放新交付顺序需要更新后的 bridge，不依赖旧版的相邻项假设。

其他模型转入的工具历史没有 Gemini 签名。适配器使用官方允许的 `skip_thought_signature_validator` 标记这一边界；它不补造 reasoning，也不是服务端返回的真实签名。可以恢复的同源载荷始终原样回放。[跨模型工具历史规则](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)

来源隔离和用户允许的 reasoning 复用仍使用 bridge 的公共策略，不能因为都属于 Gemini 就默认共享签名。默认压缩为标准文字摘要；需要委托已有 GPT 做原生压缩时，使用现有 `compaction.model` 配置，无需额外的 Gemini 压缩接口。[Reasoning](reasoning.md)、[压缩](compaction.md)

失败重试或子代理继承的历史可能以 `model` 结束。原生接口需要新的 user 或工具结果边界；若末尾 model 不含待处理的 `functionCall`，本次出站追加 user `Continue.`。新生成的第一个 carrier 用 `continuation_before` 记录这次边界，后续同源请求在原位置恢复，避免下一轮改变签名前缀。正文仍然流式显示，bridge 不代替客户端重试；末尾有工具调用时不会用 Continue 掩盖缺失结果。

## 结构化输出与原生 options

Responses 的 JSON object 请求使用原生 `responseMimeType: "application/json"`；JSON Schema 使用 `responseJsonSchema`。schema 保留原始约束，不转换成提示词或另建桥接校验器；上游不支持的 schema 直接返回错误。原生参数位于 `generationConfig`，包括 thinking 配置与可选的输出预算。[原生结构化输出](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)

工具参数通过原生 `parametersJsonSchema` 保留根 `$ref` 和组合约束。Gemini `FunctionDeclaration` 没有逐工具的 `strict` 字段，bridge 不添加此字段，也不宣称复现 OpenAI 的 strict 保证；模型的原生 schema 与工具选择行为由端点决定。

上游和模型 `options` 可以设置原生请求字段，`generationConfig` 在自动转换的配置上合并。明确的原生参数优先；内容、工具表与客户端路由仍由 bridge 管理，options 不替换这些字段。bridge 不为每个原生选项新增单独配置项。

## 流、用量与失败

原生 SSE 的正文和可见 thought 文本转换成 Responses 增量事件。工具只有在响应成功结束、参数完整且用量有效后才交付；断流或失败不会执行尚未提交的调用。结束必须收到成功的 `STOP`，其他 finish reason、缺失终止或缺失必要用量都按失败交给客户端，不在 bridge 内重试或偷偷续接。

Responses input usage 包含 `promptTokenCount` 与存在时的 `toolUsePromptTokenCount`；output usage 包含 `candidatesTokenCount` 与 `thoughtsTokenCount`。Vertex 的 `totalTokenCount` 明确为这四项之和。缓存数来自 `cachedContentTokenCount`，它已包含在输入统计内，不再次累加。thoughts 同时作为 output 的 reasoning 明细，不能再加到上下文使用量里。转换保留服务端统计语义，不能用可见文本长度估算替代。[UsageMetadata](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse#UsageMetadata)

Gemini 4 Argon 与 Carbon 的官方隐式缓存要求共享前缀至少 `4096` tokens，默认启用 durable caching；显式缓存不受支持。bridge 沿用原生请求和 usage 字段，不为 Carbon 新增缓存选项；实际命中由上游决定，不能从某个端点的零命中推断模型不支持缓存。[Gemini 4 缓存说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/get-started-with-gemini-4)

## 范围

本 adapter 面向 Generate Content 的文本回答、工具和图片输入。服务端搜索、代码执行、文件检索、音频、视频、图片生成、Live API、多段续接和后台 long decode 均在适配范围之外。bridge 的独立订阅搜索和图片生成配置仍可与 Gemini 工作模型一起使用。Interactions API 使用另一套字段和流事件。

新增条目时核对原生 thinking 档位、上下文语义、签名载荷及返回顺序、工具与结构化输出字段。4 Hydrogen 和 4 Neon 按官方规格加入目录，复用现有前台流式转换。新增条目的验证范围为目录与合成请求参数，真实部署的访问权限和行为以端点为准。 [Hydrogen 原生接口指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen) · [Neon 原生接口指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-neon)

2026-10-27 的真实原生请求通过 Vertex AI 路由验证两个模型的 `MEDIUM`、thought 摘要、末尾空文本签名、工具签名回放、图片与 JSON Schema；Flash 省略输出预算也能成功。该记录验证实际收到的原生协议，不等同于已直连 Google AI Developer API，也不证明所有区域、缓存条件或跨模型签名兼容。适配器自身另以合成数据测试转换与客户端交付。

2026-11-10 的 Carbon 条目按官方规格复用 Argon 的原生协议、Codex 模板和工作预算，覆盖目录与实际 npm 包的加载测试；当时真实端点尚未可用。

2026-11-13 的真实原生验证确认 Argon、Carbon 均接受完整并行调用组、仅首个带签名调用及其结果、以及完整调用组的两个 `aborted` 结果；单独保留无签名的第二调用被拒绝。另在保留原始 Part 与签名的条件下，分别修改 system、工具说明/schema、先前消息、当前用户请求或删除较早对话，两模型均成功；删除或损坏当前轮签名则返回 400。这说明当前测试路由没有表现出阻断式前缀绑定，不证明任意历史改写都无损，也不能仅凭成功响应确认内部状态的使用方式。bridge 不增加移除签名后重试的策略。
