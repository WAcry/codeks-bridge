# 工具转换

客户端负责执行工具，bridge 只转换定义、调用和结果。Responses 后端保留原生定义；Messages 与 Chat 后端只向模型提供普通函数。

## 名字

普通函数保留原名。namespace 中的工具使用 `namespace__name`；namespace 已以 `_` 结尾时直接拼接名字。名字规范化为字母、数字、`_` 和 `-`。只有两个不同工具的规范化结果实际冲突时，才为后来的名字加 `_2`、`_3` 等后缀。返回调用通过该请求的映射恢复原 name/namespace。

Messages/Chat 工具名统一上限 64 字符。超长名称保留 55 字符可读前缀，加 `_` 与 8 位摘要；这是为了遵守端点长度限制，同时区别同前缀工具。正常长度不加 hash。历史名称根据当前工具集映射，因此同一次工具调用的名称不依赖模型临时起名。

## 自由文本与语法

Responses custom tool 转成只有一个必填 `input: string` 字段的函数。模型返回 JSON 后，bridge 还原为 `custom_tool_call`，客户端拿到原始字符串。

- Lark 定义原样写进 description 的代码块。
- Regex 定义原样写进 description，要求 `input` 匹配。
- 不给特定编辑或执行工具追加私有提示词，不修改其原描述。

Messages/Chat 没有 Responses 的服务端语法约束能力，因此这是模型遵循的说明，不是同等的 constrained decoding。函数参数的 JSON 外壳仍会检查；错误、不完整的工具参数不会交给客户端执行。

## 明文与多代理

Messages 对不符合端点格式的 call ID 采用确定性映射，并添加短摘要以避免两个不同 ID 规范化后碰撞；调用和结果使用同一映射。正常 ID 保持不变。

普通 JSON Schema 清理 Responses 专用的布尔 `encrypted` 关键字，不删除名为 `encrypted` 的普通属性或数据。客户端使用明文多代理工具；返回的函数项显式携带 `encrypted_function_args: []`。

Codeks V2 多代理工具的 task/message 是明文，历史中的 `agent_message` 对 Messages/Chat 转成 user 消息，保留 author、recipient 和内容顺序。它不会成为模型 reasoning。不能解密的工具或 agent message 会明确报错。

## 结果与范围

文本结果按对应 API 的 tool result 形式传递。Messages 可以把图片放进 `tool_result`；Chat 的工具结果只放文本，图片在同组所有工具结果之后组成 user 消息，并标注来源 call ID，避免打断平行调用的结果序列。

输出调用先缓存，只有上游完整成功后才发送 `output_item.done`。截断、容量错误和断流不会释放部分调用。

Messages/Chat 不提供 hosted web search、image generation 等工具。默认定义中出现这些项时不向上游广告；显式 `tool_choice` 选择不支持的工具会报错。生成的客户端配置关闭 web search。本轮不转换历史搜索/图片生成结果，遇到这类不支持的历史项会提示错误。
