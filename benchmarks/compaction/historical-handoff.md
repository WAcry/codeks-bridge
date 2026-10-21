# 2026-10 历史压缩与 handoff 对照

这份记录保存 2026-10-18（America/Los_Angeles）的单次实验：直接从完整历史生成文字摘要，以及先生成原生检查点、再用不同提示词导出文字。整理时没有重新调用模型。原始 usage、逐事实评审与开发样本摘要全文在 [results/2026-10-handoff.json](results/2026-10-handoff.json)，五版提示词及其 SHA-256 在 [prompts/manifest.json](prompts/manifest.json)。

`AAAA` 是压缩前完整历史，`U` 是客户端保留的用户消息，`K` 是原生加密检查点，`S` 是用于跨模型交接的文字摘要。直接路线读取 `AAAA + prompt`；lazy 路线读取 `U + K + prompt`。每份材料只生成一个 K，所有 lazy 候选使用同一个 U 和 K。检查点之后的新工作没有混入导出输入。

## 材料与请求

- **开发流程**：[fixtures/normal.json](fixtures/normal.json) 是完整的合成 TypeScript 上传 CLI 工作线程：103 items、12 条用户消息、42 对工具调用，以及提前冻结的 50 项事实，其中 32 项需要工具证据。项目、路径、域名、标识、代码和测试结果均为虚构叙事，未实际执行这些开发命令。数据包含旧方案被替换、提交授权被撤回，以及旧测试通过后又发现新问题的状态区别。公开 fixture 保留原始 thread、U、tools 和事实内容，移除了本机包装信息。
- **高密度**：seed `3617031`，每类 200 个记录，10 个阶段，共 1,000 个有效记录与 540 items。冻结测验有 150 道已知答案题与 5 道无答案题。类别为精确值、关系状态、工具结果、纠正后的值和后续工作状态。问题与答案只用于恢复测验，不进入摘要生成请求。

高密度 U 按当时 Codex V2 的文本用户消息保留规则生成：从新到旧使用 64,000 个近似 tokens，近似值为 `ceil(UTF-8 bytes / 4)`；边界消息保留首尾并插入截断标记。最终保留 19 条消息，本地 o200k 序列化计数为 70,663，不能把近似预算当成精确 tokenizer 上限。150 道已知题中，36 道的答案仍在 U，114 道需要检查点，全部 30 道工具结果题属于后者。本实验不覆盖图片、agent message、附加通知等保留规则。

模型为 GPT-6.1 Sol，使用 OpenAI ChatGPT 订阅的 Responses Lite HTTP SSE 接口；effort 为 `xhigh`，reasoning summary 为 `auto`，context 为 `all_turns`，`store: false`。无客户端输出上限，verbosity 使用服务端默认值。文字请求使用 `tool_choice: none`，原生请求使用 `auto`。每次恢复请求携带相应 U、检查点或文字摘要和测验，不携带生成过程的 reasoning，也没有 `previous_response_id`。

[基础指令快照](prompts/base-instructions.txt) 与仓库 [GPT-6.1 Sol 公共目录](../../catalog/gpt-6.1-sol.json) 的模板逐字相同，来源为公开 Codex `rust-v0.163.0`、commit `83086188ae0614bd882818ff1aa23f3194962012`。历史请求将该模板放在 developer message 中。工具声明独立放入 `additional_tools`。恢复文字摘要时使用 [summary-prefix.txt](prompts/summary-prefix.txt) 后加两个换行，再连接摘要全文。各文件按实际请求字符串冻结，末尾换行也是 hash 的一部分。

## 已测提示词与质量

| 路线 | 开发样本文字 tokens | 高密度文字 tokens | 开发样本完整 / 部分 / 遗漏 |
|---|---:|---:|---:|
| AAAA + builtin | 1,932 | 17,959 | 38 / 9 / 3 |
| AAAA + standard | 8,844 | 22,393 | 49 / 1 / 0 |
| U + K + builtin | 2,405 | 18,116 | 40 / 5 / 5 |
| U + K + standard | 7,328 | 20,525 | 47 / 3 / 0 |
| U + K + minimal | 4,085 | 19,032 | 46 / 4 / 0 |
| U + K + detailed | 6,390 | 21,832 | 48 / 2 / 0 |
| U + K + handoff-user-v1 | 5,738 | 19,240 | 47 / 3 / 0 |

原生 K 的服务端 compaction output attribution 分别为 3,938 和 18,959 tokens。它不是对密文做 tokenizer，也不代表可以检查加密摘要明文。表中“文字 tokens”只取服务端 message item attribution，排除 reasoning；长度不能单独作为质量分数。

`builtin` 是当时 Codex 的短压缩提示词；`standard` 是当时 bridge 的详细八节提示词；`minimal` 和 `detailed` 是第一轮新候选；`handoff-user-v1` 是用户随后给出的候选。最后一版沿用各自相同的 K 和 U，仅替换 `detailed` 请求最后一条 user prompt，其余 body 字段逐项一致。不能把今天运行代码中的提示词当成历史快照。

开发样本由独立代理按匿名摘要做**语义盲评**：第一轮两位评审各负责三份摘要，每份只有一位评审；用户版由另一位评审处理。这不是人工评审者一致性统计，也不是确定性自动评分。`correct` 要求所有子事实可恢复；`partial` 表示有实质内容但缺至少一个子条件；`missing` 表示缺失；`wrong` 表示与事实冲突。事实的原文索引、评审理由、摘要证据和合并 U 后的判断均保存在结果文件。行号对应同一条记录中未经改写的 `summary_text`；A–F、H 只是盲评代号。

所有开发摘要都保留了当前授权与待办状态。加入 U 后，剩余缺项也未补全，因为遗漏主要来自工具信息。50 项还包含较次要的历史测试数字，不能把它们与“不得提交”“修复尚未执行”等关键事实等权解释为续作质量。评审判断摘要可用于继续工作，但没有实际让新代理完成后续修复。

用户版有三项 partial：F18 的回执 etag 必须非空；F32 的 12 项 capability 测试覆盖范围；F34 的 `wire_bytes` 暂不进入公开事件。它没有遗漏整条 gold 事实，评审也未发现 gold 外的明确字段名、数值或命令错误，但“no unhandled error paths”强于原始证据。盲评者未见最终 prompt，因此对“用户现在要求 handoff”的疑虑经 prompt 核对后解除；结果文件保留原评审和这项补充核对。

`detailed` 曾将 `minimum_chunk_bytes` / `maximum_chunk_bytes` 写成 `min_chunk_bytes` / `max_chunk_bytes`；一次定向回问也未可靠恢复名字。随后用户版从同一份 K 正确写出两个名称，而 U 中没有这些名称。因此先前失败不能证明名称已从 K 消失，单次成功也不能归因于新 prompt 的某一句话。`minimal` 没写这两个字段名，不能据此认定它正确恢复了名称。

## 高密度恢复

| 输入 | 已知题 | 其中必须依赖检查点 | 无答案题正确返回 null |
|---|---:|---:|---:|
| 完整 AAAA | 150 / 150 | 114 / 114 | 5 / 5 |
| 仅 U | 36 / 150 | 0 / 114 | 5 / 5 |
| U + K | 150 / 150 | 114 / 114 | 5 / 5 |
| 两个 direct 文字候选 | 各 150 / 150 | 各 114 / 114 | 各 5 / 5 |
| 五个 lazy 文字候选 | 各 150 / 150 | 各 114 / 114 | 各 5 / 5 |

每题比较最终 assistant JSON 中的 canonical string；无答案题只计一次，commentary 不与 final JSON 拼接。所有候选都达到这份固定题集的上限，不能据此排名，也不能证明全部 1,000 条有效记录无损。正文中含有答案字符串的比例只适合诊断，不能代替让模型读取摘要后的独立恢复测验。

## Usage 与缓存解释

| 路线 | 开发 input / output 总数 | 高密度 input / output 总数 |
|---|---:|---:|
| AAAA + standard | 32,601 / 9,360 | 215,984 / 23,945 |
| U + K + standard | 10,420 / 7,844 | 94,883 / 21,489 |
| U + K + minimal | 9,295 / 4,491 | 93,758 / 20,066 |
| U + K + handoff-user-v1 | 9,337 / 6,254 | 93,800 / 19,883 |

这里 output 总数包含 reasoning。用户版开发样本为 516 reasoning + 5,738 文字 tokens，耗时 99.329 秒；高密度为 643 + 19,240，耗时 239.695 秒。两次 cached tokens 都为 0。单次耗时不是延迟保证。

JSON 记录保留暖身、生成和恢复各自的 usage。暖身与恢复测验是实验开销，不能算成产品每次导出的必需成本；native 生成和文字导出也要分开计数。cached tokens 已包含在 input 中，不能重复相加。订阅 usage 不是美元账单，不据此推算金额。

主矩阵只有开发样本的 direct builtin 命中 31,232 / 31,487 cached input，其余主生成请求为 0。该矩阵只设置 `prompt_cache_key`，没有完整复现 session/sticky headers；且把暖身的末尾消息替换成 trigger 或摘要 prompt，未保留完整已缓存边界。因此这些 0 不能代表正常客户端续接或原生压缩的缓存能力。缓存控制实验必须先证明普通请求已命中，再保持完整前缀进行追加；修改末尾消息和严格追加是不同条件。

## 实验结果与后续选择

第一轮记录推荐 `minimal`；随后用户候选得到上表结果，成为后续采用的基础。这是产品选择，不能把 46/50、47/50、48/50 的单次语义评分差异描述成统计优劣。用户版保留了原文的 `Be concise`，本次没有观察到它导致高密度摘要过短。

[handoff-user-v1.txt](prompts/handoff-user-v1.txt) 是实际测试过的逐字版本。后来生产提示词增加的 text-only 输出约束不在这次测试字符串中；历史成绩只归属于该快照。逐字核对表明，更早 `medium` + `verbosity: low` 实验的基础指令与本目录快照相同；工具声明、reasoning summary、路由和恢复包装等请求条件仍有差异，不能将两轮差异归因于单个变量。

按需导出的确定性机制收益是：一直使用兼容原生 K 的目标时，不需要生成 S；首次切到不兼容目标时才承担一次导出请求。摘要质量、缓存命中和耗时仍受模型、材料、参数与端点影响。这个固定小样本不构成通用模型排名或无损压缩承诺。
