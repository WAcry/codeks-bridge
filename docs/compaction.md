# 压缩与跨模型恢复

压缩不是普通 reasoning：检查点可能是早期对话的唯一剩余表示。bridge 支持直接生成文字摘要，也支持先生成原生检查点，在目标需要文字时再向原来源复述。生成方式与恢复时的来源策略分别配置。这项机制用于切换模型，前提是原模型、原端点和对应配置仍然可用。

## 配置

| 配置 | 含义 | 默认 |
| --- | --- | --- |
| `compaction.mode: "summary"` | 用标准压缩 prompt 汇总原历史，只保存文字摘要 | Claude / DeepSeek |
| `compaction.mode: "native"` | 保存原生检查点及复述配方，按需生成文字表示 | GPT Responses |
| `compaction.native_replay` | 恢复时是否使用允许来源的原生表示 | GPT 为 true，其他为 false |
| `replay.native_compaction_from` | 除自身外，允许的原生来源模型别名 | 空列表 |
| 顶层 `compaction_cache_dir` | 保存成功的按需复述及其用量 | `$XDG_CACHE_HOME/codeks-bridge/compaction`，未设置 XDG 时为 `~/.cache/codeks-bridge/compaction` |

例如 GPT 目标可以设 `mode: "summary"`、`native_replay: true`：它自己只生成文字摘要，但仍可读取允许来源的原生检查点。另一目标可以使用 `native` 生成原生检查点，却通过 `native_replay: false` 在后续请求中始终使用文字表示。Claude/DeepSeek adapter 没有原生压缩格式，只能选择 `summary`。

原生表示由 adapter 的 `native_compaction_format` 声明，不通过 GPT 模型名判定。未来其他协议提供原生检查点时，需要实现该格式的生成与恢复；文字摘要、来源策略和压缩协调层可以继续复用。只有参数或部署能力不同，则优先使用目录及配置表达。

允许来源是定向、非传递的关系，与 reasoning 的列表互不影响。bridge 只检查格式能否还原，兼容配对由配置明确选择。原生压缩生成失败或原生检查点被拒绝都按上游错误返回，不自动改成文字压缩重试。

## 客户端契约与保留历史

codeks 的远程压缩 V2 仍调用 `POST /responses`，输入末项为 `{"type":"compaction_trigger"}`，保留完整历史及 Lite `additional_tools` 声明。bridge 在 `response.completed` 前交付恰好一个 `compaction` item。

```toml
[model_providers.bridge.capabilities]
remote_compaction = "v2"
```

两种生成模式都使用这条路径，客户端继续执行远程 V2 的历史保留规则。bridge 不提供独立的 `/responses/compact` 接口，也不把整个压缩前历史藏进载荷。

已核对的 codeks `0.162.1` 与 Codex `0.163.0` 行为是成功后保留最多约 64,000 tokens 的近期用户消息及其他符合规则的消息，再附检查点；本地 prompt 压缩路径约为 20,000 tokens。下文将压缩前历史称为 `AAAA`，保留消息称为 `U`，原生检查点称为 `K`，压缩后新增的工作称为 `BBBB`。

按需复述在后续请求中取得客户端已经保存的 `U + K + BBBB`，直接使用 `K` 前的实际保留消息，不再次裁剪，也不把 `BBBB` 放进旧检查点的复述请求。客户端重新注入的环境上下文也随实际保留历史使用。升级客户端时应复核 `codex-rs/core/src/compact_remote_v2_attempt.rs`、`compact_remote_v2.rs` 和 `codex-rs/protocol/src/models.rs`。

### `comp_hash` 与原生状态兼容性

Codex 目录中的 `comp_hash` 是压缩兼容组的标识，不是提示词内容的 hash。`0.163.0` 在前后两轮的非空值不同时，会先调用上一模型执行压缩；切换到更小窗口时也有独立的压缩判断。相同值只避免因兼容组变化而额外压缩，不关闭窗口用量检查。

当前八个条目保留源目录的 `"3000"`。bridge 检查点提供文字摘要，或提供向原来源生成文字摘要的配方，因此目标可以继续消费同一个检查点，无需按模型另造兼容组。是否恢复其中的原生密文仍由来源、格式和 `native_replay` 策略决定；相同 `comp_hash` 不表示 GPT、Claude 或不同区域之间能直接共享密文。

上游改变 `comp_hash` 或切换模型时的压缩逻辑后，应复核 `codex-rs/core/src/session/turn.rs` 及检查点恢复契约，再决定是否沿用新值。提示词或窗口调整本身不是重新计算此字段的理由。

## 生成与提示词

### `summary`：标准文字压缩

将 trigger 换成现有的 `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools...` 标准 prompt，保留原 instructions、历史、工具定义及工具选择，移除结构化输出格式。

这份提示词要求按对话顺序梳理用户意图、技术决策、相关文件与代码、错误修复、待办和当前工作，并原样保留用户提出的安全约束。它区分真实 user 消息与 assistant 引用的“用户话语”，输出 `<analysis>` 和 `<summary>` 两个文本块，完整文本一并保存。它没有要求逐条复述全部用户消息，因为客户端会自行保留符合预算的用户历史。

Claude 摘要保留工具及公共前缀的 `1h` 缓存，只将最后的摘要请求末块设为 `5m`。缓存是否命中不影响正确性。

### `native`：原生压缩与按需复述

```text
压缩时：AAAA + compaction_trigger → 保存 K 和复述配方
兼容目标续聊：U + K + BBBB → 直接使用 K
需要文字时：原来源接收源请求前缀 + U + K + handoff prompt → 缓存文字摘要
目标续聊：U + 文字摘要 + BBBB
```

复述由生成 `K` 的原模型和原连接执行。原生请求移除普通回答的输出预算，交由上游管理；复述使用普通回答预算。源请求前缀包括开头的 system/developer 消息和工具声明；中途新增的 Lite 工具声明也按原顺序收集，确保原工具仍可解释。工具声明集中放在源前缀，不保留它们与旧对话的交错位置；因此精确保留 `U` 不代表完整工具布局也逐字一致。复述保留源 instructions、reasoning、缓存 key、工具选择和未知请求参数，重新构造 input、stream，并移除文字输出约束。

这是用户选择的质量策略：优先让原生压缩整理任务状态，再把该状态交接给其他模型。复述 prompt 是 Codex 压缩 prompt 的微调英文版本，明确说明此前已压缩，要求全面完整地复述现有任务状态，覆盖进度、决策、约束、待办和关键引用；不再要求再次精简，也不强制标准文字压缩的 `<analysis>/<summary>` 格式。保留用户给定的正文，末尾补充只输出文字、不调用工具的要求。原文集中在 [`src/prompts.ts`](../src/prompts.ts) 的 `HANDOFF_PROMPT`。

复述仍是模型生成，并不是密文的可逆解码，可能遗漏或误述细节。实测的长度和事实覆盖用于选择提示词，不能保证任意历史都无损；输出 token 数也不是独立的质量证明。

按需复述保留了正常续聊的 `U + K` 前缀，有机会复用 prompt cache；真实命中还受请求布局、服务路由和缓存有效期影响，不保证命中。确定的收益是始终使用兼容目标时，完全没有额外的文字复述请求。

原来源在配置中继续可用。bridge 优先选择配方记录的原别名，也接受连接、adapter 和实际部署相同的其他别名；实际鉴权与 options 读取当前配置。配方保存源请求前缀，以及除 `input`、`stream`、`text` 外的请求 body，避免参数白名单遗漏未来字段；不保存 HTTP header、连接凭据或完整 `AAAA`。复述沿用本次客户端请求的 metadata，见 [header 边界](responses-stream.md#header-与转发边界)。

成功的复述及其独立 usage 写入 `compaction_cache_dir`。缓存键包含原来源、实际复述请求及 prompt，不包含 `BBBB`；同一输入的后续请求与服务重启可以复用结果。文件以 `0600` 权限原子写入，新目录使用 `0700`。同一服务实例内，相同键的请求排队后读取已有结果，各自取消互不牵连；不同进程之间没有去重协调。

缓存保存的是可读任务摘要，应按会话数据管理。删除缓存后，下次需要时重新生成。缓存写入失败会返回错误，不继续发送目标请求；没有失效条目或失败响应的缓存。若目标请求随后失败，已经成功保存的复述仍可供客户端重试复用。

### 工具选择与缓存

文字摘要和按需复述沿用普通请求的工具定义及 `tool_choice`，包括原生 options 的覆盖；缺省保持缺省，`auto` 保持 `auto`，显式 `required` 或指定工具也不静默改写。各 adapter 继续执行正常的协议转换，不因为是摘要而强制设置 `none`。只输出文字、不调用工具的要求写在 prompt 中。

用户选择这项策略，是为了保留正常会话的缓存条件，并信任模型遵守摘要指令。Claude 官方说明，改变 `tool_choice` 会使消息缓存失效，工具和 system 缓存仍可复用。[缓存失效规则](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache) GPT 尚未做隔离该参数的 A/B 实测，因此不宣称同样修改必然导致 GPT 缓存失效。保持参数一致只减少桥接器主动引入的差异，不保证远端命中。

模型若仍返回工具调用，摘要直接以 `invalid_prompt` 失败，不执行工具、不伪造工具结果，也不再发一轮“禁止工具”的请求。显式强制工具选择与摘要任务冲突时，也按同样的上游或摘要校验错误暴露。codeks 决定后续处理；bridge 不增加重试或改成 `none` 兜底。

## 交付、错误与用量

`summary` 在摘要成功后交付；`native` 在原生压缩成功后交付。原生结果须恰好包含一个非空压缩项，文字摘要须非空且完整结束；工具调用、拒绝或截断都不当作完整摘要。辅助请求的 incomplete 返回 `invalid_prompt`，原响应保留为诊断；流内失败保留原 error，但不交付辅助请求的部分 output 或 usage。

下游 HTTP 200 等目标上游请求被接受后才发送；需要按需复述时，先完成文字准备，再发送目标请求。这样各阶段的 HTTP 失败仍能保留原状态码。若上游已经进入 SSE 后失败，则保留原流内错误路径。等待期间没有下游心跳，具体边界见 [Responses 流](responses-stream.md)。

bridge 不重试、不自动换端点或换压缩方式。复述失败不发送目标请求。客户端断开会取消当前正在执行的请求，已经发生的用量仍可能计费。

`native` 的压缩响应只返回原生用量。按需复述用量单独保存在缓存中，不加入目标回答的 usage，避免把辅助请求误算为目标的上下文大小。缓存复用不会产生新的导出用量。

## 保存格式与恢复

`compaction` item 使用：

```text
cxbc1:<base64url(JSON)>
```

`cxbc` 标识 bridge 的压缩封装，`1` 标识持久化数据格式，不代表 bridge 版本、模型或密文兼容组。格式标记供恢复会话时解释载荷；模型之间能否复用仍由来源、格式和配置决定。

`native` 检查点保存原生状态和复述配方：

```json
{
  "native": {
    "source": {
      "id": "source-fingerprint",
      "connection": "connection-fingerprint",
      "model": "deployment-name",
      "adapter": "gpt-responses"
    },
    "format": "responses.compaction.v1",
    "data": {
      "type": "compaction",
      "encrypted_content": "original-encrypted-content"
    }
  },
  "handoff": {
    "prefix": [],
    "parameters": { "model": "source-alias" },
    "responsesLite": true
  }
}
```

`summary` 检查点只保存 `summary` 文字字段。原生检查点的 `handoff` 包含 `prefix`、上述请求 `parameters` 和 `responsesLite` 标记，足以在后续请求提供的 `U` 上生成文字。原生 data 保留完整上游 item；来源指纹计算见 [reasoning](reasoning.md)。

每次普通请求或再次压缩前，bridge 按当前目标选表示：

1. 有原生状态、开启 `native_replay`、来源允许、格式匹配：还原原生 item。
2. 其他情况已有文字摘要：将恢复前缀和文字摘要作为 user message。
3. 其他情况尚无文字摘要：读取缓存或向原来源按需生成，再执行第二步。

这是发送前的表示选择；第一种请求被上游拒绝时直接返回错误，不自动再试文字表示。生成复述必须读取源自身的 `K`，不受源路由普通续聊的 `native_replay: false` 限制。

恢复不改写客户端保存的载荷。按需复述只更新本次请求的副本，并通过本地缓存复用；切换模型再切回来，仍可使用原检查点。再次压缩后，新检查点取代旧检查点，不累积每个模型的检查点版本。外部原生检查点若没有 bridge 摘要或复述配方，不能保证跨目标恢复，因此明确报错。

恢复前缀逐字取自 Codex `rust-v0.162.1` 的 `codex-rs/prompts/templates/compact/summary_prefix.md`；handoff prompt 的许可归属见 `NOTICE`。外层是编码而非加密：文字摘要、请求前缀和参数可读，原生密文保持原样。

近期保留消息可能与摘要包含相同信息，这是客户端历史策略的一部分。客户端压缩后可能按 `encrypted_content` 长度粗估 token，复述配方会让估算偏保守；下一次正常响应的 usage 提供实际用量。bridge 不伪造 usage 或修改客户端公式。

实现见 [`src/compaction.ts`](../src/compaction.ts)、[`src/compaction-history.ts`](../src/compaction-history.ts)、[`src/compaction-handoff.ts`](../src/compaction-handoff.ts)、[`src/carrier.ts`](../src/carrier.ts) 和 [`src/history.ts`](../src/history.ts)。
