# 压缩与跨模型恢复

压缩不是普通 reasoning：检查点可能是早期对话的唯一剩余表示。bridge 支持直接生成文字摘要，也支持先生成原生检查点，再立即或按需把它复述为文字。生成方式与恢复时的来源策略分别配置。

## 配置

| 配置 | 含义 | 默认 |
| --- | --- | --- |
| `compaction.mode: "summary"` | 用标准压缩 prompt 汇总原历史，只保存文字摘要 | Claude / DeepSeek |
| `compaction.mode: "dual"` | 先完成原生压缩，再复述检查点；两步成功才交付 | GPT Responses |
| `compaction.mode: "lazy"` | 先交付原生检查点，需要文字表示时再复述 | 显式选择 |
| `compaction.native_replay` | 恢复时是否使用允许来源的原生表示 | GPT 为 true，其他为 false |
| `replay.native_compaction_from` | 除自身外，允许的原生来源模型别名 | 空列表 |
| 顶层 `compaction_cache_dir` | 保存成功的延迟复述及其用量 | `$XDG_CACHE_HOME/codeks-bridge/compaction`，未设置 XDG 时为 `~/.cache/codeks-bridge/compaction` |

例如 GPT 目标可以设 `mode: "summary"`、`native_replay: true`：它自己只生成文字摘要，但仍可读取允许来源的原生检查点。另一目标可以生成双压缩，却通过 `native_replay: false` 始终使用文字表示。Claude/DeepSeek adapter 没有原生压缩格式，只能选择 `summary`。

原生表示由 adapter 的 `native_compaction_format` 声明，不通过 GPT 模型名判定。未来其他协议提供原生检查点时，需要实现该格式的生成与恢复；文字摘要、来源策略和压缩协调层可以继续复用。只有参数或部署能力不同，则优先使用目录及配置表达。

允许来源是定向、非传递的关系，与 reasoning 的列表互不影响。bridge 只检查格式能否还原，兼容配对由配置明确选择。原生压缩生成失败或原生检查点被拒绝都按上游错误返回，不自动改成文字压缩重试。

## 客户端契约与保留历史

codeks 的远程压缩 V2 仍调用 `POST /responses`，输入末项为 `{"type":"compaction_trigger"}`，保留完整历史及 Lite `additional_tools` 声明。bridge 在 `response.completed` 前交付恰好一个 `compaction` item。

```toml
[model_providers.bridge.capabilities]
remote_compaction = "v2"
```

三种生成模式都使用这条路径，客户端继续执行远程 V2 的历史保留规则。bridge 不提供独立的 `/responses/compact` 接口，也不把整个压缩前历史藏进载荷。

已核对的 codeks `0.162.1` 与 Codex `0.163.0` 行为是成功后保留最多约 64,000 tokens 的近期用户消息及其他符合规则的消息，再附检查点；本地 prompt 压缩路径约为 20,000 tokens。下文将压缩前历史称为 `AAAA`，保留消息称为 `U`，原生检查点称为 `K`，压缩后新增的工作称为 `BBBB`。

`dual` 必须在把检查点交给客户端前完成复述，因此 bridge 按当前可观察到的客户端规则从 `AAAA` 选取 `U`：近期用户消息、符合条件的代理消息及配套图片通知，共用约 64k 预算，边界文本保留首尾。它是对线上载荷的近似：客户端本地的保留标志、部分通知身份和图片尺寸信息没有全部传入，bridge 无法精确复现这些不可见信息。实测客户端还会在续聊时重新注入 `<environment_context>`，dual 不重建这段客户端状态，因此不保证复述与续聊的前缀逐字相同。此处只构造额外的复述请求，不改变客户端最终保存什么。

`lazy` 在后续请求中取得客户端已经保存的 `U + K + BBBB`，直接使用 `K` 前的实际保留消息，不再次裁剪，也不把 `BBBB` 放进旧检查点的复述请求。升级客户端时应复核 `codex-rs/core/src/compact_remote_v2_attempt.rs`、`compact_remote_v2.rs`、`codex-rs/protocol/src/models.rs` 和 `utils/string/src/truncate.rs`。

### `comp_hash` 与原生状态兼容性

Codex 目录中的 `comp_hash` 是压缩兼容组的标识，不是提示词内容的 hash。`0.163.0` 在前后两轮的非空值不同时，会先调用上一模型执行压缩；切换到更小窗口时也有独立的压缩判断。相同值只避免因兼容组变化而额外压缩，不关闭窗口用量检查。

当前八个条目保留源目录的 `"3000"`。bridge 检查点提供文字摘要，或提供向原来源生成文字摘要的配方，因此目标可以继续消费同一个检查点，无需按模型另造兼容组。是否恢复其中的原生密文仍由来源、格式和 `native_replay` 策略决定；相同 `comp_hash` 不表示 GPT、Claude 或不同区域之间能直接共享密文。

上游改变 `comp_hash` 或切换模型时的压缩逻辑后，应复核 `codex-rs/core/src/session/turn.rs` 及检查点恢复契约，再决定是否沿用新值。提示词或窗口调整本身不是重新计算此字段的理由。

## 生成与提示词

### `summary`：标准文字压缩

将 trigger 换成现有的 `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools...` 标准 prompt，保留原 instructions、历史和工具定义，设置 `tool_choice: "none"`，移除结构化输出格式。

这份提示词要求按对话顺序梳理用户意图、技术决策、相关文件与代码、错误修复、待办和当前工作，并原样保留用户提出的安全约束。它区分真实 user 消息与 assistant 引用的“用户话语”，输出 `<analysis>` 和 `<summary>` 两个文本块，完整文本一并保存。它没有要求逐条复述全部用户消息，因为客户端会自行保留符合预算的用户历史。

Claude 摘要保留工具及公共前缀的 `1h` 缓存，只将最后的摘要请求末块设为 `5m`。缓存是否命中不影响正确性。

### `dual`：原生检查点完成后复述

```text
AAAA + compaction_trigger → K
源请求前缀 + U + K + handoff prompt → 文字摘要
两步成功 → 保存 K 和文字摘要
```

第二步由生成 `K` 的原模型和原连接执行。原生请求移除普通回答的输出预算，交由上游管理；复述使用普通回答预算。源请求前缀包括开头的 system/developer 消息和工具声明；中途新增的 Lite 工具声明也按原顺序收集，确保原工具仍可解释。复述保留源 instructions、reasoning、缓存 key 等相关请求参数，固定禁止工具调用并移除结构化输出约束。

这是用户选择的质量策略：优先让原生压缩整理任务状态，再把该状态交接给其他模型。复述 prompt 是 Codex 压缩 prompt 的微调英文版本，明确说明此前已压缩，要求全面完整地复述现有任务状态，覆盖进度、决策、约束、待办和关键引用；不再要求再次精简，也不强制标准文字压缩的 `<analysis>/<summary>` 格式。`dual` 与 `lazy` 使用同一份 `HANDOFF_PROMPT`，原文集中在 [`src/prompts.ts`](../src/prompts.ts)。

复述仍是模型生成，并不是密文的可逆解码，可能遗漏或误述细节。实测的长度和事实覆盖用于选择提示词，不能保证任意历史都无损；输出 token 数也不是独立的质量证明。

### `lazy`：需要文字时才复述

```text
压缩时：AAAA + compaction_trigger → 保存 K 和复述配方
兼容目标续聊：U + K + BBBB → 直接使用 K
需要文字时：原来源接收源请求前缀 + U + K + handoff prompt → 缓存文字摘要
目标续聊：U + 文字摘要 + BBBB
```

延迟复述保留了正常续聊的 `U + K` 前缀，有机会复用 prompt cache；真实命中还受请求布局、服务路由和缓存有效期影响，不保证命中。确定的收益是始终使用兼容目标时，完全没有额外的文字复述请求。

前提是原模型与原端点仍可用，并且配置中保留相同来源身份的路由。bridge 优先选择配方记录的原别名，也接受连接、adapter 和实际部署相同的其他别名；实际鉴权与 options 读取当前配置。配方保存选定的源请求参数和前缀，不保存连接凭据或完整 `AAAA`。

成功的复述及其独立 usage 写入 `compaction_cache_dir`。缓存键包含原来源、实际复述请求及 prompt，不包含 `BBBB`；同一输入的后续请求与服务重启可以复用结果。文件以 `0600` 权限原子写入，新目录使用 `0700`。同一服务实例内，相同键的请求排队后读取已有结果，各自取消互不牵连；不同进程之间没有去重协调。

缓存保存的是可读任务摘要，应按会话数据管理。删除缓存后，下次需要时重新生成。缓存写入失败会返回错误，不继续发送目标请求；没有失效条目或失败响应的缓存。若目标请求随后失败，已经成功保存的复述仍可供客户端重试复用。

## 交付、错误与用量

`summary` 在摘要成功后交付；`dual` 在原生压缩和复述都成功后交付；`lazy` 的初始压缩在原生压缩成功后交付。原生结果须恰好包含一个非空压缩项，文字摘要须非空且完整结束；工具调用、拒绝或截断都不当作完整摘要。辅助请求的 incomplete 返回 `invalid_prompt`，原响应保留为诊断；流内失败保留原 error，但不交付辅助请求的部分 output 或 usage。

下游 HTTP 200 等最后一个必需上游请求被接受后才发送：`dual` 等第二步复述，延迟恢复等文字准备完毕后的目标请求。这样各阶段的 HTTP 失败仍能保留原状态码。若上游已经进入 SSE 后失败，则保留原流内错误路径。等待期间没有下游心跳，具体边界见 [Responses 流](responses-stream.md)。

bridge 不重试、不自动换端点或换压缩方式。原生压缩失败后不发起复述；复述失败不交付不完整的双表示检查点。客户端断开会取消当前正在执行的请求，已经发生的用量仍可能计费。`dual` 没有半成功结果缓存，客户端重试会重新执行这次压缩。

`dual` 的返回 usage 为原生压缩与复述的实际用量之和；`lazy` 的初始压缩只返回原生用量。延迟复述用量单独保存在缓存中，不加入目标回答的 usage，避免把辅助请求误算为目标的上下文大小。缓存复用不会产生新的导出用量。

## 保存格式与恢复

新的 `compaction` item 使用：

```text
cxbc3:<base64url(JSON)>
```

已完成的双表示检查点结构如下；`summary` 模式省略 `native`：

```json
{
  "summary": "可供任何模型读取的文字摘要",
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
  }
}
```

初始 `lazy` 检查点省略 `summary`，保存 `native` 和 `handoff`。后者包含 `prefix`、选定的请求 `parameters` 和 `responsesLite` 标记，足以在后续请求提供的 `U` 上生成文字。旧 `cxbc2:` 检查点继续可读。原生 data 保留完整上游 item；来源指纹计算见 [reasoning](reasoning.md)。

每次普通请求或再次压缩前，bridge 按当前目标选表示：

1. 有原生状态、开启 `native_replay`、来源允许、格式匹配：还原原生 item。
2. 其他情况已有文字摘要：将恢复前缀和文字摘要作为 user message。
3. 其他情况尚无文字摘要：向原来源延迟生成，再执行第二步。

这是发送前的表示选择；第一种请求被上游拒绝时直接返回错误，不自动再试文字表示。生成复述必须读取源自身的 `K`，不受源路由普通续聊的 `native_replay: false` 限制。

恢复不改写客户端保存的载荷。延迟复述只更新本次请求的副本，并通过本地缓存复用；切换模型再切回来，仍可使用原检查点。再次压缩后，新检查点取代旧检查点，不累积每个模型的检查点版本。外部原生检查点若没有 bridge 摘要或复述配方，不能保证跨目标恢复，因此明确报错。

恢复前缀逐字取自 Codex `rust-v0.162.1` 的 `codex-rs/prompts/templates/compact/summary_prefix.md`；handoff prompt 和保留历史算法的许可归属见 `NOTICE`。外层是编码而非加密：文字摘要、请求前缀和参数可读，原生密文保持原样。

近期保留消息可能与摘要包含相同信息，这是客户端历史策略的一部分。客户端压缩后可能按 `encrypted_content` 长度粗估 token，双表示或复述配方会让估算偏保守；下一次正常响应的 usage 提供实际用量。bridge 不伪造 usage 或修改客户端公式。

实现见 [`src/compaction.ts`](../src/compaction.ts)、[`src/compaction-history.ts`](../src/compaction-history.ts)、[`src/lazy-compaction.ts`](../src/lazy-compaction.ts)、[`src/carrier.ts`](../src/carrier.ts) 和 [`src/history.ts`](../src/history.ts)。
