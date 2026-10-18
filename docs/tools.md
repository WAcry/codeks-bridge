# 工具转换

客户端负责执行工具，bridge 只转换定义、调用和结果。Responses 后端保留原生定义；Messages 与 Chat 后端只向模型提供普通函数。

## Lite 工具声明

客户端默认把完整工具 schema 放在 `input[].additional_tools`。GPT 保留原始声明项；Messages/Chat 共用提取逻辑，在转换消息前消费声明，避免产生空消息或 reminder。顶层 `tools` 也可参与转换，随后按历史顺序合并各批声明。

增量声明只包含新增或变更的成员，按 namespace 与工具名覆盖旧定义，保留未变的其他成员和已分配的上游名字。工具移除的 developer 通知保留原位置，不从提示词文字推断删工具。codeks 将默认 `functions` namespace、空 namespace 和省略 namespace 视为同一身份，因此历史调用和显式工具选择均按此规则查找；返回调用保留声明中的原 namespace。

## 工具发现与网页搜索

`supports_search_tool` 表示客户端的工具发现能力，与网页搜索不同。当前源目录的 GPT 条目显式设为 `true`，bridge 保留它。是否出现独立 `tool_search` 还取决于客户端工具模式和功能开关，不能只从目录字段推断。

当前目录采用 Code Mode Only：大多数工具通过 `exec` 中的函数调用，模型从 `ALL_TOOLS` 读取目录；外层不会因此增加一个独立搜索工具。网页搜索对应 `web_search`，由客户端配置单独关闭；图片生成也有独立开关，均不通过 `supports_search_tool` 控制。

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

codeks V2 多代理工具的 task/message 是明文，历史中的 `agent_message` 对 Messages/Chat 转成 user 消息，保留 author、recipient 和内容顺序。它不会成为模型 reasoning。不能解密的工具或 agent message 会明确报错。

## 结果与范围

文本结果按对应 API 的 tool result 形式传递。Messages 可以把图片放进 `tool_result`；Chat 的工具结果只放文本，图片在同组所有工具结果之后组成 user 消息，并标注来源 call ID，避免打断并行调用的结果序列。

Responses 允许主动工具通知和一次调用的多次输出，而 Messages/Chat 要求明确配对的调用与结果。转换只作用于当前非 GPT 请求副本：

- 没有 `call_id` 的命名 `function_call_output` 转成 user 通知，标出原 `namespace`、`name`，保留文字和图片。
- 同一 `call_id` 的第一条输出作为工具结果；后续输出转成带调用身份的 user 通知。这样 Code Mode 的 `notify()` 与最终输出都能到达模型，后续通知不会覆盖或拼接进先前已发送的结果。
- 完整工具批次中夹入的 user/developer 提醒与 agent 消息，在该批全部结果之后按原次序发送。这包括图片缩放提醒。Messages 的同一 user 消息里所有 `tool_result` 必须在文字之前，Chat 的工具结果也必须保持相邻。

归一化只整理完整的配对批次，不补造缺失调用或结果，不跨过后续 assistant 步骤修复不完整交换。GPT 仍收到原生输出项。规则集中在 `src/tool-history.ts`，会话文件中的历史保持不变。

从第一个输出工具调用开始，bridge 按原顺序缓存该调用及之后的输出，只有上游完整成功后才交给客户端。这样保留 thinking、文字与调用的交错顺序，后续回放不会改变签名前缀。截断、容量错误和断流不会释放部分调用；代价是工具之后的进度文字也要等响应成功后才显示。

Messages/Chat 不提供 hosted web search、image generation 等工具。默认定义中出现这些项时不放入上游工具表；显式 `tool_choice` 选择不支持的工具会报错。生成的客户端配置关闭 web search 和 image generation。当前不转换历史搜索/图片生成结果，遇到这类不支持的历史项会提示错误。
