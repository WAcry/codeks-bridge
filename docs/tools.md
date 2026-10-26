# 工具转换

客户端负责执行工具，bridge 只转换定义、调用和结果。Responses 后端保留原生定义；Messages 与 Chat 后端只向模型提供普通函数。

## Lite 工具声明

客户端默认把完整工具 schema 放在 `input[].additional_tools`。GPT 保留原始声明项。DeepSeek 及 Claude 的 `top_level` 模式在转换消息前提取声明，与顶层 `tools` 按历史顺序合并；Claude 默认 `inline` 模式保留增量定义生效的位置。声明不会变成普通 reminder。

增量声明只包含新增或变更的成员，按 namespace 与工具名覆盖旧定义，保留未变的其他成员和已分配的上游名字。工具移除的 developer 通知保留原位置，不从提示词文字推断删工具。codeks 将默认 `functions` namespace、空 namespace 和省略 namespace 视为同一身份，因此历史调用和显式工具选择均按此规则查找；返回调用保留声明中的原 namespace。

Claude 的 `adapters.claude-messages.tool_updates` 有两种明确模式：

| 模式 | 初始定义 | 中途新增与同名更新 |
| --- | --- | --- |
| `inline`（默认） | 顶层 `tools` 及会话开始前的声明组成原生顶部工具表 | 在原生中途 system 消息中发送 `tool_addition`，携带完整 `tool_definition`；此前定义不变 |
| `top_level` | 各批定义累积成同一顶部工具表 | 用最新定义覆盖同身份工具，适用于尚未支持完整 inline 的端点 |

完整 inline 定义能同时表达新工具和同名工具更新，避免为了更新定义重写早先的工具前缀；这是选择它作为默认方式的理由。bridge 在 user 或整批工具结果之后、下一条 assistant 之前发送中途 system 工具声明；工具交换内的声明先等待结果完整，无法形成合法边界则报错。普通 system/developer 提醒仍转为原位 user reminder，不因工具使用原生中途 system 而改变角色。

端点需要支持 `inline-tools-2026-09-15` beta；bridge 在请求包含中途更新时自动追加，保留已有 beta。不兼容时直接交付错误，不自动切换模式。`top_level` 可能改变缓存前缀和旧 thinking 的绑定；失配处理由独立的 [thinking 策略](backends-anthropic.md#失配策略与故障续接)决定。Code Mode Only 下多数工具位于 `exec` 内的目录，因此外层更新较少，但仍按协议完整处理。

## 工具发现与网页搜索

`supports_search_tool` 表示客户端的工具发现能力，与网页搜索不同。当前源目录的 GPT 条目显式设为 `true`，bridge 保留它。是否出现独立 `tool_search` 还取决于客户端工具模式和功能开关，不能只从目录字段推断。

当前目录采用 Code Mode Only：大多数工具通过 `exec` 中的函数调用，模型从 `ALL_TOOLS` 读取目录；外层不会因此增加一个独立搜索工具。网页搜索由客户端 `web_search` 配置和 provider 能力控制；启用[订阅搜索](web-search.md)后，`web.run` 的明文结果通过普通工具结果路径返回各模型。图片生成也有独立开关，均不通过 `supports_search_tool` 控制。

## 名字

普通函数保留原名。namespace 中的工具使用 `namespace__name`；namespace 已以 `_` 结尾时直接拼接名字。名字规范化为字母、数字、`_` 和 `-`。只有两个不同工具的规范化结果实际冲突时，才为后来的名字加 `_2`、`_3` 等后缀。返回调用通过该请求的映射恢复原 name/namespace。

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

普通函数显式给出的 `strict: true` 或 `strict: false` 原样保留：Messages 放在工具定义顶层，Chat 放在 `function` 内；省略时不添加默认值。Lite 同名更新替换完整定义，因此新定义省略 `strict` 时也不继承旧值；Claude inline 的早先版本保持不变。custom 工具的 JSON 外壳不因此自动启用 strict。

[Claude strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) 与 [DeepSeek strict mode](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta) 各有支持的 schema 范围；DeepSeek 官方文档还要求 beta 端点及所有函数都设为 `strict: true`。bridge 只转换调用方明确提供的字段，不切换端点、不改其他工具或删减 schema 来满足 strict。需要该能力时由用户配置支持的端点，上游不接受则保留错误。

codeks V2 多代理工具的 task/message 是明文，历史中的 `agent_message` 对 Messages/Chat 转成 user 消息，保留 author、recipient 和内容顺序。它不会成为模型 reasoning。不能解密的工具或 agent message 会明确报错。

## 结果与范围

文本结果按对应 API 的 tool result 形式传递。Messages 可以把图片放进 `tool_result`；Chat 的工具结果只放文本，图片在同组所有工具结果之后组成 user 消息，并标注来源 call ID，避免打断并行调用的结果序列。

Responses 允许主动工具通知和一次调用的多次输出，而 Messages/Chat 要求明确配对的调用与结果。转换只作用于当前非 GPT 请求副本：

- 没有 `call_id` 的命名 `function_call_output` 转成 user 通知，标出原 `namespace`、`name`，保留文字和图片。
- 同一 `call_id` 的第一条输出作为工具结果；后续输出转成带调用身份的 user 通知。这样 Code Mode 的 `notify()` 与最终输出都能到达模型，后续通知不会覆盖或拼接进先前已发送的结果。
- 完整工具批次中夹入的 user/developer 提醒与 agent 消息，在该批全部结果之后按原次序发送。这包括图片缩放提醒。Messages 的同一 user 消息里所有 `tool_result` 必须在文字之前，Chat 的工具结果也必须保持相邻。

归一化只整理完整的配对批次，不补造缺失调用或结果，不跨过后续 assistant 步骤修复不完整交换。GPT 仍收到原生输出项。规则集中在 `src/tool-history.ts`，会话文件中的历史保持不变。

从第一个输出工具调用开始，bridge 按原顺序缓存该调用及之后的输出，只有上游完整成功后才交给客户端。这样保留 thinking、文字与调用的交错顺序，后续回放不会改变签名前缀。截断、容量错误和断流不会释放部分调用；代价是工具之后的进度文字也要等响应成功后才显示。

Messages/Chat 不提供 hosted web search、image generation 等工具。默认定义中出现这些项时不放入上游工具表；显式 `tool_choice` 选择不支持的工具会报错。生成的客户端配置关闭 image generation，网页搜索则按可选的订阅搜索配置启用。当前不转换 hosted 搜索/图片生成的特殊历史项，遇到这类不支持的历史项会提示错误；独立 `web.run` 返回普通工具结果，不受此限制。
