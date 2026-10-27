# 工具转换

客户端负责执行工具，bridge 只转换定义、调用和结果。Responses 后端保留原生定义；Messages 与 Chat 后端只向模型提供普通函数。

## Lite 工具声明

客户端默认把完整工具 schema 放在 `input[].additional_tools`。GPT 保留原始声明项。Claude 与 DeepSeek 在转换消息前提取声明，与顶层 `tools` 按历史顺序合并，最终只向上游发送一张顶层工具表。声明不会变成普通 reminder，客户端保存的历史不变。

增量声明只包含新增或变更的成员，按 namespace 与工具名覆盖旧定义，保留未变的其他成员和已分配的上游名字。每个工具身份最终只有一份定义；反复切换模型产生的同名版本也只保留最后一份。工具移除的 developer 通知保留原位置，不从提示词文字推断删工具。codeks 将默认 `functions` namespace、空 namespace 和省略 namespace 视为同一身份，因此历史调用和显式工具选择均按此规则查找；返回调用保留声明中的原 namespace。

选择合并顶层定义，是为了让会话中的同名更新具有确定的替换语义，而不是同时声明多个不同版本。Code Mode Only 下多数工具位于 `exec` 内的目录，外层工具变化较少；但模型切换仍可能改变 `exec` 的描述，例如 `supports_image_detail_original` 决定嵌套 `view_image` 是否提供 `detail` 参数。此时同名工具必须使用最新定义。

代价是定义变化时，顶层工具前缀也随之变化，可能导致缓存未命中及 Claude 旧 thinking 绑定失配。默认 `drop_block` 请服务端处理失配，可能丢弃失配块及依赖其前缀的后续 thinking，并不保证推理上下文无损。具体行为与诊断见 [thinking 策略](backends-anthropic.md#失配策略与故障续接)。普通 system/developer 提醒仍在原位置转换成 user reminder。

## 工具发现与网页搜索

`supports_search_tool` 表示客户端的工具发现能力，与网页搜索不同。当前源目录的 GPT 条目显式设为 `true`，bridge 保留它。是否出现独立 `tool_search` 还取决于客户端工具模式和功能开关，不能只从目录字段推断。

当前目录采用 Code Mode Only：大多数工具通过 `exec` 中的函数调用，模型从 `ALL_TOOLS` 读取目录；外层不会因此增加一个独立搜索工具。网页搜索由客户端 `web_search` 配置和 provider 能力控制；启用[订阅搜索](web-search.md)后，`web.run` 的明文结果通过普通工具结果路径返回各模型。[图片生成与编辑](image-generation.md)使用客户端 `image_gen.imagegen` 工具及独立图片接口，同样不通过 `supports_search_tool` 控制。

## 名字

普通函数保留原名。namespace 中的工具使用 `namespace__name`；namespace 已以 `_` 结尾时直接拼接名字。名字规范化为字母、数字、`_` 和 `-`。只有两个不同工具的规范化结果实际冲突时，才为后来的名字加 `_2`、`_3` 等后缀。返回调用通过该请求的映射恢复原 name/namespace。

Messages/Chat 返回的调用还接受完整的 `namespace.name` 和唯一的原始短名。例如 `functions__exec`、`functions.exec`、`exec` 都可定位同一个工具；`agents`、`clock` 及其他 namespace 使用相同规则。省略 namespace 的默认工具也接受 `functions.name` 和 `functions__name`。精确声明名优先；其他别名只有唯一对应工具时才成功，不猜后缀或拼写。exec 内的 JavaScript 原样传递，其中 `tools.*` 的解析仍由客户端负责。

这一选择来自实际模型会省略声明名前缀，而提示词仍用 `functions.exec` 等原始身份。保留声明、增加确定性别名，可以修复调用而不重写工具表和 Claude 的签名前缀。GPT 返回的调用保留原生工具协议，不做这种别名匹配；切换到 GPT 时，来自其他 adapter 的历史载体仍需转换为 Responses 可接受的表示。

歧义或未知调用通过普通工具错误反馈，提示可用的完整声明名。例如两个 namespace 都有 `read` 时，提示 `files__read`、`database__read`，让模型下一次明确选择。bridge 不擅自执行其中一个，也不把这类错误变成网络重试。它将失败调用交给客户端不存在的保留身份 `codeks_bridge_tool_error.invalid_call`，客户端记录普通未知工具结果；后续发包恢复原始调用并将该结果替换为保存的候选诊断。真实缺失 id、损坏 JSON 或 custom 输入仍是协议错误。

未知名称最多推荐 5 个工具：完整名称（将点号统一为 `__`）与去掉 namespace 的短名分别计算编辑距离，取较小值排序；距离相同时优先相同 namespace，其余同分项保留声明顺序。始终显示可直接调用的完整声明名，截取时标出展示数量与工具总数。用户选择这一限制，是为了让拼写接近的候选更显眼，同时减少错误反馈长度；它只改变提示，不进行近似匹配执行。歧义名称则完整列出所有真正的同名候选，不设数量上限、不混入其他近似工具；无需新增配置。

只有接受了别名或需要反馈的调用才将原始上游 id、名字和可选诊断编码为 `cxbt1_` call ID。客户端照常保存该 id 并配对结果，bridge 在 Messages/Chat 回放时恢复原始 id 和名字，避免把模型生成的 `exec` 悄悄改成 `functions__exec` 而改变签名前缀；诊断也随历史固定，不随以后工具表变化。载体不含参数、凭据或完整会话，不需要额外状态文件。检查器可查看原始上游调用、客户端失败身份与下一次上游收到的诊断。

Responses 的 `call_id` 最长 64 字符，`cxbt1_` 载体可能超过这个限制。GPT 出站时，对超过 64 字符的工具 ID（包括载体和其他上游的原始 ID），使用完整客户端 ID 的 SHA-256 生成固定 48 字符的 `call_`＋base64url 摘要；function/custom 调用及对应结果使用同一映射。64 字符以内的 ID（包括短载体）保留原值，减少对已被 GPT 接受的历史前缀的改动；无 ID 的主动通知不生成 ID。映射不依赖调用位置、模型别名或内存状态，因此恢复会话、重试及后续 turn 都保持一致。

不直接用载体内的原始 ID，是因为它本身可能超长，两个不同载体也可能包含同一个原始 ID；不直接截断或去除空白，以免合并不同调用。GPT 历史保留客户端已确定的工具类型、name、namespace、参数及正常结果，失败结果使用载体保存的原诊断。转换仅作用于请求副本：旧会话无需迁移，切回 Messages/Chat 仍能恢复原始调用。普通请求、原生压缩、文字压缩和 handoff 共用这条出站路径。

这种无状态的目标协议边界处理也见于 [Magpie 的 `BoundCallID`](https://github.com/yetone/magpie/blob/11c3fbb197f17403183bdae424327aa0de7f0558/internal/provider/codex_request.go#L368)。这里额外保留 bridge 的载体诊断和规范化工具身份。回归覆盖真实 codeks 的 DeepSeek／Claude → GPT → 原模型切换；另用合成历史实测 GPT‑6‑Luna / medium，280、73、90 字符 ID 转换后均为 48 字符，未声明的失败工具身份及诊断可正常回放。该实测验证协议接受性，不评估模型质量。

共享转换层将 Messages/Chat 工具名统一限制为 64 字符，沿用 Chat 端点的较小限制，不为不同后端维护两套命名规则；这不表示所有端点的原生上限都是 64。超长名称保留 55 字符可读前缀，加 `_` 与 8 位摘要，以区别同前缀工具。正常长度不加 hash。历史名称根据当前工具集映射，因此同一次工具调用的名称不依赖模型临时起名。

## 自由文本与语法

Responses custom tool 转成只有一个必填 `input: string` 字段的函数。模型返回 JSON 后，bridge 还原为 `custom_tool_call`，客户端拿到原始字符串。

- Lark 定义原样写进 description 的代码块。
- Regex 定义原样写进 description，要求 `input` 匹配。
- 不给特定编辑或执行工具追加私有提示词，不修改其原描述。

Messages/Chat 没有 Responses 的服务端语法约束能力，因此这是模型遵循的说明，不是同等的 constrained decoding。函数参数的 JSON 外壳仍会检查；错误、不完整的工具参数不会交给客户端执行。

## 明文与多代理

Messages 对不符合端点格式的 call ID 采用确定性映射，并添加短摘要以避免两个不同 ID 规范化后碰撞；调用和结果使用同一映射。正常 ID 保持不变。

普通 JSON Schema 清理 Responses 专用的布尔 `encrypted` 关键字，不删除名为 `encrypted` 的普通属性或数据。客户端使用明文多代理工具；返回的函数项显式携带 `encrypted_function_args: []`。

根 schema 的 `$ref`、`$defs`、`allOf`、`anyOf`、`oneOf` 及其他约束均保留；缺少根 `type` 时补为 `object`，已有类型不覆盖，由上游判断是否支持。codeks 可以发送没有根 `type` 的引用或组合 schema，不能因此把参数清空。未提供参数 schema 时使用空对象定义；显式提供非对象 schema 值则报错，不在 bridge 内解析引用或删减约束。

普通函数显式给出的 `strict: true` 或 `strict: false` 原样保留：Messages 放在工具定义顶层，Chat 放在 `function` 内；省略时不添加默认值。Lite 同名更新替换完整定义，因此新定义省略 `strict` 时也不继承旧值。custom 工具的 JSON 外壳不因此自动启用 strict。

[Claude strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) 与 [DeepSeek strict mode](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta) 各有支持的 schema 范围；DeepSeek 官方文档还要求 beta 端点及所有函数都设为 `strict: true`。bridge 只转换调用方明确提供的字段，不切换端点、不改其他工具或删减 schema 来满足 strict。需要该能力时由用户配置支持的端点，上游不接受则保留错误。

codeks V2 多代理工具的 task/message 是明文，历史中的 `agent_message` 对 Messages/Chat 转成 user 消息，保留 author、recipient 和内容顺序。它不会成为模型 reasoning。不能解密的工具或 agent message 会明确报错。

## 结果与范围

文本结果按对应 API 的 tool result 形式传递。Messages 可以把图片放进 `tool_result`；Chat 的工具结果只放文本，图片在同组所有工具结果之后组成 user 消息，并标注来源 call ID，避免打断并行调用的结果序列。

Responses 允许主动工具通知和一次调用的多次输出，而 Messages/Chat 要求明确配对的调用与结果。转换只作用于当前非 GPT 请求副本：

- 没有 `call_id` 的命名 `function_call_output` 转成 user 通知，标出原 `namespace`、`name`，保留文字和图片。
- 同一 `call_id` 的第一条输出作为工具结果；后续输出转成带调用身份的 user 通知。这样 Code Mode 的 `notify()` 与最终输出都能到达模型，后续通知不会覆盖或拼接进先前已发送的结果。
- 完整工具批次中夹入的 user/developer 提醒与 agent 消息，在该批全部结果之后按原次序发送。这包括图片缩放提醒。Messages 的同一 user 消息里所有 `tool_result` 必须在文字之前，Chat 的工具结果也必须保持相邻。

部分结果返回后，Responses 还可能开始下一个 assistant 步骤，再收到前一批的迟到结果。Messages/Chat 无法原样表达这种重叠交换；bridge 按 call ID 将已经存在的真实结果移回原批次。例如 `A,B → 结果B → C → 结果C → 结果A` 转为 `A,B → 结果B,结果A → C → 结果C`，保留后续 assistant 与 reasoning 回合，不把它们合并。只修完整可配对的局部历史，不跨 user 消息、压缩检查点或重复调用身份；真正缺结果时保持原状，让上游报告错误，不编造工具结果。

这是协议表示的取舍：结果 A 在转换后提前可见，已有 Claude thinking 若绑定了原先不同的前缀，仍可能由其失配策略处理。不能声称这种历史修复无损；已经合法的顺序保持不变。GPT 仍收到原生输出项。规则集中在 `src/tool-history.ts`，会话文件中的历史保持不变。

从第一个输出工具调用开始，bridge 按原顺序缓存该调用及之后的输出，只有上游完整成功后才交给客户端。这样保留 thinking、文字与调用的交错顺序，后续回放不会改变签名前缀。截断、容量错误和断流不会释放部分调用；代价是工具之后的进度文字也要等响应成功后才显示。

Messages/Chat 不提供 hosted web search、image generation 等工具。默认定义中出现这些项时不放入上游工具表；显式 `tool_choice` 选择不支持的工具会报错。生成的客户端配置关闭 image generation，网页搜索则按可选的订阅搜索配置启用。当前不转换 hosted 搜索/图片生成的特殊历史项，遇到这类不支持的历史项会提示错误；独立 `web.run` 返回普通工具结果，不受此限制。
