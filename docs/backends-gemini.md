# Gemini 原生接口

模型选择 `catalog: "gemini-3.8-flash"` 或 `"gemini-4-argon"`，条目指定 `gemini-native` adapter。bridge 将 Responses 请求转换为 `POST <base_url>/models/<model>:streamGenerateContent?alt=sse`，使用原生 `contents` / `parts` 协议；不经过 Chat Completions 兼容接口。`model` 是实际部署名，目录 key 只选择已经审阅的能力与默认值。

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
    }
  }
}
```

官方连接使用 `x-goog-api-key`；其他连接可通过现有 `headers`、`auth_header` 和凭据命令配置鉴权。`base_url` 包含版本及部署前缀，不包含具体模型和操作名。客户端继续使用 bridge 的 Responses Lite、Code Mode Only 和多代理工具。

## 目录与 thinking

两模型默认 `medium`；`low`、`medium`、`high` 对应 `generationConfig.thinkingConfig.thinkingLevel` 的 `LOW`、`MEDIUM`、`HIGH`。codeks 的 `ultra` 仍启用客户端的自动分工提示词，原生 effort 使用 `HIGH`。原生 Argon 要求提供 thinking level，不能依赖未指定值；两模型都不支持 `minimal`，目录也不宣传关闭 thinking 的 `none`。未映射的显式 effort 由上游裁决，不静默替换为另一个档位。[原生 thinking 文档](https://ai.google.dev/gemini-api/docs/generate-content/thinking)

`reasoning.summary` 为 `auto`、`concise` 或 `detailed` 时请求 `includeThoughts: true`，将上游标记 `thought: true` 的文本作为可见摘要。缺省或 `none` 不展示摘要；这不等于关闭 thinking，也不应丢失签名。目录沿用 Sol 的摘要默认值 `none`，可在 codeks 中设置 `model_reasoning_summary = "auto"`。

默认工作窗口为 `272000`；两个条目的最大窗口为 `1048576`。Flash 的官方限制是输入 token 上限，Argon 则是输入与输出共用的窗口，不能把后者理解成可以在 1M 输入之后再输出 1M。官方标准输出上限为 `65536` token；Argon 的更长输出需要另一种后台 long decode 路径。本 adapter 不设置额外默认输出预算或压缩阈值。显式预算从请求或模型配置取得，再接受原生 options 覆盖。[Flash 规格](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[Argon 规格](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)

## 消息、工具与图片

开头的 instructions、system 和 developer 指令进入 `systemInstruction`；中途 system/developer 指令转换为原位置的 user `<system-reminder>`，不会为每条新指令重写顶部。user 与 assistant 对应原生 `user` / `model`；相邻同类内容组成 parts，但工具结果与后续的新用户指令分别保留为独立 Content。连续的并行工具结果仍在同一 Content 中按调用顺序排列。实测 Vertex AI 路由中，将结果和新指令合并会返回“Requests ending with a model turn are not supported”，保留两条相邻 user Content 则成功；不据此声称所有原生端点都禁止混合 parts。

Lite 的 `additional_tools` 按历史顺序合并，声明放入顶层 `tools.functionDeclarations`，同身份保留最新版本。namespace 名称、自由文本工具和 Lark/regex 语法沿用[共同工具转换](tools.md)，不为 Gemini 另造命名约定。工具调用成为 `functionCall`，结果成为 `functionResponse`；跨消息交错的调用与结果先使用现有工具历史配对规则整理。

图片 data URL 转为 `inlineData`，远程 URL 使用 `fileData`；bridge 不下载远程图片，也不猜测上游是否有权限访问。模型是否接受 URI、MIME 和尺寸由上游裁决。工具输出中的图片随对应的 `functionResponse` 发送，保留与调用的关系。客户端目录不宣称 `detail: "original"`。

## 保留历史与压缩

Gemini 的 thought signature 是原生 Part 上的 `thoughtSignature`，不等同于可见思考摘要。它可能附在文本或 `functionCall` 上，也可能单独出现在流末尾的空文本 part；同源续接需要保留它与原始 part 的关系。官方要求工具调用时返回签名，并且不能把带签名与不带签名的 part 随意合并。[Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)

原生载荷保存为现有 `cxbr1:` reasoning carrier，格式为 `gemini.parts.v1`，data 保存原始 `parts`。正文或工具调用还记录对应的 Responses 投影标记：客户端仍看到正常文本和可执行调用，下一次同源请求恢复完整原生 parts 并替换紧邻的前一项投影，避免把文字或工具重复发送。签名不编码进 call ID；工具身份继续使用共用的调用转换与目标协议 ID 处理。原生末尾的空文本签名 part 也要保留。

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

## 范围

本 adapter 面向文本回答、工具和图片输入；没有接入 Gemini 服务端搜索、代码执行、文件检索、音频、视频、图片生成、Live API 或后台 long decode。bridge 的独立订阅搜索和图片生成配置仍可与 Gemini 工作模型一起使用。官方文档可能以 Interactions API 为主；这里实现的是用户选择的 Generate Content 接口，两者的字段和流事件不能混用。

新模型不能只凭名称加入目录。更新时需要核对原生 thinking 档位、上下文语义、签名载荷及返回顺序、工具与结构化输出字段，并通过相应的真实请求验证。

2026-10-27 的真实原生请求通过 Vertex AI 路由验证两个模型的 `MEDIUM`、thought 摘要、末尾空文本签名、工具签名回放、图片与 JSON Schema；Flash 省略输出预算也能成功。该记录验证实际收到的原生协议，不等同于已直连 Google AI Developer API，也不证明所有区域、缓存条件或跨模型签名兼容。适配器自身另以合成数据测试转换与客户端交付。
