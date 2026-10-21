# 历史受控实验：2026 年 10 月

这是既有实验的归档补充，与 2026-10-20 的五路批次及后续四路复现实验分别记录。受控对比在 2026-10-17 完成，handoff 对比在 2026-10-19 完成，日期均为 `America/Los_Angeles`。本次整理未调用模型。

[标量结果](results/2026-10-controlled.json)保留每个 seed/repeat 的分数、token 用量、控制组和提示词 SHA256。它从归档的 `report.md`、`four-way-report.md`、`handoff-restatement-report.md` 及对应分数/指标文件提取，并核对汇总分母与均值。公开数据不含原始请求、响应标识、逐 item attribution、密文或认证信息；这些标量可复算表格，不能单独重放原来的模型调用。

## 实验合同与当前实验的区别

全部生成、转换和答题使用 OpenAI 订阅的 `gpt-6.1-sol`、Codex `0.162.1` base instructions、Responses Lite、`medium/all_turns` reasoning、`low` verbosity、`tool_choice: auto`、`store: false`，没有客户端输出 token 上限。这里测的是这些历史设置，不代表当前生产设置。

历史的最终测验始终只有共同 developer instructions、一个产物和隐藏 quiz：没有额外 U（保留的旧用户消息）、历史尾部、生成时的 reasoning、previous response 或 conversation 引用。压缩器和 handoff 转换器均看不到 quiz 与答案。

| 历史产物 | 生成方式 | 最终答题中的产物 |
|---|---|---|
| Built-in text | 原历史 + Codex 内置压缩 prompt | 完整最终文字 + Codex summary prefix |
| Standard text | 相同历史 + 详细标准文字 prompt | 完整最终文字 + 相同 prefix |
| Historical Claude Code text | 相同历史 + 当时用户提供的 Claude Code 式 prompt | 完整最终文字 + 相同 prefix |
| Native default | 原历史 + `compaction_trigger` | 仅原生 checkpoint |
| Native with built-in prompt | 原历史 + 同一内置 prompt + trigger；用于机制对照 | 仅原生 checkpoint |
| Historical handoff text | U + 新生成的原生 checkpoint + 当时 handoff prompt | 仅完整可见文字，无 summary prefix |

Base instructions、built-in、standard 和 summary prefix 与本目录对应快照逐字相同。旧 Claude Code prompt 的一行是 `[User feedback on the error if any]`，当前快照是 `[User feedback on the fix, if any]`。旧 handoff prompt 少了当前的空行及末尾 `Respond with text only. Do not call any tools.` 约束。因此旧 Claude Code 与 handoff 成绩不能标成当前 prompt 的实测结果，也不声称用户提供的文字对应某个 Claude Code 官方版本。

## 工作量与分母

锁定的 holdout 有四个独立 seed：3617031–3617034。每个 seed 使用两种密度，每种方法独立压缩两次，共 48 个 checkpoint、16 对 built-in text/native common-prompt 对照。重复是从同一原历史重新压缩，不是连续二次压缩。

每份历史有十个 epoch、五类记录：精确参数、有向关系、工具输出、更正后的最终值、任务 state/receipt/next-action 组合。每类 50 或 200 条，对应 250 或 1,000 条有效记录，其余为无关填充。哈希生成的载荷避免从序号猜答案。原历史的紧凑 JSON 都是 220,000 个本地 `o200k_base` tokens；这不保证服务端计费相同，完整历史答题平均约为 223,921/218,349 input tokens。

每个 checkpoint 测 150 个已知问题和 5 个缺失字段问题。答案按完整值精确匹配，不用 LLM judge；任务题必须同时答对三个组成部分。每个表格行的 1,200 个已知答案来自四个 seed × 两次压缩 × 150 题，独立 seed 数仍是四个。Full-history 控制组为 1,200/1,200，question-only 为 0/1,200；两者的 40 个未知问题均正确弃答。

## 原始 holdout 与文字 prompt 扩展

下表的 replay tokens 是相对共同 developer instructions + quiz-only 控制组的产物边际输入量，不是密文字节数。每行有 8 个 checkpoint；tokens 为均值。

| 有效记录 | 方法 | 已知答案 | 完美 checkpoint | Replay tokens |
|---:|---|---:|---:|---:|
| 250 | Built-in text | 1,200/1,200 | 8/8 | 5,183.38 |
| 250 | Native with built-in prompt | 1,200/1,200 | 8/8 | 4,992.75 |
| 250 | Native default | 1,200/1,200 | 8/8 | 5,425.63 |
| 1,000 | Built-in text | 15/1,200 | 0/8 | 1,069.50 |
| 1,000 | Native with built-in prompt | 255/1,200 | 1/8 | 4,632.75 |
| 1,000 | Native default | 1,200/1,200 | 8/8 | 17,723.38 |
| 1,000 | Standard text | 795/1,200 | 5/8 | 14,346.00 |
| 1,000 | Historical Claude Code text | 957/1,200 | 6/8 | 18,786.25 |

每行的未知问题均为 40/40。最后两行是同一批高密度 fixture 上的新压缩，共新增 16 个文字产物；与 native default、built-in text 组成的四路对比复用了 holdout 的另外 16 个产物，不能计作新的盲测或 32 个独立 seed。

低密度下三种方法均全对。高密度的 native common-prompt 有七次只答对 15/150、一次答对 150/150；其比文字多出的 20 个百分点伴随约 4.33 倍产物 tokens。短而缺失信息的输出不能当作压缩效率胜利。

四路对比事先选定第一个 seed、第一次压缩，对已有产物再问全部 1,000 条有效记录，未重新压缩：native default 为 1,000/1,000，built-in text 为 5/1,000，standard text 和 historical Claude Code text 都为 100/1,000。两个详细文字产物恰好是各自的失败样本，这只是该固定产物的稠密检查，不是八次压缩的平均质量。

## 重要反例：显式说明历史将被丢弃

另一次敏感性实验复用两个高密度 seed，每个 seed、每种方法各新压缩两次，每种方法 4 个、合计 8 个 checkpoint。双方都增加同一条说明：旧消息和工具结果会丢弃，没有外部来源可找回，所有有效关联仍在任务范围内；内置压缩 prompt 本身不变，也不展示 quiz。该实验在观察原始失败后设计，独立于 holdout 总分。

| 方法 | 已知答案 | 未知答案 | 平均 replay tokens |
|---|---:|---:|---:|
| Built-in text + discard notice | 600/600 | 20/20 | 18,128.75 |
| Native with same prompt + discard notice | 600/600 | 20/20 | 17,834.25 |

两者质量差异消失，native replay 少 1.62%。预先选定的第一个 seed/第一次产物再接受全量测验，两者均恢复 1,000/1,000 条记录、1,200/1,200 个随机标识关联和 200/200 个任务状态；文字为 18,216 tokens，native 为 17,826。它证明这些产物能保留这批数据，没有测出最大容量或加密表示的熵。

## 旧 handoff：转换有 U，最终答题没有 U

这次使用四个原 seed，各新生成两次原生 T，再分别用 U + 同一个 T + 旧 handoff prompt 转成 T′，共八对产物。U 按当时 Codex native V2 算法保留：60 条普通用户消息中保留 19 条，其中 18 条完整、一条中段截断，丢弃 41 条。预算按每段 UTF-8 字节数除以四向上取整，预算外的截断标记使估算总量为 64,007；它不是 64,007 个服务端计费 tokens。

| 最终唯一产物 | 已知答案 | 完美产物 | 未知答案 | 平均 replay tokens |
|---|---:|---:|---:|---:|
| T | 1,074/1,200 | 7/8 | 40/40 | 16,256.88 |
| T′ | 1,089/1,200 | 7/8 | 40/40 | 16,978.00 |

逐题配对为双方正确 1,074、仅 T 正确 0、仅 T′ 正确 15、双方错误 111。T′ 的转换有额外 U，所以不能把多答对的 15 题归因于对 T 的纯解码。一个弱样本从 T 的 24/150、3,455 replay tokens，变为 T′ 的 39/150、6,041 tokens；另外七对均为 150/150。

新 full-history 控制为 600/600，question-only 为 0/600。预先指定的第一对产物全量测验都为 1,000/1,000，未生成新产物。T′/T 的平均 replay 比为 1.0444；转换本身还平均使用 90,962.38 input、17,064.38 output tokens。七对均满分子集中的文字 replay 多 2.51%，这是有选择的描述性子集，不能替代全部八对结果。

这轮共完成 50 次评测调用，另一次转换在响应完成前中断。只对同一请求、同一 T 重试；没有为了分数重生成已成功的产物。中断响应的部分正文和 usage 不可用，用量表只涵盖完成的调用。

## 结论边界

原始高密度实验中 native default 的保留表现最好；低密度全对与显式 discard 后文字同样全对，限制了“native 总有质量优势”的结论。实验观察到隐藏保留策略、产物大小和结果共同变化，不能把效果单独归因于加密。

这里只有一个模型、provider 与历史 prompt 版本；任务是合成精确状态恢复，没有测真实代码续作、第三方模型读 handoff 的能力、等预算前沿或连续多轮压缩。四个 seed 是独立 holdout 单位，后续扩展复用这些 seed，全量测验也复用固定产物。另有一个 seed 的 12 次 calibration，未计入上述 holdout。

Generation output 已包含 reported reasoning；native 报告零 reasoning tokens 不证明内部没有推理。Replay 计算排除了新生成输出 item 的输入 framing，并独立核对 native item attribution；文字 summary prefix 则计入 replay。Cached input 已包含在 input 总量中，这些相互重叠的列不能全部相加，也不支持美元成本结论。
