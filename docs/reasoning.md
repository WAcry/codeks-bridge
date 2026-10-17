# Reasoning 与模型切换

每条 reasoning 都属于生成它的具体模型及上游端点。即使两个模型属于同一厂商，即使 reasoning 是明文，也不互相重放。显示别名不改变身份；更换上游配置 ID、实际模型、API 类型或上游端点会改变身份。身份用哈希表示，不把端点写进载荷。

桥接器把身份和内容放进 Responses reasoning item 的 `encrypted_content` 字段：

```text
cxbr1:<base64url(identity)>:<payload>
```

这是一层可读封装，不是加密。GPT 的 payload 是上游原有的密文；其他后端保存各自需要的 thinking、签名或明文 reasoning。不要把这些载荷当作普通日志输出。

codeks 会保留并再次发送 `encrypted_content`。相比只放在 reasoning 的 `content` 字段，这条路径能跨请求、会话恢复和进程重启保留模型需要的内容。

## 请求时选择，不修改历史

`src/history.ts` 的 `prepareHistory` 每次复制输入，再按当前路由选择 reasoning：

- 身份完全匹配：保留 carrier，由对应后端解包。
- 身份不同或没有可识别 carrier：本次请求忽略。
- 普通消息、工具调用、工具结果和图片继续保留。

Multi-agent V2 的明文 `agent_message` 在 Responses 后端保留原格式；Messages 和 Chat 后端将其转换为 user message，在内容开头标明 `author` 和 `recipient`，后面依次保留文本和图片。无法解密的 agent message 会明确报错，不会被当作空白消息丢弃。

例如 A → B → A：B 看不到 A 的 reasoning，切回 A 后仍可重放历史中 A 的 reasoning。保存的历史没有被删改。已经被压缩掉的原始 reasoning 则遵循压缩后的检查点，无法从旧 carrier 重新找回。

原生 Responses item ID 也可能引用与其关联的 reasoning。Responses 后端发送完整内容时移除顶层 `id`，保留工具配对使用的 `call_id`，并使用 `store: false`。这样切换模型或继承子代理历史时，普通 assistant 消息不会继续引用已被过滤的 reasoning。

## 压缩是另一种状态

reasoning 丢弃不会丢掉普通对话；压缩检查点却可能是早期对话的唯一副本。因此压缩使用独立的 `cxbc1:` carrier，其中始终有通用文本摘要，GPT 还包含原生压缩结果。GPT 请求优先复用原生压缩，跨模型和连接也一样；密文被明确拒绝时才改用已有摘要。这个降级不改变 reasoning 的身份隔离，也不修改存储的 carrier。详见 [compaction.md](compaction.md)。

从外部直接带入、没有通用摘要的原生压缩项会明确报错。桥接器不猜测密文归属，也不静默删除仅存的历史。只包含服务器引用的 `item_reference` 和 `previous_response_id` 同样不支持；请求必须携带完整历史内容。

## 验证

`test/history.test.ts` 覆盖 A → B → A、无来源 reasoning、原生/通用压缩选择、输入不可变性、图片与工具配对。`test/responses.test.ts` 覆盖载荷封装、解包和移除可能悬空的 item ID。
