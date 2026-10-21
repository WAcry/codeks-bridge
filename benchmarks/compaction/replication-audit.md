# 原生压缩历史结果复核

本次从原始请求和回答重新核对历史实验，再扩大样本。新的四路实测见 [2026-10-20 复现报告](results/2026-10-20-replication/README.md)。本文区分已证实的请求差异与尚未证实的原因。

## 旧的好结果确实存在，但不是所有批次都满分

旧 holdout 中 GPT-6.1 Sol / medium 的原生压缩共 16 次，重新评分均为 150/150；其中高密度 d200 为四个 seeds、每个两次，共八次。低密度 d50 的另外八次不混入本次高密度比较。

后续 handoff 实验又生成了八份新的原生检查点。其中七份为 150/150，一份只有 24/150；对应 handoff 为 39/150。这一份原生输出只有 3,453 tokens。不能拿前一批原生压缩的满分均值，与后一批 handoff 的均值作配对比较。

旧 Claude Code 式 prompt 也属于单独生成的批次，不是同一个检查点的另一次读取。[历史对照数据](results/2026-10-20-replication/historical-comparison.json)保留这几批的逐样本成绩和 token 计数，分别汇总。

## 相同的内容与实际变化

对 seed 3617031，高密度历史 H 的 540 个 items、基础指令 BASE、题目、标准答案及保留用户历史 U 均相同。H 包含 140 条消息、200 次工具调用与 200 个工具结果。两次所标 Codex 版本不同，并不表示模型基础指令不同。

| 内容 | SHA-256 |
|---|---|
| H，规范化 JSON | `db3670727524f2eff2b1cf43b7982f6d688984b83fb7d47eec4ded74c92ea4ba` |
| BASE，原始 UTF-8 | `e1bdd4f8f0df4b20f4a0ffc8a861ce819df45325d8cecdfb92e80379cf8d142e` |
| 题目文本，原始 UTF-8 | `09eac99689a98382ea9dbd9fc91669c3c3a868ffe9e08013fc14b420ecf10871` |
| 题目与 gold，规范化 JSON | `f33c7834edc09e1d908bd7f103cb9289002efcc7ad55a3756d97961e6dff9c31` |
| U，规范化 JSON | `ff012f9f590e8d67084ca16861f0a4e5731cb452beebaace8fa6ce3b6be93f88` |

这里的规范化 JSON 使用 UTF-8、非 ASCII 字符原样输出、对象 key 排序、逗号与冒号旁无空格。完整输入和题目已收录于新报告的 `fixtures/`。

原生生成请求存在三处逻辑差异：

| 参数 | 旧 holdout | 当前四路实验 |
|---|---|---|
| 工具声明 | fixture 有定义，但 runner 未发送 | 在开头发送 `additional_tools` |
| `reasoning.summary` | 不传 | `auto` |
| `text.verbosity` | `low` | 不传，响应回显 `medium` |

两边均为 `medium/all_turns`、`tool_choice: auto`，不设置输出 token 上限。从当前生成 body 中撤销上述三处变化后，整个 JSON 对象与旧请求相等；四个旧 seeds 都已核验。这个结论是请求对象相等，不包括 HTTP 字节序、请求头或服务端状态。

恢复测验还有其他变化：当前声明工具、固定 `tool_choice: none` 并使用新的随机 cache key；旧 reader 不声明工具、使用 `auto` 与 `verbosity: low`。当前 handoff prompt 多了 text-only 约束，文字产物回放时带固定 summary prefix，旧 handoff reader 则直接载入摘要。旧 holdout 没有 session/thread headers，后续旧 handoff 批次使用过 session/thread 与 turn state；本次不维护这些路由字段。因此不能把整批差异归因于一个参数。

Claude Code 式 prompt 也有一处已确认的示例占位措辞差异：旧版本为 `[User feedback on the error if any]`，当前快照为 `[User feedback on the fix, if any]`，除此之外全文相同。实际快照、hash 与该偏差均保留，不事后替换已测试文本。

## 用最少变量检查原因

本次锁定的诊断包括：

1. 四个旧高分原生检查点，各用当前 reader 重读一次。
2. 上一轮较弱的原生检查点，用历史 reader 重读一次。
3. 四个旧 seeds，各重新生成两份原生检查点：旧生成 body 原样复现，以及只增加 `additional_tools` 的版本。两份都用同一个当前闭卷 reader，按 seed 奇偶交替条件顺序。

前两项区分“换了 reader 就变差”与产物有关的差异，不读取密文内容。第三项隔离工具声明，不能同时回答 summary、verbosity 或其交互作用的问题。全部诊断为 medium，不以 xhigh 的结果代替。

工具声明假设来自上一轮可见产物：其 handoff 明确说早期工具结果未保留，并建议重新查询；epochs 0–6 的 140 个探测值都未出现在明文，最后三个阶段的 60 个值全部存在。原生与 handoff 的 21 道失分恰好对应早期工具值，其他类别均正确；U 也没有这些工具结果。这个模式值得测，但不是“声明工具必然丢信息”的证明。原生内容不可见，不能由 handoff 的说法推断压缩器内部机制。

新增 seeds 只改变随机载荷、ID、任务状态与非权威填充；权威记录结构、十个阶段和题目覆盖方式不变。本次既有旧 seed 的短摘要，也有新 seed 的短摘要，不形成稳定的新旧分界。没有证据将它归因于缓存或模型服务内部变化。

## 旧 xhigh 实验不能直接作当前排名

旧高密度 xhigh 实验的最终测验使用 U + K，其中 U 单独能答 36/150；U + K 为 150/150，也答对了 U 中不存在的其余 114 题。这是有价值的保留证据，但并非当前只测 K 的同一设计。

旧开发任务 xhigh 实验使用相同的 103 项 H，却没有当前完整的 89 道已知题。它只在 U + K 上做少量细节核查，并对摘要做较粗的事实评估。其中某些精确字段本来就未恢复；不能据此声称旧开发材料的 K-only 恢复曾经满分。

同样需要纠正 token 比较：旧表格主要列恢复时的 input tokens，上一轮新表格列产物的 output tokens。两者分别有价值，但不能混在同一列。新报告并列展示这两种计数，并将生成 reasoning 排除在产物长度之外。

这些实验使用模型别名，没有固定服务端模型快照。新的重复样本能说明本批是否重现旧现象，不能证明日期、工具或某个请求字段是所有变化的原因。
